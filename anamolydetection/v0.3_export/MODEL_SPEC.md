# v0.3 — 센서별 예측정비 모델 스냅샷 (현재 메인)

상세 설명: [모델 구조·학습 방식·실제 학습 상태](MODEL_ARCHITECTURE.md) · [데이터셋 검증 및 우선순위](DATASET_STRATEGY.md).

## 책임과 한계

| 기능 | 모델/학습 입력 | 현재 상태 |
|---|---|---|
| 이상 탐지 | 정상-only Isolation Forest, 승인된 정상 구간 | 구현. 점수는 고장 확률이 아니며 정상 test의 구간 오경보율만 검증 가능 |
| RUL | Random Forest 회귀, 실제 고장 종점이 확인된 run-to-failure 이력과 각 구간의 `remaining_useful_life_hours` | 학습·추론 경로 구현. 해당 이력이 없으면 `unavailable`; 정상-only 데이터로 숫자를 만들어내지 않음 |
| 고장 유형 (선택) | Random Forest 분류, 동일 센서 프로필에 맞는 전문가 확인 라벨 | 학습·추론 경로 구현. 호환 라벨 모델이 없으면 `unavailable`; v0.1 AI Hub XGBoost를 임의 센서에 적용하지 않음 |

각 `profile_id`는 **센서 종류·단위·채널 순서·설비/운전 조건**을 구분합니다. 서로 다른 진동/전류/온도 센서는 각각의 프로필과 모델을 갖습니다. `edge_window_v2` 특징 추출기는 `waveform`(FFT 포함)과 `slow_series`(평균·표준편차·최솟값·최댓값·마지막값·초당 기울기; FFT 없음)를 지원합니다. 원본 sample rate는 프로필의 범위 안에서 가변이고 목표 rate로 anti-alias 재표본화합니다. **균일 간격·고정 길이 구간**만 지원하며 비동기·불규칙 timestamp, 단발 온도값, 목표 rate보다 낮은 rate는 거부합니다. 느린 온도는 여러 읽기를 하나의 구간으로 묶어야 합니다. 최소 목표 4개 표본이 필요합니다.

RUL 숫자는 **훈련 집단에서 관찰한 고장 종점과 운전 조건의 범위 안에서만 실험적 추정**입니다. 임의 설비/고장 모드로 일반화되지 않습니다. 여러 센서의 RUL을 최소값 등으로 합치는 설비 단위 추정기는 없습니다. 센서별 추정 결과만 반환하고 설비 RUL은 `unavailable`입니다. 정비 우선순위는 부품 재고·임무 중요도·조치 비용 등 정책 정보가 필요하므로 backend가 판단합니다. 모델 확률/점수를 우선순위나 미래 고장 확률로 해석하지 않습니다.

RUL·고장 분류 평가는 자산 ID를 train/test에 중복하지 않습니다. 이상탐지는 세션 ID만 train/calibration/test에 중복하지 않으므로 동일 설비의 새로운 세션에 대한 정상 오경보 평가이며 미관측 설비 일반화 근거는 아닙니다. 가벼운 노트북/AM6442 CPU 기본값은 각 모델 64 trees, 한 스레드, 분할당 최대 5000 구간입니다. RUL·고장 분류의 최대 깊이는 8이고 Isolation Forest는 tree당 최대 256개 학습 표본을 사용합니다. FEMTO run-to-failure는 [별도 학습·validation/test 실험](FEMTO_TRAINING.md)으로 평가합니다. RUL 상한은 명시적으로 50,000까지 허용합니다. 실제 DAQ 및 AM6442 지연·메모리·성능은 **아직 검증되지 않았습니다**. 합성 테스트는 인터페이스 검증이지 예지 성능 증거가 아닙니다.

v0.1/v0.2 스냅샷은 변경하지 않습니다. v0.3 자체는 Python 3.13 Linux/AArch64에서 `requirements-edge.txt`의 wheel 설치가 가능할 때 운영 후보입니다. `joblib`는 신뢰 가능한 로컬 후보에만 로드하고 학습/추론의 sklearn·NumPy 버전을 일치시켜야 합니다. 승인 인증, 로깅, 로컬 누적, 재연결 동기화, 후보 활성화·롤백은 backend 담당입니다.

자세한 필드와 명령: [INPUT_OUTPUT.md](INPUT_OUTPUT.md).
