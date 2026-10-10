# v0.4 P0 AI 실행 경로

이 문서는 AI 모델 범위만 다룬다. DAQ 수집, 백엔드 설정 배포, HTTP 전송은 별도 팀의 소유다.

## 1. AI가 소비하는 센서 설정 스냅샷

`edge_config.SensorConfig.from_mapping()`에 다음을 제공한다.

```json
{
  "daq_uuid": "기존-DAQ-UUID",
  "equipment_id": "기존-장비-ID",
  "sensor_id": "기존-센서-ID",
  "sensor_type": "vibration|temperature|current|pressure",
  "source_unit": "V",
  "canonical_unit": "A",
  "calibration_scale": 1.0,
  "calibration_offset": 0.0,
  "channels": ["CH0"],
  "position_id": "설치-위치-ID",
  "profile_id": "설비/센서/위치/v1",
  "configuration_revision": "backend-revision",
  "min_sampling_rate_hz": 1000,
  "max_sampling_rate_hz": 2000,
  "window_seconds": 1.0,
  "stride_seconds": 0.5,
  "input_min": -10.24,
  "input_max": 10.24
}
```

`configuration_hash`는 이 값의 canonical hash이며 AI가 계산한다. 위치, 교정, 단위,
SPS 범위, 채널, profile 또는 revision이 바뀌면 hash가 바뀐다. 새 hash는 기존 모델이나
미완성 버퍼와 섞이지 않는다.

## 2. 프로필과 정상 데이터 후보

1. 전체 profile JSON을 만든 뒤 `bind_profile(profile, config)`로 config hash/revision을
   붙인다. profile은 canonical unit, channel 순서, window 길이 및 지원 SPS 범위가 config와
   정확히 맞아야 한다.
2. `WindowBuilder`는 raw chunk에 calibration을 **한 번** 적용해 `ModelWindow`를 만든다.
   SPS·sequence·timestamp·config hash가 바뀌면 부분 window를 버리고 이벤트를 낸다.
3. 운영자가 정상으로 승인한 `ModelWindow`만 `NormalWindowArchive.append(..., approved=True,
   approval_id=...)`로 저장한다. 이 archive는 NPZ와 config hash를 함께 쓴다.
4. 서로 겹치지 않는 session을 `train`, `calibration`, `test` 중 하나에 배정하여
   `build_manifest()`를 호출한다. `anomaly.py train`은 profile/manifest/window config hash가
   일치하지 않으면 거부한다.
5. 후보는 새 output directory에만 생성한다. validation이 아니라 calibration으로 threshold를
   정하고 held-out normal test의 false-alert rate를 평가한다.

## 3. 명시적 활성화와 지속 추론

```python
from activation import activate_candidate
from runtime import AnomalyRuntime

activate_candidate("candidates/current-if-001", config, "active/current.json")
runtime = AnomalyRuntime(config, "active/current.json")
records = runtime.ingest(raw_chunk)
```

Activation은 기존 activation record를 덮어쓰지 않는다. 활성화할 후보에는 동일 config hash가
profile에 결합되어 있어야 한다. `AnomalyRuntime`은 scorer를 한 번만 읽고, 결과를 유한 pending
queue에 둔다. 큐가 넘치면 `pending_dropped`를 올리며 오래된 결과를 보존한다고 주장하지 않는다.

`records`는 전송 전 로컬 AI 결과다. `status: error`는 입력 품질/설정/추론 오류이고 정상 판정이
아니다. HTTP payload 변환은 백엔드 팀이 현재 `edge_prediction_v0.3` 계약에 맞춰 담당한다.

## 4. 현장 적용 전 주의

- `source_unit`에서 `canonical_unit`으로의 scale/offset은 현장 교정값을 받아야 한다. 예제 숫자를
  운영값으로 쓰지 않는다.
- 25,600 SPS FEMTO/XJTU RUL 가중치는 10–2,000 SPS ADS8688 입력에 호환되지 않는다.
- 정상-only 후보는 고장 유형이나 RUL을 생성하지 않는다.
- 실제 센서·백엔드 E2E 검증 전에는 이 경로를 software-verified로만 표시한다.
