# v0.3.1 모델 구조와 학습 상태

이 문서의 기본 구조 설명은 v0.3에서 계승했습니다. v0.3.1에서는 XJTU-SY 별도 RUL 후보를 실제 학습했으며 [실험 결과](RESULTS_XJTU_RUL_V1.md)를 우선 참조하세요. 기존 FEMTO 후보는 재학습하지 않았고, 이상 탐지·고장 분류 가중치는 아직 없습니다.

확인일: 2026-10-10. **구현된 학습 파이프라인과 실제 데이터로 학습된 가중치는 다릅니다.** 아래는 저장된 코드·메타데이터·평가 결과를 확인한 상태입니다.

## 1. 전체 구조: 하나의 만능 모델이 아니라 세 개의 독립 과제

```text
센서별 고정 시간 구간 + 실제 sampling_rate_hz + 센서 프로필
    └─ 입력 검증 → 프로필 목표 rate로 resampling → 특징 추출
         ├─ Isolation Forest         → 정상 패턴에서 벗어났는가?
         ├─ Random Forest Regressor  → 검증된 고장 종점까지 몇 시간이 남았는가? (조건부)
         └─ Random Forest Classifier → 학습한 고장 유형 중 무엇과 비슷한가? (선택)
                    ↓
             predictive.py: 센서별 결과를 묶어 JSON 반환
                    ↓
             Backend: 로그/동기화/승인/활성화/정비 우선순위
```

세 모델은 **같은 프로필의 특징 표현을 사용하지만 가중치·정답·학습 데이터가 별개**입니다. 이상 점수를 RUL로 변환하거나, 분류 확률을 정비 긴급도로 변환하는 연결은 없습니다. `predictive.py`는 결과를 묶는 코드이지 학습된 센서 융합 모델이 아닙니다.

| 과제 | 질문 | 학습 정답 | v0.3 모델 | 실제 데이터 학습 상태 |
|---|---|---|---|---|
| 이상 탐지 | 평소 정상 운전과 얼마나 다른가? | 정상으로 승인됐다는 정보 | `IsolationForest` | 파이프라인 구현·합성 테스트 완료, 실제 DAQ 후보 없음 |
| RUL | 특정 부품의 고장 종점까지 남은 시간은? | 구간별 `remaining_useful_life_hours` | `RandomForestRegressor` | FEMTO 실데이터 후보 학습, 별도 validation/test 평가. [학습 기록](FEMTO_TRAINING.md) |
| 고장 유형 | 알려진 고장 패턴 중 무엇인가? | 전문가 확인 `label` | `RandomForestClassifier` | 파이프라인 구현·합성 테스트 완료, v0.3 실제 분류 모델 없음 |
| 이전 분류기 | AI Hub의 정상/4종 고장 중 무엇인가? | AI Hub `00`~`04` | **v0.1 `XGBClassifier`** | AI Hub 표본으로 학습된 가중치가 별도로 존재 |

## 2. 공통 입력·특징 추출

코드: [anomaly_features.py](anomaly_features.py), [features.py](features.py).

- `profile_id`마다 센서 종류, 단위, 채널 순서, 운전 조건, 구간 길이, 목표 rate, 허용 rate, 주파수 대역을 고정합니다.
- 원본 `samples[time, channels]`와 실제 `sampling_rate_hz`를 받고 목표 rate로 anti-alias 재표본화합니다. **가변 rate를 무조건 받는다는 뜻은 아닙니다.** 목표 rate 이상이고 설정 범위 안의 균일 샘플링이어야 합니다.
- `waveform`: 채널별 평균·표준편차·RMS·peak-to-peak·crest factor·왜도·첨도, FFT dominant frequency·centroid·entropy, 대역별 상대 에너지.
- `slow_series`: 느린 온도 등의 여러 관측값에서 평균·표준편차·최소·최대·마지막값·초당 기울기를 추출합니다. FFT는 하지 않습니다.
- 최소 목표 표본 4개. 단발 온도값이나 불규칙 timestamp는 현재 계약에서 지원하지 않습니다. 센서 추가/단위/채널 변경은 새 프로필·새 모델이 필요합니다.
- 진동·전류·온도는 각자 다른 rate·구간 길이·모델을 가질 수 있습니다. 채널 결합은 같은 프로필 안에서만 가능하며, 서로 다른 센서의 자동 시간 정렬·특징 융합은 구현하지 않았습니다.

## 3. Anomaly detection — 정상-only Isolation Forest

코드: [anomaly.py](anomaly.py).

**푸는 문제:** 현재 구간이 정상 학습 분포에서 이례적인지를 찾는 novelty detection입니다. 고장 전조뿐 아니라 부하 변경, 센서 이동, 교정 오류도 이례적으로 보일 수 있습니다. 이 모델만으로 고장 원인이나 미래 고장을 확정할 수 없습니다.

**학습:** Backend가 전문가 승인한 정상 누적 구간을 manifest로 전달합니다. train/calibration/test는 세션·파일이 겹치지 않아야 하며 각 최소 20구간입니다. train으로 Isolation Forest를 적합하고, calibration 정상 점수의 상위 분위수로 임계값을 정합니다. 기본 목표 구간 오경보율은 1%이지만 실제 test 오경보율이 반드시 1%라는 보장은 없습니다.

**경량 설정:** 64 trees, tree당 최대 256개 학습 표본, 한 CPU thread, seed 42, 분할당 기본 최대 5,000구간. 점수는 `-score_samples(X)`이며 클수록 이례적입니다.

**평가·출력:** 정상 test의 구간 오경보율·점수 분위수, `anomaly_score`, `threshold`, `is_anomaly`. 실제 고장 test가 없으면 fault recall을 알 수 없습니다. 현재 코드는 세션 분리이며 자산 분리를 강제하지 않으므로, 동일 설비의 새로운 세션 평가와 미관측 설비 평가를 구분해야 합니다.

## 4. RUL 수명 추정 — 지도학습 Random Forest 회귀

코드: [rul.py](rul.py).

**푸는 문제:** 특정 데이터셋·부품·운전 조건에서 현재 구간의 특징과 실제 고장까지 남은 시간의 관계를 회귀합니다. 정상-only 이상탐지의 연장선이 아니라 **다른 정답이 필요한 과제**입니다.

**학습:** 실제 고장 종점이 확인된 run-to-failure 이력에서 `RUL_hours = (failure_time - window_reference_time) / 3600`을 외부 어댑터가 생성합니다. 시간축·종료 기준·승인 진위는 Backend/데이터 어댑터가 검증해야 합니다. `failure_evidence: true`는 추적용 선언이지 코드가 물리적 고장을 증명한 결과가 아닙니다. train/test 및 선택적 validation 각각 최소 20구간·2개 자산이 필요하고 모든 분할 쌍의 자산·세션·파일을 분리합니다.

**경량 설정:** 64 trees, 최대 깊이 8, leaf당 최소 2개 표본, 한 CPU thread, 분할당 기본 최대 5,000구간(명시적 상한 50,000). FEMTO 실험은 분할 전체 평가를 위해 25,000으로 지정했습니다. 현재는 **한 구간의 특징을 입력**하며 장기 추세, 운전 누적 시간, 고장 모드별 survival model은 입력하지 않습니다. 따라서 현재 모델은 빠른 baseline이며, 특징만으로 수명 단계가 구별되지 않으면 성능이 낮을 수 있습니다.

**평가·출력:** held-out 자산 MAE/RMSE(시간), 자산별 평균 MAE, 학습 RUL 평균을 예측하는 단순 baseline과 비교합니다. 유효한 모델이 없으면 `estimated_rul_hours: null`, `status: unavailable`. 모델이 있으면 실험적 시간 추정값을 반환하지만 예측 구간은 보정되지 않았습니다. Random Forest는 학습된 수명 범위를 넘어선 신뢰할 만한 외삽 모델이 아닙니다.

**현재 미지원:** 고장 종점이 없는 censored 이력의 생존분석, 정상 데이터만으로 절대 RUL 생성, 센서별 RUL을 합친 설비 전체 RUL. 시험 베어링의 RUL을 발전기·차량·펌프 전체의 수명으로 표시하면 안 됩니다.

## 5. Error 원인 classification — 알려진 고장 유형 분류

코드: [fault.py](fault.py). 여기서 **원인**은 베어링 불량·불평형 등 **관측된 고장 유형**을 뜻합니다. 윤활 부족, 설치 실수, 과부하처럼 고장을 유발한 근본 원인을 인과적으로 규명하는 root-cause analysis는 아닙니다.

**학습:** 같은 프로필의 전문가 라벨 구간을 사용합니다. train/test 각 최소 20구간, 학습 클래스 2개 이상, 자산·파일 분리, test에 학습하지 않은 클래스가 있으면 거부합니다. 기본 64 trees, 최대 깊이 8, `class_weight="balanced"`, 한 thread입니다. 정상-only 기록으로 새로운 고장 유형 라벨을 자동 생성하지 않습니다.

**평가·출력:** Accuracy, Macro/Weighted F1, 클래스별 지표, confusion matrix와 클래스 확률 점수. 분류기는 학습한 클래스 중 하나를 선택하므로 미지 고장도 기존 클래스에 강제로 배정할 수 있습니다. 별도 이상탐지 결과와 함께 보여주되, 현재 통합 코드는 자동 unknown 거부 정책을 학습하지 않습니다. 확률은 미보정이며 미래 고장 발생 확률이 아닙니다.

**XGBoost와의 관계:** v0.1은 AI Hub 특징용으로 이미 학습된 XGBoost입니다. v0.3은 edge에 NumPy/SciPy/sklearn/joblib만 설치하는 경량 구성을 택해 선택적 분류기를 Random Forest로 구현했습니다. 기존 XGBoost를 지우거나 Random Forest로 재학습한 것이 아닙니다. 프로필·특징·단위가 다른 v0.1 가중치를 v0.3에 자동 연결하지 않습니다.

## 6. 지금 학습된 AI Hub 데이터의 역할

로컬 확인: `outputs/aihub/*/models/metadata.json`, `metrics/{split,test}.json`, `versions/v0.1/ARTIFACT_HASHES.json`. 추가로 FEMTO RUL 후보는 `outputs/v0.3/femto_rul_v1/`에 저장합니다. 실제 DAQ 정상-only 후보와 v0.3 고장 분류 후보는 아직 없으며, 합성 테스트의 임시 모델은 제품 가중치가 아닙니다.

| 실제 학습 실험 | 사용 표본 | 역할 | 내부 test Macro F1 |
|---|---:|---|---:|
| v0.1 전류, 모터 분리 | 클래스당 2,000건, 총 10,000건 | 미관측 모터 분류의 어려움 확인 | 0.0642 |
| v0.1 전류, 모터+날짜 프록시 분리 | 같은 표본 규모 | 동일 설비의 새 수집 구간 분류 baseline | 0.9591 |
| v0.1 진동, 모터 분리 | 클래스당 500건, 총 2,500건 | 미관측 모터 분류 baseline | 0.3108 |
| v0.1 진동, 모터+날짜 프록시 분리 | 같은 표본 규모 | 동일 설비의 새 구간 baseline | 0.7906 |

전류는 2kHz·1초·3채널→39개 특징, 진동은 4kHz·3초·1채널→13개 특징입니다. 정상/베어링/불평형/축정렬/벨트 5-class 진단을 학습했습니다. 전체 원본 데이터 학습이 아니라 표본 실험입니다. 공식 Validation은 Training과 같은 모터를 포함하므로 높은 점수를 미관측 설비 일반화로 해석하지 않습니다. 상세 한계는 [루트 README](../../README.md)에 있습니다.

**이 가중치가 하는 일:** 기존 AI Hub 입력 조건에서 분류 baseline 제공. **하지 않는 일:** 현장 DAQ 정상 기준 학습, RUL 학습, v0.3 가중치 초기화, 새로운 센서 자동 지원. 향후 AI Hub 정상 클래스는 v0.3 이상탐지 학습 후보, 고장 클래스는 탐지 평가/분류 학습 후보가 될 수 있지만 NPZ 어댑터·단위 확인·프로필 정합성 검증이 먼저 필요합니다.

## 7. 학습·재학습 운용 경계

전문가 승인 → Backend가 데이터 범위·manifest 준비 → edge에서 모델별 `train` → 새 후보 폴더 저장 → 성능 검토 → Backend가 활성화. 스스로 재학습하거나 기존 후보를 덮어쓰지 않습니다. 모델만으로 통신, 로그 누적, 단절 시 저장, 재연결 동기화, 부품/인력 우선순위까지 수행하지 않습니다.

다음 문서: [데이터셋 활용 전략](DATASET_STRATEGY.md), [정확한 입출력 계약](INPUT_OUTPUT.md), [배포](DEPLOYMENT.md).
