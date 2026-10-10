# v0.2-curr — 현재 메인 정상-only 이상탐지 모델

AM6442 설치·학습·추론 절차: [DEPLOYMENT.md](DEPLOYMENT.md).

## 역할

승인된 **정상 데이터만** 이용해 edge에서 Isolation Forest 후보를 학습하고, 새 구간에 대해 정상 패턴과의 차이를 점수화합니다. 기존 `v0.1` XGBoost 5종 고장 분류기는 별도로 보존합니다. 이 모델의 이상 점수는 고장 확률·고장 유형·정비 우선순위가 아닙니다. 아직 실제 DAQ 또는 AM6442에서 학습된 모델 산출물은 없습니다.

## 모델 및 특징 사양

| 항목 | 현재 구현 |
|---|---|
| 프로필 단위 | `profile_id`별 개별 모델. 센서 종류·단위·채널 순서·설비/운전 조건·특징 스키마를 프로필로 구분 |
| 원본 구간 | `[time, channels]` 정상 파형, 가변 `sampling_rate_hz` |
| rate 정규화 | 프로필의 `target_sample_rate_hz`로 `scipy.signal.resample_poly` 적용. 목표 rate보다 낮거나 허용 범위 밖이면 거부 |
| 구간 길이 | 프로필의 고정 `window_seconds`; 기대 샘플 수·선택적 timestamp 간격 확인 |
| 특징 | 채널당 mean, std, RMS, peak-to-peak, crest factor, skewness, kurtosis, FFT dominant frequency, spectral centroid/entropy, 고정 Hz 대역별 상대 에너지 |
| 학습기 | `sklearn.ensemble.IsolationForest`, 기본 64 trees, tree당 최대 256 표본, 1 CPU thread, seed 42 |
| 데이터 제한 | 분할별 기본 최대 5,000 구간 무작위 표본; 최소 train/calibration/test 각 20구간 |
| 점수 | `anomaly_score = -score_samples(X)`, **클수록 이례적** |
| 임계값 | 정상 calibration 점수의 `1 - target_window_fpr` 분위수. 기본 목표 구간 오경보율 1% |
| 평가 | 분리한 정상 test의 구간 오경보율·점수 분위수. 실제 고장 탐지율은 산출 불가 |
| 저장 | `joblib` 후보 + 프로필/메타데이터/정상 평가. runtime sklearn·NumPy 버전 다르면 로드 거부 |

`examples/edge_profile.json`은 형식 예시일 뿐 특정 DAQ의 교정/단위를 검증한 설정이 아닙니다. `feature_schema_version=edge_waveform_v1`이 맞아야 합니다. 서로 다른 센서나 낮은 Nyquist를 가진 데이터에 동일 특징 벡터를 강제로 사용하지 않습니다. 원시 로그 누적·범위 선택·승인 인증·서버 통신·활성 모델 교체는 backend 담당입니다. `approval_id`는 추적값이지 권한 증명이 아닙니다.

이 폴더는 루트 `anomaly.py`, `anomaly_features.py`, `features.py`와 edge 의존성/예시를 복사한 **v0.2-curr 소스 스냅샷**입니다. 중복 테스트 모듈 충돌을 피하기 위해 테스트는 루트 `12_ai_dev/tests/test_anomaly.py`에서 관리합니다. CPU/RAM/학습시간/추론지연은 실제 AM6442에서 아직 검증하지 않았습니다.
