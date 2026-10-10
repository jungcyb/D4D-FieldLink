# v0.3.1 참고: XJTU-SY 2채널 25.6kHz/1.28초 프로필과 원본 단위 미검증 상태는 [실험 결과](RESULTS_XJTU_RUL_V1.md)를 우선 참조하세요. 아래 계약은 v0.3에서 계승한 공통 인터페이스입니다.

# v0.3 입력·출력 계약

## 1. 센서 입력

센서마다 별도 프로필 JSON을 사용합니다. 필수 키는 `profile_id`, `feature_schema_version: "edge_window_v2"`, `feature_mode` (`waveform` 또는 `slow_series`), `sensor_type`, `unit`, 순서 있는 `channels`, `window_seconds`, `target_sample_rate_hz`, `min_sample_rate_hz`, `max_sample_rate_hz`, `frequency_bands_hz`입니다. 진동/전류 예시는 [edge_profile.json](examples/edge_profile.json), 느린 온도 이력 예시는 [temperature_profile.json](examples/temperature_profile.json). **예시 값은 실제 DAQ 교정값이 아닙니다.** 각 센서는 별도로 학습합니다.

한 구간은 `.npz`로 전달합니다: `samples` = 유한한 숫자 `[time, channels]`, `sampling_rate_hz` = **실제** 균일 샘플링 rate, `sensor_type`, `unit`, `profile_id` 문자열, `channels` 문자열 배열. 선택적 `timestamps`는 초 단위 `[time]`이며 `1/fs` 간격이어야 합니다. 길이는 `window_seconds * sampling_rate_hz`와 맞아야 하고 목표 rate 이상·설정 범위 안이어야 합니다. 이 계약은 불규칙 이벤트 스트림이나 단일 온도 관측값을 직접 수용하지 않습니다. Backend/DAQ adapter가 센서별 동일 시간축의 고정 길이 구간을 생성해야 합니다.

## 2. 학습 입력 (승인 후, 모델별 별도 후보)

### 정상-only 이상 탐지

`anomaly.py train --profile PROFILE.json --manifest NORMAL.json --output-dir CANDIDATE_DIR`. `NORMAL.json`은 `profile_id`, `approval_id`, `data_label: "normal"`, `train`/`calibration`/`test` 배열을 포함합니다. 각 구간은 `path`, `session_id`가 필요하고 분할 사이 세션·파일이 중복되면 안 됩니다. 각 분할 최소 20구간. 임계값은 calibration 정상 점수의 상위 분위수로 결정하며 test는 **정상 구간 오경보율만** 측정합니다. 후보는 자동 활성화되지 않습니다.

### 선택적 RUL

`rul.py train --profile PROFILE.json --manifest RUL.json --output-dir CANDIDATE_DIR`. `RUL.json`은 `profile_id`, `approval_id`, `data_label: "run_to_failure"`, `failure_evidence: true`, `train`/`test` 배열과 선택적 `validation` 배열을 포함합니다. 각 항목은 `path`, `session_id`, `asset_id`, `remaining_useful_life_hours` (0 이상 실수)가 필요합니다. 모든 분할 쌍에서 **자산·세션·파일**이 분리되어야 하며, 각 분할 최소 20구간·2자산입니다. 단순 정상 시점만으로 RUL 라벨을 생성하면 안 됩니다. 고장 발생·종료 시간과 각 구간 시각으로 라벨을 외부에서 검증해야 합니다. 실제 고장 종점이 없는 right-censored 자료는 이 MVP 학습기로 처리하지 않습니다. 출력은 후보 `model.joblib`, `profile.json`, `metadata.json`, `metrics.json` 및 분할별 `metrics_validation.json`/`metrics_test.json`, 예측/자산별 CSV와 PNG 그래프입니다. `metrics.json`은 test 지표 호환 사본입니다. 기본 상한은 분할당 5,000구간이며 `--max-windows-per-split`으로 최대 50,000까지 명시할 수 있습니다. 모델은 train에만 fit하고 validation/test로 자동 튜닝하지 않습니다. [FEMTO 라벨·프로필·학습](FEMTO_TRAINING.md)을 참조하세요.

### 선택적 고장 유형

`fault.py train --profile PROFILE.json --manifest FAULT.json --output-dir CANDIDATE_DIR`. `FAULT.json`은 `profile_id`, `approval_id`, `train`/`test` 배열을 포함합니다. 각 항목은 `path`, `session_id`, `asset_id`, `label` (전문가 확인 클래스 문자열)이 필요합니다. 자산 그룹을 분리하고 학습에 없는 라벨의 test 평가는 거부합니다. 출력은 후보 모델·프로필·메타데이터·분류 평가입니다. `probabilities`는 미보정 모델 점수이고 미래 고장 확률이 아닙니다.

세 학습기 모두 매번 **새 `output-dir`**를 사용합니다. `approval_id` 자체는 권한 검증이 아닙니다. Backend가 승인, 기간/범위, 데이터 정합성, 후보 활성화·롤백을 관리합니다.

## 3. 추론 입력

`predictive.py --manifest EQUIPMENT.json` 한 번으로 센서별 구간을 평가합니다. 경로는 manifest 디렉터리 기준 상대/절대 경로입니다.

```json
{
  "equipment_id": "pump-01",
  "sensors": [
    {"sensor_id": "vibration", "anomaly_model_dir": "models/vibration-anomaly", "input_npz": "windows/vibration.npz", "rul_model_dir": "models/vibration-rul", "fault_model_dir": "models/vibration-fault"},
    {"sensor_id": "temperature", "anomaly_model_dir": "models/temperature-anomaly", "input_npz": "windows/temperature.npz"}
  ]
}
```

`rul_model_dir`, `fault_model_dir`는 선택입니다. 지정한 모델의 프로필이 이상탐지 모델과 **완전히 일치**하지 않으면 오류로 중단합니다. 구간 정체성·채널·단위·rate 불일치도 오류이지 정상 판정이 아닙니다. 실제 스트림에서는 센서별 scorer를 한 번 로드하여 구간마다 재사용해야 합니다.

## 4. 추론 출력

아래 숫자는 **형식 예시**이며 실제 모델 결과가 아닙니다.

```json
{
  "schema_version": "edge_prediction_v0.3",
  "equipment_id": "pump-01",
  "sensors": {
    "vibration": {
      "profile_id": "pump-01/vibration/steady/v1",
      "anomaly_detection": {"status": "ok", "profile_id": "pump-01/vibration/steady/v1", "model_version": "if-001", "anomaly_score": 0.62, "threshold": 0.59, "is_anomaly": true},
      "rul": {"status": "available", "estimated_rul_hours": 120.0, "uncertainty_status": "not_calibrated"},
      "fault_classification": {"status": "ok", "predicted_class": "bearing_fault", "probabilities": {"normal": 0.1, "bearing_fault": 0.9}, "probabilities_calibrated": false}
    },
    "temperature": {
      "profile_id": "pump-01/temperature/steady/v1",
      "anomaly_detection": {"status": "ok", "profile_id": "pump-01/temperature/steady/v1", "model_version": "if-002", "anomaly_score": 0.4, "threshold": 0.59, "is_anomaly": false},
      "rul": {"status": "unavailable", "estimated_rul_hours": null, "reason": "no_approved_run_to_failure_model"},
      "fault_classification": {"status": "unavailable", "reason": "no_compatible_labeled_fault_model"}
    }
  },
  "equipment_rul": {"status": "unavailable", "reason": "no_equipment_level_fusion_model"},
  "maintenance_priority": {"status": "not_computed", "owner": "backend_policy"}
}
```

`anomaly_score`는 미보정 점수입니다. RUL은 정상-only 모델에서 나오지 않습니다. 결측 RUL은 0시간이나 무한대가 아니라 `null`입니다. 설비 전체 RUL과 정비 우선순위는 이 버전에서 숫자를 발명하지 않습니다.

