# ADS8688 네트워크 프로토콜 v1

기본 포트는 UDP `8764`(검색), TCP `8765`(제어·데이터)이다. v1은 신뢰된 로컬 LAN 전용이며 인증과 TLS는 포함하지 않는다. 모든 TCP 다중 바이트 필드는 network byte order(big-endian)이고, ADS8688 원본 48-byte 프레임만 MCU 형식 그대로 little-endian이다.

## UDP 검색

요청은 `magic[4]="A8DQ", version:u16, reserved:u16, nonce:u64`의 16 bytes이다. 신규 클라이언트는 discovery version `2`를 요청한다. 보드는 다음 응답을 요청 송신 주소로 돌려준다.

```text
magic[4]="A8DR"
version:u16
status:u16
nonce:u64
uuid[16]
tcp_port:u16
hostname_length:u8
model_length:u8
capabilities_length:u16  # version 2에서만 존재
hostname[hostname_length]
model[model_length]
capabilities_json[capabilities_length]
```

capability JSON은 `channelCount`, 채널별 현재 SPS, 그리고 같은 속도로 함께 변경되는 그룹을 포함한다. UDP 단일 datagram 크기를 유지하기 위해 채널 배열은 `[id,label,adc,input,sps,inputUnit,groupId,streamAvailable]`, 그룹 배열은 `[id,label,channelIds,currentSps,writable,min,max,step]` 순서다. 각 그룹의 `writable`, 허용 범위와 `channelIds`가 UI 제어 가능 여부의 기준이다. 현재 ADS8688 CH0–CH7은 하나의 공통 가변 그룹이고 ADS1263의 두 차동 입력은 독립 고정 그룹으로 보고한다. version 1 요청에는 종전 응답을 반환한다. 클라이언트는 nonce가 요청과 같은 응답만 수락하고 UUID를 보드 식별자로 사용한다.

## TCP 프레이밍

모든 메시지는 12-byte 헤더 뒤에 payload가 온다.

```text
payload_length:u32
version:u16 = 1
type:u16
request_id:u32
payload[payload_length]
```

요청에 성공하면 응답 type은 `요청 type | 0x8000`이고 JSON payload를 담는다. 실패 응답 type은 `0xffff`이다. `request_id`는 요청과 응답을 연결한다.

| Type | 이름 | 요청 payload | 동작 |
|---:|---|---|---|
| `0x0001` | HELLO | 없음 | 버전, UUID, 기능 조회 |
| `0x0002` | STATUS | 없음 | 취득·저장·오류 상태 조회 |
| `0x0003` | ACQ_START | 없음 | M4 취득 시작 |
| `0x0004` | ACQ_STOP | 없음 | M4 취득 정지 |
| `0x0005` | SET_RATE | `scan_rate_hz:u32` | 8채널 scan rate 설정(10..2000 Hz) |
| `0x0006` | STREAM_START | 없음 | 해당 TCP client의 라이브 전송 시작 |
| `0x0007` | STREAM_STOP | 없음 | 해당 TCP client의 라이브 전송만 정지 |
| `0x0008` | ARCHIVE_INFO | 없음 | 보존 중인 record 범위와 용량 조회 |
| `0x0009` | READ_BACKLOG | `after_record_id:u64, max_records:u32` | 다음 저장 레코드를 최대 2000개 조회 |
| `0x000a` | READ_BACKLOG_V2 | `after_record_id:u64, max_records:u32` | 수신 Unix 시각을 포함해 다음 저장 레코드 조회 |
| `0x000b` | STREAM_START_V2 | 없음 | 수신 Unix 시각을 포함한 라이브 전송 시작 |
| `0x000c` | SET_RATE_GROUP | JSON `{groupId,rateHz}` | capability에서 `writable=true`인 채널 그룹의 속도 설정 |
| `0x0100` | LIVE_DATA | `record_id:u64 + frame[48]` | 라이브 데이터, request_id=0 |
| `0x0101` | ARCHIVE_DATA | `record_id:u64 + frame[48]` | 누락 구간 재생, 원 요청 request_id 사용 |
| `0x0102` | ARCHIVE_DATA_V2 | `record_id:u64 + received_unix_ns:u64 + frame[48]` | 시각 포함 누락 구간 재생 |
| `0x0103` | LIVE_DATA_V2 | `record_id:u64 + received_unix_ns:u64 + frame[48]` | 시각 포함 라이브 데이터 |

`READ_BACKLOG`은 0개 이상의 `ARCHIVE_DATA`를 보낸 뒤 `0x8009` 완료 응답을 보낸다. 완료 JSON의 `last_record_id`, `latest_record_id`, `more`로 다음 페이지를 요청한다. 요청 cursor가 이미 FIFO에서 삭제된 경우 `truncated=true`와 현재 `earliest_record_id`를 반환한다.

새 수집기는 `HELLO.capabilities`에 `timestamped_stream`이 있으면 V2 명령을 사용한다. V2는 저장 레코드의 `received_unix_ns`를 그대로 전달하므로 연결 단절 뒤 복구된 데이터도 원래 수집 시각으로 표시할 수 있다. 기존 V1 클라이언트와 메시지는 계속 지원한다.

## 연결 단절 규칙

TCP 연결과 M4 취득·Linux 저장은 서로 독립이다. 연결이 끊기면 해당 client의 라이브 전송만 사라지고 보드 기록은 계속된다. 클라이언트는 마지막으로 처리한 `record_id`를 기억했다가 재접속 후 다음 순서로 복구한다.

1. `ARCHIVE_INFO`로 마지막 record가 아직 보존 중인지 확인한다.
2. `READ_BACKLOG(after_record_id=마지막 record)`를 `more=false`까지 반복한다.
3. `STREAM_START`로 라이브 전송을 시작한다.

링의 가장 오래된 파일이 이미 삭제됐다면 `earliest_record_id`보다 이전 데이터는 복구할 수 없다. MCU sequence는 재부팅 때 초기화될 수 있으므로 누락 복구 cursor로는 보드가 부여하는 64-bit `record_id`를 사용한다.

## 저장 형식

segment는 64-byte 헤더와 고정 64-byte record의 연속이다. 기록 중에는 `.part`, 정상 종료·회전 후에는 `.ads8` 확장자를 쓴다.

```text
segment header: magic/version/header_size/uuid/start_unix_ns/first_record_id/first_sequence/scan_rate
record: record_id:u64 + received_unix_ns:u64 + Ads8688StreamFrame[48]
```

보드는 매초 `fsync`하고, 재시작 때 마지막 `.part`를 완전한 64-byte record 경계까지 잘라 복구한다. 디스크의 10%와 2 GiB 중 큰 공간을 OS용으로 남기고, 임계점에서는 가장 오래된 완료 segment부터 삭제한다.

진단 알고리즘용 공개 명령이나 네트워크 엔드포인트는 v1에 없다.
