# v0.2-curr Isolation Forest — 입력·출력 계약

## 1. 센서 프로필 JSON

필수 키: `profile_id`, `feature_schema_version`(`edge_waveform_v1`), `sensor_type`, `unit`, `channels`(순서가 있는 비어 있지 않은 문자열 배열), `window_seconds`, `target_sample_rate_hz`, `min_sample_rate_hz`, `max_sample_rate_hz`, `frequency_bands_hz`(고정 Hz `[low, high]` 배열). [examples/edge_profile.json](examples/edge_profile.json)을 참조하세요. `target_sample_rate_hz <= min_sample_rate_hz <= max_sample_rate_hz`, 모든 주파수 대역 상한 `<= target_sample_rate_hz/2`, `window_seconds * target_sample_rate_hz` 정수 4 이상이어야 합니다.

## 2. 정상 구간 NPZ

Backend가 선택·승인한 각 구간은 `.npz` 하나로 전달합니다.

| 키 | 형태 | 의미 |
|---|---|---|
| `samples` | `float` 배열 `[time, channels]` | 프로필 순서의 동일 단위 파형 |
| `sampling_rate_hz` | 양의 숫자 스칼라 | 구간의 **실제** 샘플링 주파수 |
| `sensor_type`, `unit`, `profile_id` | 문자열 스칼라 | 프로필과 정확히 일치해야 함 |
| `channels` | 문자열 1차원 배열 | 프로필 채널 순서와 정확히 일치해야 함 |
| `timestamps` | 선택, 초 단위 숫자 배열 `[time]` | 있으면 일정한 `1/fs` 간격인지 검사 |

형식 생성 예:

```python
import numpy as np
np.savez("window.npz", samples=window_array, sampling_rate_hz=2000,
         sensor_type="current", unit="A", channels=np.array(["phase_a", "phase_b", "phase_c"]),
         profile_id="example_motor/current/steady/v1", timestamps=sample_times_seconds)
```

빈 값, NaN/무한대, 채널·단위 불일치, 허용하지 않는 rate, 구간 길이/시간간격 불일치는 **오류**입니다. 정상으로 조용히 판정하지 않습니다.

## 3. 재학습 입력 manifest

Backend가 승인된 **누적 정상 기록의 범위**를 선택하여 manifest JSON을 생성합니다. 필수 `profile_id`, 비어 있지 않은 `approval_id`, `data_label: "normal"`, `train`/`calibration`/`test` 배열입니다. 각 항목은 `path`(manifest 기준 상대 또는 절대 `.npz`)와 `session_id`가 필요합니다. 세 분할 사이 중복 경로·세션은 금지합니다. 누적 기록 중 선택할 범위와 시간 순서 분할은 backend가 결정합니다.

```json
{
  "profile_id": "example_motor/current/steady/v1",
  "approval_id": "approved-request-001",
  "data_label": "normal",
  "train": [{"path": "windows/train_001.npz", "session_id": "session-1"}],
  "calibration": [{"path": "windows/cal_001.npz", "session_id": "session-2"}],
  "test": [{"path": "windows/test_001.npz", "session_id": "session-3"}]
}
```

위 예시는 분할별 최소 20구간 조건을 만족하지 않아 **그대로는 실행되지 않습니다**. `approval_id`의 진위·권한은 이 파이프라인이 확인하지 않습니다. backend가 승인 명령과 범위를 검증한 뒤 호출해야 합니다.

## 4. 학습 명령 및 출력

```bash
python3.13 anomaly.py train --profile examples/edge_profile.json \
  --manifest /data/approved_manifest.json --output-dir /data/candidates/iforest-v1
```

`--max-windows-per-split`(기본 5000), `--n-estimators`(64), `--target-window-fpr`(0.01), `--seed`(42)를 조절할 수 있습니다. 새 승인 범위로 **새 output-dir**를 지정하면 재학습 후보가 생성됩니다. 기존 출력 폴더는 덮어쓰지 않으며 후보를 자동 활성화하지 않습니다.

| 출력 파일 | 내용 |
|---|---|
| `model.joblib` | 정상-only Isolation Forest 후보 |
| `profile.json` | 학습에 사용한 정확한 프로필 |
| `metadata.json` | 후보 상태, approval/profile ID, 특징 순서, score 방향, 임계값, runtime 버전, 표본 수 |
| `metrics.json` | 정상 test 구간 오경보율과 calibration/test 점수 분위수. 고장 탐지율 없음 |
| `normal_test_scores.csv` | 정상 test의 구간별 점수·임계값·판정 |

## 5. 추론 입력 및 출력

```bash
python3.13 anomaly.py score --model-dir /data/candidates/iforest-v1 --input-npz /data/new_window.npz
```

장시간 스트림 서비스에서는 `AnomalyScorer(model_dir)`를 **한 번만 생성**하고, 매 구간 `scorer.score(samples, sampling_rate_hz, timestamps=None)`를 호출합니다. 반환 예시(숫자는 임의):

```json
{"status":"ok","profile_id":"example_motor/current/steady/v1","model_version":"iforest-v1","anomaly_score":0.62,"threshold":0.59,"is_anomaly":true}
```

`is_anomaly`는 **단일 구간** 판정입니다. 연속 구간 경보·시간당 경보·정비 조치 규칙은 backend/운영 계층에서 결정합니다. `model_version`은 후보 출력 폴더 이름이며 고정 모델 아키텍처 버전 `v0.2-curr`와 다릅니다. 입력 오류는 예외/CLI 비정상 종료로 반환하며 정상 판정을 출력하지 않습니다. 점수는 보정된 확률이 아닙니다.
