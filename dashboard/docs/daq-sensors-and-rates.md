# DAQ 센서 목록과 샘플레이트 계약

센서 목록은 UDP 보드 검색과 별개다. UUID를 발견한 뒤 TCP HELLO/STATUS에 `sensors`와 `sampling`을 추가하거나, `POST /api/edge/boards`로 아래 JSON을 보내면 백엔드가 채널별 센서를 자동 등록한다. UUID는 보드가 발급한다. 같은 DAQ의 같은 채널은 한 번만 등록하고 이름·위치·사진·교정값을 운영자가 수정한 뒤에는 그 설정을 유지한다. 센서 목록은 부분 업데이트가 기본이며 완전한 목록이면 `inventoryComplete: true`를 추가한다. 목록에서 빠진 센서는 분리 상태로 표시하되 이력은 삭제하지 않는다.

```json
{
  "uuid": "9a4f1ccd-2e20-4550-a482-3920cd848bb2",
  "label": "sk-am64b",
  "ip": "192.168.0.240",
  "port": 8765,
  "inventoryComplete": true,
  "sampling": {
    "commonRateHz": 1000,
    "totalRateHz": 1250.5,
    "complete": true,
    "channels": [
      {"channel": "CH0", "sps": 1000},
      {"channel": "CH1", "sps": 250},
      {"channel": "CH2", "sps": 0.5}
    ]
  },
  "sensors": [
    {"edgeId": "vibration", "channel": "CH0", "name": "베어링 진동", "type": "vibration", "unit": "g", "sps": 1000, "connected": true},
    {"edgeId": "current", "channel": "CH1", "name": "소비 전류", "type": "current", "unit": "A", "sps": 250, "connected": true},
    {"edgeId": "temperature", "channel": "CH2", "name": "표면 온도", "type": "temperature", "unit": "°C", "sps": 0.5, "connected": true}
  ]
}
```

숫자와 센서는 형식 예시이며 현재 보드의 실제 연결 정보가 아니다. `sensors` 항목은 `channel`만 필수이며 이름·종류·단위가 없으면 해당 채널명/범용 아날로그/V로 임시 등록하고 이후 보드 정보로 보완한다. `edgeId`는 DAQ 안에서 고유한 센서 식별자로, v0.3 추론 출력의 센서 키로도 사용할 수 있다. `connected:false`는 명시적인 센서 분리 상태다. 센서 목록 자체가 없는 응답에서는 ADC 입력 수만으로 물리 센서가 연결됐다고 가정하지 않는다.

`sampling`의 의미:

- `commonRateHz`: 전체 채널 공통 기본값(SPS/채널). 개별 채널 값과 다를 수 있다. 공통값이 없으면 null이다.
- `channels`: 채널별 실제 설정/보고 rate. 정수가 아닌 0.5Hz 등도 지원한다. 모르는 값은 null이다. 0은 해당 채널이 샘플을 보내지 않는 상태를 보고할 때 사용할 수 있다.
- `totalRateHz`: 모든 채널의 합계 samples/s. 보드가 제공하면 사용하고, 전체 채널의 값이 모두 알려졌을 때만 합계로 계산한다. complete=true 목록과 전체 합계가 모순되면 거부한다.
- `complete`: channels가 전체 채널 목록인지 여부. 부분 목록은 false로 명시한다. 전체값이 없고 목록이 부분적이면 UI는 전체값 미수신으로 표시한다.
- `timestamp`: 선택적인 시간대 포함 ISO 8601 보고 시각. 이전 sampling 보고가 늦게 도착해도 최신 정보를 덮어쓰지 않는다.

같은 프레임에 센서 메타데이터와 Raw를 보낼 수도 있다. `POST /api/edge/frames`의 기존 `daqUuid`/`frameId`/`readings`에 `sensors`, `sampling`, `inventoryComplete`를 추가한다. 새 채널 등록과 프레임 저장은 함께 검증하며 오류 시 모두 저장하지 않는다. readings의 각 `sps`는 해당 배치의 실제 rate이고, 이전 배치를 현재 설정으로 재해석하지 않는다. metadata의 `sensors` 배열과 v0.3 예측의 `sensors` 객체는 서로 다른 계약이므로 v0.3 예측 결과는 별도 프레임으로 보낸다.

## TCP 연동과 제어

HELLO/STATUS에서 위 `sensors`, `sampling`, `inventoryComplete` 필드를 그대로 제공할 수 있다. STATUS 값을 우선하며 없으면 HELLO 정보를 사용한다. 기존 `scan_rate_hz`만 있는 ADS8688 응답도 유지한다. 기존 모델은 8채널 공통 rate로 표시하며, channel_count가 있으면 그 값을 사용한다. 채널별 목록이 이미 별도로 수신된 경우 기존 공통 STATUS만으로 그 값을 일괄 덮어쓰지 않는다.

`feature/dev` 보드는 UDP discovery v2 및 TCP HELLO/STATUS의 `channel_capabilities`로 채널과 샘플레이트 그룹을 제공합니다. 검색은 v1도 함께 요청하여 기존 보드와 호환하며 동일 UUID에서는 v2 채널 정보를 우선합니다. ADC 입력 채널 목록과 물리 센서 목록은 별개입니다. 실제 센서가 없으면 운영자가 채널을 센서로 등록하거나 위 `sensors` 목록을 제공해야 합니다.

- ADS8688 CH0–CH7: `ads8688.scan` 그룹, 10–2,000 정수 SPS. 8채널이 함께 변경됩니다.
- ADS1263 AIN0/AIN1: 400 SPS 고정, AIN6/AIN7: 10 SPS 고정. `streamAvailable:false`이면 UI에 수집 연동 대기로 표시합니다.
- capability에서 계산한 전체 합계는 설정된 모든 채널의 합계이며 스트림 연동 대기 채널을 포함합니다. 실제 수신량을 뜻하지 않습니다. 명시적 `sampling`이 있으면 우선합니다.

| 명령 | HTTP 요청 | TCP 요청 | 조건 |
|---|---|---|---|
| 그룹 설정 | POST `/api/daqs/:uuid/acquisition` `{ "action":"rate", "groupId":"ads8688.scan", "rate":1500 }` | SET_RATE_GROUP(0x000c), UTF-8 JSON `{ "groupId":"ads8688.scan", "rateHz":1500 }` | sample_rate 지원, writable 그룹, minHz/maxHz/stepHz 검증 |
| 기존 공통 설정 | 같은 API `{ "action":"rate", "rate":1500 }` | 그룹 capability 보드에서는 유일한 writable 그룹에 SET_RATE_GROUP, 기존 보드에서는 SET_RATE(0x0005), u32 big-endian | 기존 10–2,000 정수 SPS, writable 그룹이 여러 개면 groupId 필수 |

성공 응답 type은 0x800c, 실패는 0xffff입니다. 백엔드는 UUID와 capability를 확인하고 ACK 이후 STATUS에서 그룹 및 모든 소속 채널의 rate를 검증합니다. 공통 그룹에 대한 개별 채널 변경은 거부합니다. 단일 채널 writable 그룹은 그룹 요청으로 변경할 수 있습니다.

별도의 범용 보드가 `channel_capabilities` 없이 `channel_sample_rate`를 명시적으로 지원할 때만 기존 제안 계약 `{ "action":"channel_rate", "channel":"CH1", "sps":250 }`을 TCP 0x000c JSON `{ "channel":"CH1", "sps":250 }`으로 전송합니다. 이 제안 payload는 실제 ADS8688 그룹 제어에 보내지 않습니다. 그룹 ID를 받은 기존 보드에도 묵시적으로 공통 명령을 보내지 않습니다.

기존 48-byte binary 프레임은 8채널 공통 scan rate 하나만 전달하므로 서로 다른 채널 rate를 표현하지 않는다. 미래 보드가 개별 rate로 수집한다면 실제 배치를 채널별로 분리해 JSON readings로 전달하거나 별도 binary 확장 버전을 합의해야 한다. 백엔드가 누락된 샘플을 임의 생성하거나 rate만 바꿔 기록하지 않는다.

센서 목록에만 개별 sps가 있고 전체 sampling이 없으면 공통 scan rate로 채널 값을 덮어쓰지 않는다. 이 경우 전체값은 미수신으로 표시한다. 개별 채널 설정과 전체 DAQ 합계는 AI 질의의 상태 컨텍스트에도 포함된다.
