# v0.3 데이터셋 활용 전략 — RUL·이상 탐지·고장 유형

확인일: **2026-10-10**. 공식 데이터 설명·저자 논문·저장소 README를 재확인한 결과입니다. **외부 원본 전체 다운로드, 파일 파싱, 혼합 학습, 성능 향상 검증을 완료했다는 뜻은 아닙니다.** 기존 AI Hub 표본 기반 v0.1 외에 FEMTO RUL v0.3 실데이터 후보를 추가했습니다. [라벨 근거·학습 기록](FEMTO_TRAINING.md)을 참조하세요.

**다운로드 완료 후 우선순위 갱신:** FEMTO와 KAIST HVAC가 확보되어 AI Hub와 함께 프로젝트 `data/raw/`로 이동했습니다. 따라서 RUL은 **이미 확보한 FEMTO 진동 데이터부터** 진행하고, XJTU-SY는 추가 다운로드 필수가 아닌 후속 독립 검증 후보로 둡니다. 아래 최초 비교표보다 이 가용성 기준이 우선합니다. 실물 검사·누락 온도·Test/Full_Test 자산 중복 주의는 [LOCAL_DATASETS.md](../../LOCAL_DATASETS.md)에 기록했습니다.

## 1. 이전 추천에서 바뀌는 결론

목표가 5-class 분류에서 **정상-only 이상 탐지 + RUL + 선택적 고장 분류**로 바뀌었습니다. 따라서 이전의 “XJTU-SY는 이번에는 받지 않아도 됨”은 더 이상 맞지 않습니다.

**우선 조합은 `현장 DAQ 정상 데이터 + 기존 AI Hub + XJTU-SY`입니다.** 이들을 한 학습 테이블에 무조건 합치는 것이 아니라 서로 다른 역할로 사용합니다.

| 우선순위 | 데이터 | 지금 필요한 이유 |
|---|---|---|
| **P0 필수 수집** | 실제 저가 센서/DAQ의 전문가 승인 정상 기록 | 실제 배포 설비·부착 위치·운전 조건의 Isolation Forest 기준 학습. 공개 데이터로 대체되지 않음 |
| **P0 유지** | 이미 받은 AI Hub 238 | 알려진 고장 분류 baseline, 정상 학습/고장 평가의 이상탐지 실험 |
| **P0 신규 확보** | **XJTU-SY** | 실제 run-to-failure 베어링 이력으로 RUL 학습·평가 |
| **P1 하나 선택** | 2026 회전기계 또는 KAIST HVAC | 진동·전류·온도 데모면 전자, 벨트/심각도 데모면 후자 |
| **P1 예비** | FEMTO/PRONOSTIA | XJTU-SY 확보 실패 시 대안 또는 별도 베어링 RUL 검증 |
| P2 / 후순위 | KAIST AC, NLN-EMP, UTK, IMS | 운전 조건·펌프·요약지표·추가 열화 연구가 필요할 때 |
| 이번 핵심 범위 제외 | DCASE, C-MAPSS | 각각 음향 전용, 터보팬 시뮬레이션. 현재 IMU/전류/온도 모델의 직접 대체가 아님 |

## 2. 후보별 확인 결과와 수정된 용도

### AI Hub 238 — 분류와 이상탐지 실험, RUL 정답은 확인되지 않음

정상, 베어링 불량, 회전체 불평형, 축정렬 불량, 벨트 느슨함의 진동·전류 데이터입니다. 공개 스키마에서 수집일·고장 유형·샘플레이트 등은 확인되지만 **부품별 고장 종점·수명 종료 시간·RUL 라벨은 확인되지 않았습니다.** 날짜순 고장 클래스나 정상/고장 여부를 남은 시간으로 바꾸면 안 됩니다. [AI Hub 공식 설명](https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=238)

- **가능:** 정상 클래스만 Isolation Forest train/calibration에 사용, 분리한 정상·고장으로 탐지 성능 평가, 5-class 지도학습.
- **주의:** 원본 CSV의 단위·채널 의미는 로컬 검사에서 확정되지 않았습니다. 예시 프로필의 `A`/`g`를 임의로 붙이지 말고 가이드/원본을 대조합니다.
- **v0.3 연결 작업:** ZIP→검증된 센서 프로필·구간 NPZ·승인 manifest 어댑터. 아직 v0.3에 연결해 실제 학습하지 않았습니다.

### XJTU-SY — 현재 목표에서 가장 필요한 추가 데이터

저자 공개 자료는 **15개 베어링, 3개 운전 조건의 전체 run-to-failure 이력**을 제공합니다. 수평/수직 진동 2채널, 25.6kHz, 파일당 32,768점(1.28초), 1분마다 취득한 CSV입니다. 수명·최종 손상 부위 표도 제공합니다. [저자 안내](https://biaowang.tech/xjtu-sy-bearing-datasets/), [저자 다운로드 저장소](https://github.com/WangBiaoXJTU/xjtu-sy-bearing-datasets)

- **RUL P0:** 베어링별 CSV와 시간축/종료 기준을 대조해 `failure_time - observation_time`을 시간 단위 정답으로 만듭니다. **1.28초 파형 길이를 누적한 값은 수명이 아닙니다.** 취득 간격과 종료 정의를 사용합니다.
- 베어링 전체 이력을 train/test로 분리합니다. 동일 베어링 앞/뒤 구간 분리만으로 미관측 베어링 성능을 주장하지 않습니다.
- 전체 수명을 정상으로 학습하지 않습니다. 최종 손상 유형을 모든 초기 구간의 현재 고장 라벨로 복사하지 않습니다.
- **범위:** 시험 조건의 베어링 RUL 시연입니다. 현장 발전기/펌프 전체 수명 모델이 아닙니다. 저가 IMU와 공통 대역으로 제한한 실험도 필요합니다.
- 공개 연구 사용·원 논문 인용 안내는 있으나 표준 CC 라이선스라고 단정하지 않습니다. 실제 다운로드 용량/성공은 미확인입니다.

### KAIST HVAC — 벨트 고장·심각도 실험, 수명 데이터 아님

`d0` 정상, `d1~d4` 약함/중간/강함/심각한 벨트 느슨함입니다. 진동 2축 25.6kHz, 3상 전류 100kHz, RPM을 제공하며 진동·전류는 TDMS입니다. **정상 포함 5개 상태**입니다. 배포 설명의 “four conditions” 문구보다 논문의 명시적 5상태 표를 기준으로 합니다. 별도 `HVAC.zip`, CC BY 4.0 안내가 있습니다. [배포처](https://data.mendeley.com/datasets/5tt3zb2pns/1), [원 논문](https://pmc.ncbi.nlm.nih.gov/articles/PMC12361783/)

정상 학습·벨트 이상 검출 및 심각도별 검출률 비교에 적합합니다. 심각도는 실제 남은 시간/정비 긴급도가 아닙니다. **한 시험장비 데이터이므로 현재 v0.3 fault.py의 자산 분리 조건을 그대로 만족한다고 가정할 수 없습니다.** 별도 run 분리 실험은 코드에 명시적 평가 모드를 추가해야 하며 가짜 asset_id로 우회하면 안 됩니다. TDMS 어댑터도 필요합니다.

### KAIST AC — 속도·부하 강건성 검증, 다운로드 부담 큼

정상, 축정렬, 구름베어링, 권선(코일 간/턴 간), 저널베어링 간극 결함을 다룹니다. 진동/토크 25.6kHz, 3상 전류 100kHz, MAT이며 여러 용량·부하·속도 조건을 포함합니다. [원 논문](https://pmc.ncbi.nlm.nih.gov/articles/PMC12361783/)

운전 조건 변화에 따른 이상탐지 오경보와 분류 강건성 실험용입니다. 불평형·벨트를 모두 제공하는 AI Hub 대체 세트는 아닙니다. `AC.z01~AC.z06 + AC.zip` 모두 필요하고 `gr8c9ckhxh/3`은 **AC.z05 한 조각**입니다. 해당 v3 배포 설명은 CC BY 4.0이지만 전체 조각의 현재 다운로드 성공까지 검증하지 않았습니다. [AC.z05 배포처](https://data.mendeley.com/datasets/gr8c9ckhxh/3)

### 2026 Rotating Electromechanical System — 센서 구성에 잘 맞는 보완 데이터

정상 `H`, 베어링 `BD`, 회전자 바 `HB/OB`, 불평형 `U`, 축정렬 `M`, 기어 마모 `W25/W50/W75`입니다. 진동 3kHz·전류 4kHz·RTD 온도 1kHz·열화상 6초 간격이 논문에 명시됩니다. 온도 rate를 직관으로 1Hz로 고치지 말고 제공 TXT/시간축과 대조해야 합니다. 30초 기동·45분 정상속도 시험이며 **run-to-failure 이력이 아닙니다.** [원 논문](https://www.nature.com/articles/s41597-026-07224-0)

진동·전류·온도별 정상-only 학습과 고장 테스트에 P1 추천입니다. CSV/MAT/JPG와 4개 설명 TXT를 먼저 확보하세요. RGB 열화상 MAT/JPG는 현 `slow_series`에 바로 넣을 수 없고 이미지→온도/영역 특징 어댑터가 별도 필요합니다. 단일 시험장비이므로 자산 일반화 평가에는 한계가 있습니다. [공식 저장소](https://dataverse.csuc.cat/dataset.xhtml?persistentId=doi%3A10.34810%2Fdata2500)

### NLN-EMP — 펌프가 핵심이면 우선순위 상승

모터 구동 원심펌프의 정상 기준과 베어링·권선·회전자·정렬·불평형·펌프 유량/공동현상 등 다양한 결함/심각도 실험입니다. 논문의 “20 faults”는 기존 AI Hub 5개 클래스와 일대일 대응하는 20개 공통 클래스라는 뜻이 아닙니다. 진동·전류·전압 20kHz, 채널별 CSV를 제공합니다. [원 논문](https://pmc.ncbi.nlm.nih.gov/articles/PMC10751838/), [4TU 배포처](https://data.4tu.nl/datasets/2b61183e-c14f-4131-829b-cc4822c369d0)

펌프용 이상탐지/분류에 유용하지만 실제 수명 종료 라벨로 확인된 자료는 아닙니다. 진동과 전기 측정 주기/길이가 달라 동기성을 확인해야 합니다. 정상 상태에서도 공동현상이 완전히 제거되지 않았다는 논문 한계도 있습니다. 이번 확인에서 4TU 직접 접근은 403이므로 원본 다운로드/데이터 이용 조건은 재확인이 필요합니다.

### UTK — 요약 특징·대시보드에는 편하지만 현재 원시신호 입력과 다름

System1은 정상, 편심 회전자, 축 휨, 베어링, 커플링 정렬, 불평형 상태의 RMS/peak/속도 등 **이미 계산된 지표**입니다. 약 1분 간격이나 불규칙한 관측도 명시됩니다. InsightCM은 JSON/CSV 요약을 제공합니다. [System1 README](https://github.com/UTK-ASL/Dataset_digital_twin_predictive_maintenance/blob/main/data/BentlyNevada_System1/README.md), [전체 저장소](https://github.com/UTK-ASL/Dataset_digital_twin_predictive_maintenance)

원시 진동 파형처럼 FFT를 재적용하지 않습니다. 현재 v0.3은 균일 구간 NPZ 입력이므로 별도 tabular feature 계약/어댑터가 필요합니다. README가 RUL을 활용 예로 언급해도 실제 고장 종점 정답이 있다는 증거는 아닙니다. 빠른 시연 보조 P2, 원시신호 모델의 직접 외부 검증 세트로는 부적합합니다.

### DCASE 2026 Task 2 — 정상-only 개념은 맞지만 음향 과제

정상 소리만 학습하고 정상/이상 test로 평가하는 음향 데이터입니다. 개발 세트는 7개 기계 종류이며 기계 종류는 고장 원인 라벨이 아닙니다. 2채널·근/원거리 녹음 중 일부는 emulated 채널입니다. 개발 데이터 4.8GB, ToyCar는 수정본 `dev_ToyCar_r2.zip` 사용 안내가 있습니다. [공식 Task 2](https://dcase.community/challenge2026/task-first-shot-unsupervised-anomalous-sound-detection-for-machine-condition-monitoring)

마이크를 추가할 때 별도 음향 특징/프로필로 검토하세요. IMU·온도·전류 RUL의 정답 데이터나 드론 자체 소음 검증 자료로 사용하지 않습니다. 현재 핵심 범위에서는 다운로드 후순위입니다.

## 3. 추가 RUL 후보: 꼭 모두 받을 필요는 없음

| 데이터 | 역할 | 판단/출처 |
|---|---|---|
| **FEMTO/PRONOSTIA** | 베어링 가속 수명 실험 | XJTU-SY 대안 또는 외부 RUL 검증. 진동/온도 패키지의 실제 README·timestamp를 확인한 뒤 어댑터 작성. 이번 확인에서 온도 취득 rate를 확정하지 않음. [NASA PCoE](https://www.nasa.gov/intelligent-systems-division/discovery-and-systems-health/pcoe/pcoe-data-set-repository/) |
| NASA IMS Bearings | 추가 베어링 열화·이상탐지 실험 | 원본 README/종료 기준 미검사. 주파수·라벨을 추측하지 않음. [NASA 공식 카탈로그](https://data.nasa.gov/dataset/ims-bearings) |
| NASA C-MAPSS | 터보팬 시뮬레이션 RUL | 센서·설비 도메인이 다름. 사이클 RUL을 임의로 시간으로 바꾸거나 IMU 모델에 혼합하지 않음. 이번에는 제외 권고. [NASA PCoE](https://www.nasa.gov/intelligent-systems-division/discovery-and-systems-health/pcoe/pcoe-data-set-repository/) |

## 4. 현재 파이프라인에 연결할 때의 필수 규칙

1. **원본 확인 먼저:** 설명서/README + 파일 하나의 헤더·shape·단위·timestamp·결측값을 검사합니다. 공개 논문에 맞춰 파일 구조를 추측해 파서를 먼저 만들지 않습니다.
2. `dataset_id`, 실제 `asset_id`, `run/session_id`, 운전 조건, 센서 위치/방향, 단위, 실제 rate, 수집 시각, label 출처를 보존합니다. ID·파일명·고장 코드 메타데이터를 예측 특징으로 넣지 않습니다.
3. 공통 주파수 대역·시간창·교정 단위를 검증합니다. 업샘플링은 없는 고주파 정보를 복구하지 않습니다. 서로 다른 dataset의 각 클래스를 불균형하게 추가하면 출처를 외우는 모델이 될 수 있습니다.
4. **분류 매핑 금지:** 회전자 바→불평형, 고정발 풀림→벨트 느슨함, 축 휨/편심→무조건 축정렬로 매핑하지 않습니다. 새 라벨로 분리하거나 제외합니다.
5. **RUL 매핑 금지:** 심각도 단계, 날짜순 고장 실험, 45분 시험의 끝을 실제 고장까지 남은 시간으로 만들지 않습니다. run-to-failure의 실제 종료 기준만 사용합니다.
6. 현재 `rul.py`/`fault.py`는 자산 분리를 요구합니다. 단일 rig 데이터는 run 분리만으로 그 조건을 만족하지 못합니다. 별도 실험 모드가 필요하면 한계를 명시해 코드에 추가하고 자산 ID를 조작하지 않습니다.
7. 외부 데이터를 학습에 넣었으면 동일 파일/자산을 다시 독립 외부 test라고 부르지 않습니다. 출처별·설비별·운전 조건별 지표를 분리합니다.
8. 정상-only edge 재학습은 **승인된 현장 정상**만 사용합니다. 이상탐지 후보를 재학습한다고 RUL/고장 분류기가 함께 자동 개선되는 것은 아닙니다. 각각의 정답 데이터가 필요합니다.

## 5. 해커톤 실행 순서와 발표 범위

1. **현장 DAQ 정상 기록 확보 → 이상탐지 실제 edge 후보 1개**를 완성합니다. 분리한 정상 test 오경보율, 추론 지연, 메모리, rate별 입력 검증을 측정합니다.
2. **XJTU-SY 확보 → 별도 베어링 RUL 어댑터/모델**을 완성합니다. 베어링 단위 분리, MAE/RMSE, 평균 RUL baseline 비교를 제시합니다. 현장 설비 수명으로 일반화하지 않습니다.
3. 기존 **AI Hub XGBoost 분류 baseline을 보존**하고, v0.3 분류가 필요하면 AI Hub→검증된 NPZ 프로필 변환 후 별도 학습합니다.
4. 시간이 남으면 2026 회전기계의 정상/선택 고장 파일 또는 KAIST HVAC 하나만 추가합니다. 대용량 데이터를 모두 혼합하는 것보다 독립 평가 하나를 끝내는 편이 낫습니다.

**“AI Hub보다 더 좋은 데이터”의 단일 순위는 없습니다.** RUL에는 XJTU-SY가 과제상 더 적합하고, 센서 3종 시연에는 2026 회전기계가 보완적이며, 현장 정상 기준에는 실제 저가 센서 기록이 가장 직접적입니다. 어느 데이터가 모델 성능에서 더 좋다는 결론은 같은 평가 조건으로 실험하기 전에는 내릴 수 없습니다.

관련 문서: [모델 구조·실제 학습 상태](MODEL_ARCHITECTURE.md), [입출력 계약](INPUT_OUTPUT.md).
