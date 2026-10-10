// FieldLink BLE 링크 프로토콜 v0.2 (게이트웨이 구현 기준) - 수준 C 센서(Central)
// 보드: NU40 (nRF52, Adafruit Bluefruit 스택) + NU-IMU(LSM6DS3TR-C, I2C 0x6A)
//
// 동작: 게이트웨이 스캔(서비스 UUID + 이름 "FL-"/"FieldLink-") -> 접속 -> HELLO/HELLO_ACK
//       -> LINK_INFO -> (게이트웨이가 시키는) PROBE / CONFIG / START / STOP
//       -> DATA(가속도 3채널, i16) 스트리밍 + HEARTBEAT
//
// 샘플 형식: sample_format = 2 (i16), 채널 0/1/2 = X/Y/Z, 원시 LSB 값.
//            +-2g 기준 1 LSB = 0.061 mg (g = raw * 0.000061).
// 모든 다중 바이트 필드는 little-endian.
//
// v0.3 변경 (게이트웨이 측 검토 반영)
//  1. HELLO 버퍼 넘침 수정 (40 B 버퍼에 47 B를 쓰고 있었음)
//  2. 잘못된 장치 회피: 이름 접두어 확인 + 확인 실패 주소 60 s 회피 (명세 9절)
//  3. 스캔에서 거른 광고 뒤 Scanner.resume() 호출 (안 하면 스캔이 멈춤)
//  4. IMU를 하드웨어 FIFO로 읽음: BLE 쓰기가 막혀도 샘플이 소리 없이 빠지지 않음.
//     FIFO가 넘치면 잃은 만큼 sample_seq를 건너뛰어 게이트웨이가 손실을 알 수 있게 함
//  5. configCentralBandwidth(BANDWIDTH_MAX): 없으면 MTU 247 요청이 효과 없음
//  6. LINK_INFO에 스택의 실측값 보고, HEARTBEAT에 FIFO 적재량을 큐 사용량으로 보고
//  7. PROBE_RESULT 해석 오프셋 수정, PROBE 대기 루프에 yield()
//  8. 접속 간격을 1.25 ms 단위로 지정: setConnIntervalMS()는 정수 ms라 7.5가 7 -> 6.25 ms로
//     바뀌어 sd_ble_gap_connect()가 INVALID_PARAM으로 실패했음. connect() 실패 시 스캔 재개
//  9. 스캔 콜백에서 Serial 출력 제거 (진단 정보는 loop()에서 출력)
// 10. ATT MTU를 247로 제한해 계산: Bluefruit getMtu()는 상대가 512를 제시하면 협상값(247)이
//     아닌 512를 돌려줌 -> 244 B를 넘는 write가 실패할 수 있었음
// 11. 끊기 요청 후 끊김 콜백까지 ST_CLOSING에서 대기 (타임아웃 처리가 반복되던 문제)
// 12. 최대 ODR을 104 Hz로 제한 (IMU_MAX_HZ). 이 보드에서 FIFO를 208 Hz 이상으로 켜면
//     보드 전원이 꺼짐 (BLE 없이 IMU만으로 재현, 리셋 버튼도 안 듣고 수 분 뒤 스스로 복구)
//     -> 하드웨어 확인 필요. 원인이 해결되면 IMU_MAX_HZ를 올리면 됨

#include <Arduino.h>
#include <Wire.h>
#include <bluefruit.h>

// ---------------- 설정 ----------------
#define REQUIRE_PAIRING 0       // v0.2: 게이트웨이는 보안 끔 -> 페어링 요청 금지 (0 유지)
#define FW_VERSION      ((0 << 8) | 3)
#define MODEL_ID        0x0001
#define DEVICE_NAME     "NU40_ACCEL"
#define MAX_FRAMES      35      // 34 + 35*3*2 = 244 B = MTU247-3 에 딱 맞음
#define NUM_CH          3
#define AVOID_MS        60000   // 확인 실패한 주소 회피 시간 (명세 9절)
#define BUSY_HOLD_MS    30000   // HELLO_ACK status 3(사용 중) 재시도 간격
#define AVOID_SLOTS     4
#define LOCAL_ATT_MTU   247     // configCentralBandwidth(BANDWIDTH_MAX)가 설정하는 ATT MTU
#define DEBUG_SCAN      1       // 스캔 중 5 s마다 상태 한 줄 출력 (접속 문제 진단용)

// ---------------- LSM6DS3TR-C ----------------
const uint8_t IMU_ADDR          = 0x6A;
const uint8_t REG_FIFO_CTRL3    = 0x08;
const uint8_t REG_FIFO_CTRL5    = 0x0A;
const uint8_t REG_WHOAMI        = 0x0F;
const uint8_t REG_CTRL1_XL      = 0x10;
const uint8_t REG_CTRL3_C       = 0x12;
const uint8_t REG_FIFO_STATUS1  = 0x3A;   // +0x3B: DIFF_FIFO[10:8], OVER_RUN(bit6)
const uint8_t REG_FIFO_STATUS3  = 0x3C;   // +0x3D: FIFO_PATTERN (다음에 읽을 축)
const uint8_t REG_FIFO_DATA_OUT = 0x3E;

const uint16_t FIFO_CAP_FRAMES = 2048 / 3;  // FIFO 4 KB = 2048 워드, 프레임당 3워드
const uint8_t  BURST_FRAMES    = 5;         // I2C 한 번에 30 B (Wire 버퍼 32 B 이내)

struct OdrEntry { uint32_t hz; uint8_t code; };   // code = ODR 니블 (CTRL1_XL / FIFO ODR 공용)
const OdrEntry ODR_TABLE[] = {
  {13, 1}, {26, 2}, {52, 3}, {104, 4},
  {208, 5}, {416, 6}, {833, 7}, {1660, 8}
};
const int ODR_COUNT = sizeof(ODR_TABLE) / sizeof(ODR_TABLE[0]);
const uint32_t IMU_MAX_HZ = 104;   // 변경 내역 12 참고

// ---------------- 프로토콜 상수 ----------------
enum : uint8_t {
  T_HELLO = 0x01, T_HELLO_ACK = 0x02, T_LINK_INFO = 0x03,
  T_PROBE_START = 0x10, T_PROBE_DATA = 0x11, T_PROBE_END = 0x12, T_PROBE_RESULT = 0x13,
  T_CONFIG = 0x20, T_CONFIG_ACK = 0x21, T_START = 0x22, T_STOP = 0x23, T_RESULT = 0x24,
  T_DATA = 0x30, T_ACK = 0x31, T_HEARTBEAT = 0x40, T_ERROR = 0x7F
};
const uint8_t FL_FLAG_CRC = 0x01;
const uint32_t CAP_CRC = 1 << 0, CAP_PROBE = 1 << 1, CAP_CONFIG = 1 << 2, CAP_TS = 1 << 3;
const uint32_t MY_CAPS = CAP_CRC | CAP_PROBE | CAP_CONFIG;   // 0x07 (타임스탬프 미제공 -> DATA의 timestamp_us = 0)

// ---------------- 상태 ----------------
BLEClientUart clientUart;

enum State { ST_IDLE, ST_SCAN, ST_SETUP, ST_WAIT_ACK, ST_READY, ST_CLOSING };
State state = ST_IDLE;

uint16_t connHandle = BLE_CONN_HANDLE_INVALID;
uint32_t stateSince = 0;
uint32_t nextScanAt = 0;
uint32_t backoffIdx = 0;
bool     pairedOk = false;

// 접속 중인 상대 주소와 회피 목록
uint8_t  peerAddr[6];
bool     havePeer = false;
struct Avoid { uint8_t addr[6]; uint32_t until; bool used; };
Avoid    avoidList[AVOID_SLOTS];

uint16_t txSeq = 0;
uint8_t  integrity = 1;           // HELLO_ACK에서 받음
uint16_t heartbeatMs = 1000;
uint32_t lastHeartbeat = 0;

uint32_t scanRateHz = 104;
uint8_t  odrCode = 4;
uint16_t maxPacketBytes = 244;    // HELLO_ACK에서 갱신 (MTU-3)
uint8_t  channelMask = 0x07;
uint8_t  framesPerPacket = 10;
bool     streaming = false;

uint32_t sampleSeq = 0;
uint8_t  frameBuf[MAX_FRAMES][NUM_CH * 2];
uint8_t  frameFill = 0;
uint32_t droppedFrames = 0;

// FIFO 상태
bool     fifoAligned = false;     // 다음 워드가 X축인지 확인했는가
bool     burstChecked = false;    // FIFO 연속 읽기(주소 롤백) 동작을 확인했는가
bool     burstOk = true;          // false면 워드 단위로 읽음
uint16_t fifoLevel = 0;           // 마지막으로 본 FIFO 적재 프레임 수 (HEARTBEAT 보고용)
uint32_t lastDrainMs = 0;

// 수신 버퍼 (콜백 -> loop)
volatile uint16_t ringHead = 0, ringTail = 0;
uint8_t ring[2048];
uint8_t rxBuf[1200];
uint16_t rxLen = 0;

// ---------------- 유틸 ----------------
uint32_t crc32(const uint8_t* d, size_t n) {
  uint32_t c = 0xFFFFFFFF;
  while (n--) {
    c ^= *d++;
    for (int i = 0; i < 8; i++) c = (c >> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}

void put16(uint8_t* p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
void put32(uint8_t* p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = v >> (8 * i); }
void put64(uint8_t* p, uint64_t v) { for (int i = 0; i < 8; i++) p[i] = v >> (8 * i); }
uint16_t get16(const uint8_t* p) { return p[0] | (p[1] << 8); }
uint32_t get32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

// 협상된 ATT MTU. Bluefruit getMtu()는 MTU 교환 응답에서 상대 값을 그대로 저장하므로
// 우리 쪽 최대값(LOCAL_ATT_MTU)으로 제한한다.
uint16_t attMtu(BLEConnection* conn) {
  if (!conn) return 23;
  return min<uint16_t>(conn->getMtu(), LOCAL_ATT_MTU);
}

// ---------------- 상대 주소 회피 ----------------
bool isAvoided(const uint8_t* addr) {
  uint32_t now = millis();
  for (int i = 0; i < AVOID_SLOTS; i++) {
    if (avoidList[i].used && (int32_t)(avoidList[i].until - now) > 0 &&
        memcmp(avoidList[i].addr, addr, 6) == 0) return true;
  }
  return false;
}

void avoidPeer(uint32_t ms) {
  if (!havePeer) return;
  uint32_t now = millis();
  int slot = 0;
  for (int i = 0; i < AVOID_SLOTS; i++) {
    if (avoidList[i].used && memcmp(avoidList[i].addr, peerAddr, 6) == 0) { slot = i; break; }
    if (!avoidList[i].used || (int32_t)(avoidList[i].until - now) <= 0) slot = i;
  }
  memcpy(avoidList[slot].addr, peerAddr, 6);
  avoidList[slot].until = now + ms;
  avoidList[slot].used = true;
  Serial.printf("avoiding %02X:%02X:%02X:%02X:%02X:%02X for %lu s\n",
                peerAddr[5], peerAddr[4], peerAddr[3], peerAddr[2], peerAddr[1], peerAddr[0],
                (unsigned long)(ms / 1000));
}

// 광고 이름이 FieldLink 게이트웨이인지: 주 패킷의 짧은 이름 "FL-" 또는 전체 이름 "FieldLink-"
// name_out(33 B)에는 찾은 이름을 남김 (진단 로그용)
bool isFieldLinkName(ble_gap_evt_adv_report_t* report, char* name_out) {
  char name[33];
  memset(name, 0, sizeof(name));
  name_out[0] = '\0';
  if (Bluefruit.Scanner.parseReportByType(report, BLE_GAP_AD_TYPE_SHORT_LOCAL_NAME,
                                          (uint8_t*)name, sizeof(name) - 1)) {
    strcpy(name_out, name);
    if (strncmp(name, "FL-", 3) == 0) return true;
  }
  memset(name, 0, sizeof(name));
  if (Bluefruit.Scanner.parseReportByType(report, BLE_GAP_AD_TYPE_COMPLETE_LOCAL_NAME,
                                          (uint8_t*)name, sizeof(name) - 1)) {
    strcpy(name_out, name);
    if (strncmp(name, "FieldLink-", 10) == 0) return true;
  }
  return false;
}

// ---------------- IMU ----------------
bool imuWrite(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(IMU_ADDR); Wire.write(reg); Wire.write(v);
  return Wire.endTransmission() == 0;
}
bool imuRead(uint8_t reg, uint8_t* out, uint8_t len) {
  Wire.beginTransmission(IMU_ADDR); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(IMU_ADDR, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) out[i] = Wire.read();
  return true;
}

// FIFO 비우고 연속 모드로 다시 시작 (가속도만, 데시메이션 없음, ODR = 센서 ODR)
void fifoReset() {
  imuWrite(REG_FIFO_CTRL5, 0x00);                       // bypass: FIFO 비움
  imuWrite(REG_FIFO_CTRL3, 0x01);                       // XL만 FIFO에 넣음
  imuWrite(REG_FIFO_CTRL5, (odrCode << 3) | 0x06);      // continuous mode
  fifoAligned = false;
  fifoLevel = 0;
  lastDrainMs = millis();
}

// 요청값 이하에서 가장 가까운 지원 ODR 적용(없으면 최저값), 실제 속도 반환
uint32_t imuSetRate(uint32_t hz) {
  if (hz > IMU_MAX_HZ) hz = IMU_MAX_HZ;
  int best = 0;
  for (int i = 0; i < ODR_COUNT; i++) {
    if (ODR_TABLE[i].hz <= hz) best = i;
  }
  odrCode = ODR_TABLE[best].code;
  imuWrite(REG_CTRL1_XL, odrCode << 4);  // +-2g
  fifoReset();
  return ODR_TABLE[best].hz;
}

uint16_t fifoPattern() {
  uint8_t p[2];
  if (!imuRead(REG_FIFO_STATUS3, p, 2)) return 0xFFFF;
  return p[0] | ((p[1] & 0x03) << 8);
}

// ---------------- 송신 ----------------
// 패킷을 만들어 MTU-3 단위로 나눠 write. 성공 여부 반환(큐 가득 참 등이면 false)
bool sendPacket(uint8_t type, const uint8_t* payload, uint16_t len, bool withCrc) {
  static uint8_t pkt[1100];
  if (len > 1024) return false;
  pkt[0] = 'F'; pkt[1] = 'L'; pkt[2] = 1; pkt[3] = type;
  pkt[4] = withCrc ? FL_FLAG_CRC : 0; pkt[5] = 0;
  put16(pkt + 6, txSeq++);
  put16(pkt + 8, len);
  if (len) memcpy(pkt + 10, payload, len);
  uint16_t total = 10 + len;
  if (withCrc) { put32(pkt + total, crc32(pkt, total)); total += 4; }

  BLEConnection* conn = Bluefruit.Connection(connHandle);
  uint16_t chunk = attMtu(conn) - 3;
  if (chunk < 20) chunk = 20;
  for (uint16_t off = 0; off < total; off += chunk) {
    uint16_t n = min<uint16_t>(chunk, total - off);
    if (clientUart.write(pkt + off, n) != n) return false;
  }
  return true;
}

bool sendCtl(uint8_t type, const uint8_t* p, uint16_t len) { return sendPacket(type, p, len, true); }

void sendHello() {
  const char* name = DEVICE_NAME;
  uint8_t nl = min<size_t>(strlen(name), 32);
  uint8_t p[37 + 32];
  memset(p, 0, sizeof(p));
  p[0] = 1; p[1] = 1;            // proto_min / max
  p[2] = 0x01;                   // DAQ 센서 노드
  p[3] = 2;                      // i16
  put32(p + 4, NRF_FICR->DEVICEID[0]);
  put32(p + 8, NRF_FICR->DEVICEID[1]);
  put16(p + 12, MODEL_ID);
  put16(p + 14, FW_VERSION);
  put32(p + 16, MY_CAPS);
  p[20] = NUM_CH;
  p[21] = MAX_FRAMES;
  put16(p + 22, 0);              // 재전송 버퍼 없음 (수준 C)
  put32(p + 24, ODR_TABLE[0].hz);
  put32(p + 28, IMU_MAX_HZ);
  put32(p + 32, scanRateHz);
  p[36] = nl;
  memcpy(p + 37, name, nl);
  sendCtl(T_HELLO, p, 37 + nl);
}

void sendLinkInfo() {
  BLEConnection* conn = Bluefruit.Connection(connHandle);
  uint8_t p[12];
  memset(p, 0, sizeof(p));
  if (conn) {
    uint8_t phy = conn->getPHY();
    put16(p + 0, attMtu(conn));
    p[2] = phy; p[3] = phy;                       // 스택이 보고하는 현재 PHY
    put16(p + 4, conn->getConnectionInterval());  // 1.25 ms 단위
    put16(p + 6, 0);
    put16(p + 8, 400);                            // 요청한 supervision timeout (4 s)
    put16(p + 10, conn->getDataLength());
  }
  sendCtl(T_LINK_INFO, p, 12);
}

void sendHeartbeat() {
  uint8_t p[16];
  memset(p, 0, sizeof(p));
  put32(p + 0, millis());
  put16(p + 4, fifoLevel);         // 송신 대기량 = IMU FIFO에 쌓인 프레임 수
  put16(p + 6, FIFO_CAP_FRAMES);
  put32(p + 8, droppedFrames);
  p[12] = 0xFF;                    // 배터리 정보 없음
  sendCtl(T_HEARTBEAT, p, 16);
}

void sendResult(uint8_t forType, uint8_t status, uint16_t forSeq) {
  uint8_t p[4] = { forType, status, 0, 0 };
  put16(p + 2, forSeq);
  sendCtl(T_RESULT, p, 4);
}

void sendConfigAck(uint8_t status) {
  uint8_t p[16];
  memset(p, 0, sizeof(p));
  p[0] = status;
  put32(p + 4, scanRateHz);
  put16(p + 8, channelMask);
  p[10] = framesPerPacket;
  p[11] = integrity;
  put16(p + 12, 100);
  put16(p + 14, heartbeatMs);
  sendCtl(T_CONFIG_ACK, p, 16);
}

// ---------------- DATA ----------------
uint8_t popcount8(uint8_t v) { uint8_t c = 0; while (v) { c += v & 1; v >>= 1; } return c; }

void flushData() {
  if (frameFill == 0) return;
  static uint8_t p[20 + MAX_FRAMES * NUM_CH * 2];
  uint8_t chCount = popcount8(channelMask & 0x07);
  put32(p + 0, sampleSeq);
  put64(p + 4, 0);   // 타임스탬프 미지원(capabilities bit3 = 0)
  put32(p + 12, scanRateHz);
  p[16] = frameFill;
  p[17] = chCount;
  p[18] = 2;
  p[19] = 0;
  uint16_t off = 20;
  for (uint8_t f = 0; f < frameFill; f++)
    for (uint8_t c = 0; c < NUM_CH; c++)
      if (channelMask & (1 << c)) { p[off++] = frameBuf[f][c * 2]; p[off++] = frameBuf[f][c * 2 + 1]; }
  // 못 보낸 프레임도 sample_seq는 넘김 -> 게이트웨이가 빈 구간으로 손실을 셈
  if (!sendPacket(T_DATA, p, off, integrity >= 1)) droppedFrames += frameFill;
  sampleSeq += frameFill;
  frameFill = 0;
}

void pushFrame(const uint8_t* xyz) {
  memcpy(frameBuf[frameFill++], xyz, NUM_CH * 2);
  if (frameFill >= framesPerPacket) flushData();
}

// FIFO가 넘쳐 샘플을 잃었을 때: 잃은 프레임 수를 시간으로 추정해 sample_seq를 건너뜀
void handleOverrun() {
  uint32_t elapsedMs = millis() - lastDrainMs;
  uint32_t est = (uint32_t)((uint64_t)elapsedMs * scanRateHz / 1000);
  uint32_t lost = est > FIFO_CAP_FRAMES ? est - FIFO_CAP_FRAMES : 1;
  flushData();                     // 넘치기 전에 읽은 프레임 먼저 보냄
  sampleSeq += lost;
  droppedFrames += lost;
  Serial.printf("FIFO overrun: ~%lu frames lost\n", (unsigned long)lost);
  fifoReset();
}

// n프레임(= 3n 워드)을 FIFO에서 읽음. 연속 읽기가 안 되는 칩이면 처음 한 번 감지해 워드 단위로 전환
bool readFifoFrames(uint8_t* raw, uint8_t n) {
  if (burstOk) {
    if (!imuRead(REG_FIFO_DATA_OUT, raw, n * 6)) return false;
    if (!burstChecked) {
      // 연속 읽기에서 주소가 0x3E로 롤백되면 3n워드가 빠져 패턴은 다시 X(0)
      if (fifoPattern() == 0) {
        burstChecked = true;
      } else {
        burstOk = false;
        fifoAligned = false;
        Serial.println("FIFO burst read not supported; using word reads");
        return false;
      }
    }
    return true;
  }
  for (uint8_t w = 0; w < n * 3; w++) {
    if (!imuRead(REG_FIFO_DATA_OUT, raw + w * 2, 2)) return false;
  }
  return true;
}

void pollImu() {
  uint8_t st[2];
  if (!imuRead(REG_FIFO_STATUS1, st, 2)) return;
  if (st[1] & 0x40) { handleOverrun(); return; }        // OVER_RUN
  uint16_t words = st[0] | ((st[1] & 0x07) << 8);

  // 다음 워드가 X축이 될 때까지 버림 (시작/리셋 직후 한 번)
  while (!fifoAligned && words > 0) {
    if (fifoPattern() == 0) { fifoAligned = true; break; }
    uint8_t w[2];
    if (!imuRead(REG_FIFO_DATA_OUT, w, 2)) return;
    words--;
  }
  if (!fifoAligned) return;

  uint16_t frames = words / 3;
  fifoLevel = frames;
  uint8_t raw[BURST_FRAMES * 6];
  while (frames > 0) {
    uint8_t n = frames < BURST_FRAMES ? frames : BURST_FRAMES;
    if (!readFifoFrames(raw, n)) return;
    for (uint8_t i = 0; i < n; i++) pushFrame(raw + i * 6);
    frames -= n;
  }
  lastDrainMs = millis();
}

// ---------------- PROBE ----------------
void runProbe(const uint8_t* p) {
  uint8_t probeId = p[0], mode = p[1];
  uint16_t payloadBytes = get16(p + 2);
  uint32_t targetBps = get32(p + 4);
  uint16_t durationMs = get16(p + 8);
  if (payloadBytes > 1000) payloadBytes = 1000;
  if (maxPacketBytes > 20 && payloadBytes > maxPacketBytes - 20) payloadBytes = maxPacketBytes - 20;

  static uint8_t pd[1010];
  uint32_t sent = 0, bytes = 0, busy = 0, probeSeq = 0;
  uint32_t t0 = micros();
  uint32_t pktBytes = 10 + 6 + payloadBytes + (integrity >= 1 ? 4 : 0);
  uint32_t intervalUs = (mode == 1 && targetBps) ? (uint32_t)((uint64_t)pktBytes * 8 * 1000000ULL / targetBps) : 0;
  uint32_t nextAt = t0;

  while ((micros() - t0) < (uint32_t)durationMs * 1000UL && Bluefruit.connected()) {
    if (mode == 1) {
      if ((int32_t)(micros() - nextAt) < 0) { yield(); continue; }
      nextAt += intervalUs;
    }
    pd[0] = probeId; pd[1] = 0;
    put32(pd + 2, probeSeq);
    for (uint16_t k = 0; k < payloadBytes; k++) pd[6 + k] = (probeSeq + k) & 0xFF;
    if (sendPacket(T_PROBE_DATA, pd, 6 + payloadBytes, integrity >= 1)) {
      sent++; bytes += pktBytes; probeSeq++;
    } else {
      busy++;
      delay(1);
    }
  }
  uint8_t e[20];
  memset(e, 0, sizeof(e));
  e[0] = probeId;
  put32(e + 4, sent); put32(e + 8, bytes); put32(e + 12, busy);
  put32(e + 16, micros() - t0);
  sendCtl(T_PROBE_END, e, 20);
  Serial.printf("PROBE %u mode=%u sent=%lu busy=%lu\n", probeId, mode,
                (unsigned long)sent, (unsigned long)busy);
}

// ---------------- 수신 처리 ----------------
void disconnectAndBackoff(uint32_t holdMs) {
  streaming = false;
  nextScanAt = millis() + holdMs;
  if (connHandle != BLE_CONN_HANDLE_INVALID) {
    Bluefruit.disconnect(connHandle);
    state = ST_CLOSING;                // disconnectCallback()이 ST_IDLE로 돌림
    stateSince = millis();
  } else {
    state = ST_IDLE;
  }
}

void handlePacket(uint8_t type, uint16_t seq, const uint8_t* p, uint16_t len) {
  switch (type) {
    case T_HELLO_ACK: {
      if (len < 26) break;
      uint8_t status = p[0], proto = p[1], gwClass = p[2];
      if (status != 0) {
        Serial.printf("HELLO rejected, status=%u\n", status);
        if (status == 3) { avoidPeer(BUSY_HOLD_MS); disconnectAndBackoff(1000); }
        else if (status == 1 || status == 2) { avoidPeer(AVOID_MS); disconnectAndBackoff(1000); }
        else disconnectAndBackoff(5000);
        break;
      }
      if (gwClass != 0x80 || proto != 1) {
        Serial.println("Not a FieldLink gateway / bad version");
        avoidPeer(AVOID_MS);
        disconnectAndBackoff(1000);
        break;
      }
      integrity = p[3];
      maxPacketBytes = get16(p + 14);
      heartbeatMs = get16(p + 20);
      if (heartbeatMs == 0) heartbeatMs = 1000;
      Serial.printf("HELLO_ACK ok integrity=%u heartbeat=%ums max_packet=%u\n",
                    integrity, heartbeatMs, maxPacketBytes);
      sendLinkInfo();
      state = ST_READY;
      stateSince = millis();
      lastHeartbeat = millis();
      backoffIdx = 0;
      break;
    }
    case T_LINK_INFO:
      Serial.println("LINK_INFO from gateway");
      break;
    case T_PROBE_START:
      if (len >= 10) runProbe(p);
      break;
    case T_PROBE_RESULT:
      // id(1) verdict(1) rsv(2) packets_rx(4) bytes_rx(4) lost(4) corrupt(4) measured_bps(4)
      if (len >= 24) Serial.printf("PROBE_RESULT id=%u verdict=%u bps=%lu lost=%lu\n", p[0], p[1],
                                   (unsigned long)get32(p + 20), (unsigned long)get32(p + 12));
      break;
    case T_CONFIG: {
      if (len < 12) { sendResult(type, 1, seq); break; }
      uint32_t reqHz = get32(p + 0);
      uint8_t status = 0;
      uint32_t applied = imuSetRate(reqHz);   // 요청값 이하 최근접(없으면 최저값)
      if (applied != reqHz) status = 1;
      scanRateHz = applied;
      uint8_t mask = get16(p + 4) & 0x07;
      if (mask != get16(p + 4)) status = 1;
      channelMask = mask ? mask : 0x07;
      uint8_t f = p[6];
      if (f < 1) f = 1;
      if (f > MAX_FRAMES) { f = MAX_FRAMES; status = 1; }
      {
        // 헤더10 + DATA앞부분20 + CRC4 + F*채널*2 <= max_packet_bytes
        uint8_t chn = popcount8(channelMask);
        uint16_t maxF = (maxPacketBytes > 34) ? (maxPacketBytes - 34) / (chn * 2) : 1;
        if (maxF < 1) maxF = 1;
        if (f > maxF) { f = maxF; status = 1; }
      }
      framesPerPacket = f;
      integrity = (p[7] > 1) ? 1 : p[7];  // 수준 C: ARQ 미지원
      heartbeatMs = get16(p + 10) ? get16(p + 10) : heartbeatMs;
      Serial.printf("CONFIG rate=%lu mask=0x%02X F=%u integ=%u\n",
                    (unsigned long)scanRateHz, channelMask, framesPerPacket, integrity);
      sendConfigAck(status);
      break;
    }
    case T_START:
      frameFill = 0;
      fifoReset();
      streaming = true;
      Serial.println("START");
      sendResult(type, 0, seq);
      break;
    case T_STOP:
      flushData();
      streaming = false;
      Serial.println("STOP");
      sendResult(type, 0, seq);
      break;
    case T_ERROR:
      if (len >= 5) Serial.printf("ERROR from gateway code=%u for_type=0x%02X\n", p[0], p[1]);
      break;
    default: {
      // 모르는 type: ERROR(코드 2)
      uint8_t e[5] = { 2, type, 0, 0, 0 };
      put16(e + 2, seq);
      sendCtl(T_ERROR, e, 5);
    }
  }
}

// rxBuf에서 FL 패킷 추출 (바이트 스트림 + 재동기)
void parseStream() {
  while (rxLen >= 10) {
    if (rxBuf[0] != 'F' || rxBuf[1] != 'L') { memmove(rxBuf, rxBuf + 1, --rxLen); continue; }
    uint16_t len = get16(rxBuf + 8);
    if (len > 1024 || rxBuf[2] != 1) { memmove(rxBuf, rxBuf + 1, --rxLen); continue; }
    uint16_t total = 10 + len + ((rxBuf[4] & FL_FLAG_CRC) ? 4 : 0);
    if (rxLen < total) return;
    if (rxBuf[4] & FL_FLAG_CRC) {
      if (crc32(rxBuf, 10 + len) != get32(rxBuf + 10 + len)) { memmove(rxBuf, rxBuf + 1, --rxLen); continue; }
    }
    uint8_t type = rxBuf[3];
    uint16_t seq = get16(rxBuf + 6);
    static uint8_t payload[1030];
    memcpy(payload, rxBuf + 10, len);
    memmove(rxBuf, rxBuf + total, rxLen - total);
    rxLen -= total;
    handlePacket(type, seq, payload, len);
  }
}

void drainRing() {
  while (ringTail != ringHead && rxLen < sizeof(rxBuf)) {
    rxBuf[rxLen++] = ring[ringTail];
    ringTail = (ringTail + 1) % sizeof(ring);
  }
}

// ---------------- BLE 콜백 ----------------
void uartRxCallback(BLEClientUart& uart) {
  while (uart.available()) {
    uint16_t next = (ringHead + 1) % sizeof(ring);
    if (next == ringTail) { uart.read(); continue; }  // overflow: 버림
    ring[ringHead] = uart.read();
    ringHead = next;
  }
}

volatile uint32_t scanReports = 0;
volatile uint32_t connectFails = 0;
char lastSeenName[33];           // DEBUG_SCAN: UUID가 맞은 마지막 광고 (loop에서 출력)
uint8_t lastSeenAddr[6];

void scanCallback(ble_gap_evt_adv_report_t* report) {
  scanReports++;
  // UUID는 여기서 직접 확인한다. Scanner.filterUuid()를 쓰면 NUCODE 코어 1.0.2에서
  // 콜백이 한 번도 오지 않았음 (같은 광고가 checkReportForService()로는 통과).
  // 같은 UUID(Nordic UART)를 쓰는 다른 장치가 흔하므로 이름 접두어와 회피 목록도 확인한다.
  // 거른 광고 뒤에는 resume()을 불러야 스캔이 이어짐.
  if (!Bluefruit.Scanner.checkReportForService(report, clientUart)) {
    Bluefruit.Scanner.resume();
    return;
  }
  char name[33];
  bool avoided = isAvoided(report->peer_addr.addr);
  bool named = isFieldLinkName(report, name);
#if DEBUG_SCAN
  memcpy(lastSeenName, name, sizeof(lastSeenName));
  memcpy(lastSeenAddr, report->peer_addr.addr, 6);
#endif
  if (avoided || !named) {
    Bluefruit.Scanner.resume();
    return;
  }
  memcpy(peerAddr, report->peer_addr.addr, 6);
  havePeer = true;
  if (!Bluefruit.Central.connect(report)) {
    // 실패하면 SoftDevice 스캔이 멈춘 채로 남으므로 직접 재개
    connectFails++;
    havePeer = false;
    Bluefruit.Scanner.resume();
  }
}

void startDiscovery() {
  if (clientUart.discover(connHandle)) {
    clientUart.enableTXD();            // TX(Notify) CCCD 구독
    state = ST_WAIT_ACK;
    stateSince = millis();
    txSeq = 0;
    rxLen = 0; ringHead = ringTail = 0;
    sendHello();
    Serial.println("HELLO sent");
  } else {
    Serial.println("Discovery failed (no UART service)");
    avoidPeer(AVOID_MS);
    disconnectAndBackoff(1000);
  }
}

void connectCallback(uint16_t handle) {
  connHandle = handle;
  BLEConnection* conn = Bluefruit.Connection(handle);
  Serial.println("Connected");
  conn->requestMtuExchange(247);
  conn->requestDataLengthUpdate();
  conn->requestPHY();                  // 2M 요청
  state = ST_SETUP;
  stateSince = millis();
  pairedOk = false;
#if REQUIRE_PAIRING
  conn->requestPairing();
#endif
}

void pairCompleteCallback(uint16_t handle, uint8_t authStatus) {
  if (authStatus == BLE_GAP_SEC_STATUS_SUCCESS) {
    Serial.println("Paired");
    pairedOk = true;
  } else {
    Serial.printf("Pairing failed 0x%02X\n", authStatus);
    disconnectAndBackoff(5000);
  }
}

void disconnectCallback(uint16_t handle, uint8_t reason) {
  Serial.printf("Disconnected reason=0x%02X\n", reason);
  connHandle = BLE_CONN_HANDLE_INVALID;
  streaming = false;
  frameFill = 0;
  state = ST_IDLE;
  // 재접속 간격 1,2,4,8,16,30 s (+-20% 랜덤)
  static const uint32_t steps[] = {1000, 2000, 4000, 8000, 16000, 30000};
  uint32_t base = steps[min<uint32_t>(backoffIdx, 5)];
  if (backoffIdx < 5) backoffIdx++;
  uint32_t jitter = base / 5;
  uint32_t t = base - jitter + (jitter ? random(jitter * 2) : 0);
  uint32_t holdUntil = millis() + t;
  if ((int32_t)(holdUntil - nextScanAt) > 0) nextScanAt = holdUntil;  // 거절 hold 유지
}

// ---------------- setup / loop ----------------
void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);
  Serial.println("=== NU40 FieldLink accel sensor (level C, v0.3) ===");

  Wire.begin();
  Wire.setClock(400000);
  uint8_t id = 0;
  if (!imuRead(REG_WHOAMI, &id, 1) || id != 0x6A) {
    Serial.println("ERROR: IMU not found");
    while (1) delay(1000);
  }
  imuWrite(REG_CTRL3_C, 0x44);        // BDU + auto-increment
  scanRateHz = imuSetRate(scanRateHz);

  // MTU 247 / DLE 251을 쓰려면 begin() 전에 대역폭을 최대로 설정해야 함
  Bluefruit.configCentralBandwidth(BANDWIDTH_MAX);
  if (!Bluefruit.begin(0, 1)) {       // peripheral 0, central 1
    Serial.println("ERROR: Bluefruit.begin failed (SoftDevice RAM/config)");
  }
  Bluefruit.setName(DEVICE_NAME);
  Bluefruit.setTxPower(4);
#if REQUIRE_PAIRING
  Bluefruit.Security.setIOCaps(false, false, false);  // Just Works
  Bluefruit.Security.setPairCompleteCallback(pairCompleteCallback);
#endif
  Bluefruit.Central.setConnectCallback(connectCallback);
  Bluefruit.Central.setDisconnectCallback(disconnectCallback);
  Bluefruit.Central.setConnInterval(6, 12);        // 7.5-15 ms (1.25 ms 단위)

  clientUart.begin();
  clientUart.setRxCallback(uartRxCallback);

  Bluefruit.Scanner.setRxCallback(scanCallback);
  Bluefruit.Scanner.restartOnDisconnect(false);
  Bluefruit.Scanner.setInterval(160, 80);
  Bluefruit.Scanner.useActiveScan(true);          // 스캔 응답의 전체 이름도 받음
  nextScanAt = millis();
}

void loop() {
  uint32_t now = millis();

  switch (state) {
    case ST_IDLE:
      if ((int32_t)(now - nextScanAt) >= 0) {
        bool ok = Bluefruit.Scanner.start(0);
        state = ST_SCAN;
        Serial.printf("Scanning... (start=%d)\n", ok);
      }
      delay(10);
      break;

    case ST_SCAN:
#if DEBUG_SCAN
      {
        static uint32_t lastStatus = 0;
        if (now - lastStatus >= 5000) {
          lastStatus = now;
          const uint8_t* a = lastSeenAddr;
          Serial.printf("still scanning (running=%d, reports=%lu, connect fails=%lu, last %02X:%02X:%02X:%02X:%02X:%02X '%s')\n",
                        Bluefruit.Scanner.isRunning(), (unsigned long)scanReports,
                        (unsigned long)connectFails, a[5], a[4], a[3], a[2], a[1], a[0], lastSeenName);
        }
      }
#endif
      delay(10);
      break;

    case ST_SETUP:
      // MTU/PHY/DLE 협상 및 페어링 완료까지 잠시 대기 후 서비스 탐색
      if (now - stateSince > 5000) { disconnectAndBackoff(5000); break; }
#if REQUIRE_PAIRING
      if (pairedOk && now - stateSince > 800) startDiscovery();
#else
      if (now - stateSince > 800) startDiscovery();
#endif
      delay(10);
      break;

    case ST_WAIT_ACK:
      drainRing();
      parseStream();
      if (state == ST_WAIT_ACK && now - stateSince > 5000) {
        // FieldLink 게이트웨이가 아닌 Nordic UART 장치일 가능성: 이 주소를 60 s 피함
        Serial.println("HELLO_ACK timeout");
        avoidPeer(AVOID_MS);
        disconnectAndBackoff(1000);
      }
      delay(5);
      break;

    case ST_READY:
      drainRing();
      parseStream();
      if (!Bluefruit.connected()) break;
      if (streaming) pollImu();
      if (now - lastHeartbeat >= heartbeatMs) {
        lastHeartbeat = now;
        sendHeartbeat();
      }
      if (!streaming) delay(2);
      break;

    case ST_CLOSING:
      // 끊김 콜백이 안 오면 3 s 뒤 강제로 대기 상태로
      if (now - stateSince > 3000) state = ST_IDLE;
      delay(10);
      break;
  }
}
