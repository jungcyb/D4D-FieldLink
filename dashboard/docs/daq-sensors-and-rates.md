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

현재 실행 중인 보드는 센서 목록과 개별 설정 기능을 아직 제공하지 않는다. 다음은 **신규 보드 구현용 제안 계약**이며 구현 전에는 백엔드가 채널별 변경 명령을 보내지 않는다.

| 명령 | HTTP 요청 | TCP 요청 | 조건 |
|---|---|---|---|
| 공통 기본값 | POST `/api/daqs/:uuid/acquisition` `{ "action":"rate", "rate":1500 }` | 기존 SET_RATE(0x0005), u32 big-endian | HELLO.capabilities에 sample_rate, 기존 10~2,000 정수 SPS |
| 채널별 값 | 같은 API `{ "action":"channel_rate", "channel":"CH1", "sps":250 }` | 제안 SET_CHANNEL_RATE(0x000c), UTF-8 JSON `{ "channel":"CH1", "sps":250 }` | HELLO.capabilities에 channel_sample_rate 및 STATUS/HELLO의 해당 채널 |

신규 채널 명령 성공 응답 type은 0x800c, 실패는 기존 0xffff다. 백엔드는 보드 UUID·기능·채널 확인 후 명령을 보내고, ACK 뒤 STATUS를 다시 읽어 같은 채널의 sps가 요청과 일치할 때만 성공 처리한다. 0.01~1,000,000의 유한한 양수 채널 SPS를 지원하며, 실제 하드웨어 지원 범위는 보드가 검증해 거절해야 한다. 설정을 누르기 전에는 상태 조회 명령만 보낸다.

기존 48-byte binary 프레임은 8채널 공통 scan rate 하나만 전달하므로 서로 다른 채널 rate를 표현하지 않는다. 미래 보드가 개별 rate로 수집한다면 실제 배치를 채널별로 분리해 JSON readings로 전달하거나 별도 binary 확장 버전을 합의해야 한다. 백엔드가 누락된 샘플을 임의 생성하거나 rate만 바꿔 기록하지 않는다.

센서 목록에만 개별 sps가 있고 전체 sampling이 없으면 공통 scan rate로 채널 값을 덮어쓰지 않는다. 이 경우 전체값은 미수신으로 표시한다. 개별 채널 설정과 전체 DAQ 합계는 AI 질의의 상태 컨텍스트에도 포함된다.
