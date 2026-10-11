# 보드 이상 탐지 학습 연동 계약

이 문서는 **신규 백엔드 HTTP 계약**이다. 기존 DAQ TCP 데몬에 학습 명령이나 폴링을 자동 추가하지 않는다. 보드 담당자가 학습 에이전트를 연결해야 실제 학습이 시작된다. 웹의 요청 대기 상태는 학습 완료를 뜻하지 않는다.

현재 역할은 다음과 같다.

- 웹: 센서 요약 신호, 정상 기간 선택·데이터 검토·승인, 학습 요청, 후보 검증 지표 검토, 적용·롤백 승인, 이상 탐지 결과 표시.
- 백엔드: 승인 이력과 센서 설정 바인딩, 요청 큐, 보드 결과 검증, 모델 적용 확인 상태, 운영 로그.
- 보드: 승인 기간의 원본 확보, 센서 프로필 선택, 고정 길이 균일 구간 생성, 정합성·분할 검증, 실제 학습, 후보 저장·검증, 명시적으로 승인된 모델 적용과 추론.

`anamolydetection/v0.4_export/anomaly.py`, `edge_config.py`, `window_builder.py`, `activation.py`의 정상-only 학습·후보 활성화 구조를 참조한다. `v0.5-current-only` 결과를 연결한다면 보드 담당자가 아래 표준 결과 형식으로 변환한다. 이 작업에서는 ML 학습기와 DAQ 펌웨어를 수정하지 않았다.

## 웹 API

| 요청 | 목적 |
|---|---|
| `GET /api/sensors/:sensorId/window?maxPoints=400` | 최대 400점 피크 보존 요약 신호. Raw 전체를 브라우저로 전달하지 않음 |
| `GET /api/sensors/:sensorId/diagnoses?limit=20` | 최신순 판정 이력 |
| `GET /api/sensors/:sensorId/training-readiness?from=ISO&to=ISO` | 서버 보관·복구 데이터의 기간 미리보기, 원본 수, 예상 윈도우, 기간 내 주의·위험 판정 |
| `POST /api/sensors/:sensorId/normal-ranges` | `{from,to,confirmNormal:true,acceptIntegrity:true}`로 운영자 정상 승인 기록 |
| `GET /api/sensors/:sensorId/anomaly-training` | 승인 이력, 요청 이력, 후보 요약 지표, 현재 센서 바인딩 해시 |
| `POST /api/sensors/:sensorId/anomaly-training` | `{approvalId}`로 승인 기간의 보드 학습 요청 생성. 동일 승인 요청 중복 방지 |
| `POST /api/anomaly-training/:jobId/activate` | `{confirmActivation:true}`로 검토한 후보 적용 또는 이전 모델 롤백 요청 |

기간은 시간대 포함 ISO 8601이다. 화면 입력은 KST다. 센서 위치·채널·단위·보정·장비 연결이 변경되면 이전 바인딩의 정상 승인과 후보 적용을 거부한다. 이전 승인은 이력에 남고, 새 설정으로 다시 승인할 수 있다.

## 보드 API

`EDGE_API_TOKEN`을 설정한 서버에서는 기존 Edge API와 동일하게 `Authorization: Bearer <token>`을 사용한다. `approvalId`나 `bindingHash`는 인증 정보가 아니다. 현재 운영자 API는 기존 대시보드와 동일한 신뢰된 LAN MVP 범위이며 사용자 계정·역할 인증은 추가하지 않는다.

### 1. 요청 조회

`GET /api/edge/training-jobs?daqUuid=BOARD_UUID`

응답의 `data` 배열에서 자신의 요청을 읽는다. 정상 데이터 요청의 주요 필드는 다음과 같다.

```json
{
  "schemaVersion": "fieldlink.edge-training.v1",
  "action": "train",
  "id": "job UUID",
  "daqUuid": "board UUID",
  "sensorId": "dashboard sensor ID",
  "approvalId": "normal approval ID",
  "from": "2026-10-11T00:00:00.000Z",
  "to": "2026-10-11T00:10:00.000Z",
  "bindingHash": "backend metadata SHA-256",
  "binding": {
    "sensorId": "dashboard sensor ID",
    "daqUuid": "board UUID",
    "equipmentId": "equipment ID or null",
    "channel": "CH0",
    "type": "vibration",
    "position": "bearing housing",
    "inputUnit": "V",
    "unit": "mm/s",
    "scale": 1,
    "offset": 0
  },
  "dataLabel": "normal",
  "rawSource": "daq_ring",
  "minimumWindowsPerSplit": 20,
  "splitPolicy": "disjoint_sessions_and_files",
  "serverDataUrl": "/api/edge/training-jobs/JOB_UUID/data?daqUuid=BOARD_UUID"
}
```

위 식별자와 숫자는 형식 예시다. `bindingHash`는 백엔드 센서 메타데이터 바인딩이며, ML `SensorConfig.configuration_hash`와 다른 해시다. 보드는 요청의 바인딩을 유지하고 모델 프로필의 ML 설정 해시를 별도로 검증·보고한다.

서버에는 최근 데이터 캐시와 복구 아카이브만 존재한다. `serverDataUrl`은 `JSONL.gz` **서버 미리보기 데이터**를 반환하며 전체 승인 기간의 원본 확보를 보장하지 않는다. 보드는 승인 기간의 원본을 자신의 링 또는 검증된 원본 보관소에서 확보해야 한다. 누락·겹침·rate 변경·단위/채널/프로필 불일치는 임의 보간이나 정상 판정으로 숨기지 않는다.

### 2. 학습 시작·실패 보고

`POST /api/edge/training-jobs/:jobId/report`

```json
{
  "daqUuid": "board UUID",
  "bindingHash": "request bindingHash",
  "status": "training"
}
```

실패는 `status:"failed"`, `error:"실제 실패 사유"`를 보낸다. 보드가 요청을 수신하지 않으면 웹은 계속 요청 대기로 표시한다. 실제 학습을 시작하기 전에 데이터 검증을 수행하고 매번 새 후보 출력 디렉터리를 사용한다.

### 3. 후보 보고

같은 보고 API에 `status:"candidate"`와 `candidate`를 전달한다.

| candidate 필드 | 의미 |
|---|---|
| `modelVersion` | 실제 후보 모델 버전 |
| `profileId` | 실제 센서 프로필 ID |
| `configurationHash` | ML 설정 해시. v0.4 프로필·설정 바인딩 검증 결과 |
| `threshold` | 정상 calibration으로 결정한 유한한 임계값 |
| `normalTestFalseAlarmRate` | 정상 test의 오경보율, 0~1. 고장 탐지율이나 미래 고장 확률 아님 |
| `datasetDigest` | 사용한 데이터/manifest의 검증 해시 |
| `splits.train` / `splits.calibration` / `splits.test` | 아래 분할 정보 |

각 분할은 `{windows, sessions, files}`를 담는다. `windows`는 실제 사용한 구간 수이며 최소 20, `sessions`는 중복 없이 나열한 실제 세션 ID 배열, `files`는 각 실제 NPZ 구간의 정규화된 파일 식별자 배열이다. `files.length`가 `windows`와 같아야 한다. 모든 분할 쌍에서 세션·파일 중복을 거부한다. 한 수집 세션을 임의로 세 세션으로 이름만 바꾸어 분리하면 안 된다.

보드는 실제 파일 존재·내용·rate·시간축·프로필·해시·정상 승인 범위를 ML 계약대로 검증한다. 백엔드는 보고한 분할·식별자·지표·현재 센서 바인딩을 검증하지만 보드 파일시스템을 직접 읽어 파일의 존재를 증명하지는 않는다. 후보 보고는 자동 활성화를 수행하지 않는다.

### 4. 명시적 적용·롤백

운영자가 지표를 검토하고 적용을 승인하면 조회 응답에 `action:"activate"` 또는 `"rollback"`, `activationRequestId`, 후보 요약 정보가 들어온다. 보드는 승인된 버전과 `configurationHash`를 검증하고 새 활성화 기록을 작성한 뒤 scorer/worker를 해당 모델로 전환한다. 활성화 기록만 쓰고 실행 모델이 바뀌지 않은 상태에서 성공을 보고하지 않는다.

적용을 확인한 뒤 아래를 보고한다.

```json
{
  "daqUuid": "board UUID",
  "bindingHash": "request bindingHash",
  "status": "active",
  "activationRequestId": "current request ID",
  "modelVersion": "candidate model version",
  "configurationHash": "candidate ML configuration hash"
}
```

요청 ID·모델 버전·설정이 일치한 응답을 받을 때만 백엔드는 활성 상태로 바꾸며 이전 모델은 이력에 남긴다. 롤백도 새 요청 ID를 발급하고 보드 확인이 필요하다. 적용 실패 보고에는 현재 `activationRequestId`와 `error`를 포함한다. 실패하면 기존 활성 모델을 유지한다.

### 5. 추론 결과

모델 적용 후 추론 결과는 기존 `POST /api/edge/frames` 경로와 현재 collector의 이상 탐지 결과 전달 흐름을 유지한다. v0.3 예측 형식을 사용하면 `profile_id`, `model_version`, `anomaly_score`, `threshold`, `is_anomaly`를 전달한다. 센서 ID·채널의 기존 매핑 규칙을 따른다. 학습 완료나 활성화 응답 자체로 진단 데이터를 만들어 넣지 않는다.

## 상태 흐름

`queued → training → candidate → activation_requested → active`

학습 실패는 `failed`, 적용 실패는 후보 검토 상태로 돌아가고 실패 사유를 표시한다. 모델 교체 후 이전 모델은 `superseded`로 남아 검토 후 롤백할 수 있다. `demo:true`는 모의 요청이며 실제 보드에서 학습했다는 의미가 아니다.
