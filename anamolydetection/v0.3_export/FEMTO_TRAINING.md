# FEMTO RUL 학습·validation·최종 평가

실행 완료: [실제 성능·baseline 비교·추론 확인 결과](RESULTS_FEMTO_RUL_V1.md).

## 대회 목표와 이번 모델의 범위

루트 `대회 맥락.md`의 T4-6은 retrofit 센서와 엣지 이상 탐지/RUL 추정을 요구합니다.
이번 학습은 **베어링 진동 기반 RUL 회귀의 실데이터 기준 모델**입니다.
오프라인 추론/수동 승인 재학습 구조를 유지하고 서버 통신·로그 동기화·정비 우선순위는 backend 책임입니다.
기존 v0.1 분류와 v0.2 정상-only 이상 탐지 스냅샷은 수정하지 않습니다.
FEMTO에는 목표 5개 고장 유형의 라벨이 없으므로 그 분류 학습에 섞지 않습니다.
이번 RUL 학습으로 이상탐지 모델을 새로 학습했다고 주장하지 않습니다.

## 라벨 근거와 품질 검사

[원저자 PHM2012 대회 안내문](https://github.com/wkzs111/phm-ieee-2012-data-challenge-dataset/blob/577c77f1d8d284e2eadc8e17fe49d58907d7ad01/IEEEPHM2012-Challenge-Details.pdf):
진동 25.6kHz, 2,560점의 0.1초 구간을 10초마다 취득하며 앞 4열은 시각, 뒤 2열은 수평/수직 가속도입니다.
원본 PDF는 `data/raw/femto/IEEEPHM2012-Challenge-Details.pdf`에 보존했습니다.
SHA256: `13bd43eb2dc4c8455e36584094552ccbd8101b9a0b99bd10ca82103453585ba5`.

```text
remaining_useful_life_hours = (마지막 진동 기록 번호 - 현재 기록 번호) * 10 / 3600
```

- 의미: 가속 수명 실험의 **기록된 run 종료까지 남은 시간**. 현장 설비의 보장 수명 아님.
- 파일 이름/기록 번호/경과 시간은 라벨·추적용이며 예측 특징에 포함하지 않습니다.
- Full_Test와 잘린 Test 기록 수 차이를 원문 Table 3의 공개 RUL과 비교했습니다.
  **10개 일치**, `Bearing1_4`만 2,890초 대 원문 339초로 불일치하여 주 평가에서 제외했습니다.
  대회 안내의 20g 종료 조건은 세부 채널/지속시간 규칙이 불명확하므로 임의 역산하지 않았습니다.
- 원본/분할 인덱스는 그대로 보존하며, 학습용 manifest에서만 `Bearing1_4`를 제외합니다.
- CSV 쉼표/세미콜론, finite 값, `[2560,6]`, 연속 acquisition 번호, clock 및 10초 간격을 검사합니다.
  ZIP payload를 실제로 읽어 CRC를 확인합니다. 시각이 취득 번호와 맞지 않는 소수 구간은
  보정하지 않고 제외 내역을 저장합니다. 자산별 1% 초과(최소 허용 2건) 또는 종료 시각 오류는 중단합니다.
- CSV 미세 시각은 직렬화 반올림이 있으므로 이를 정밀한 DAQ timestamp로 사용하지 않습니다.
  신호는 원문의 25.6kHz 기준입니다. native 가속도 값을 유지하고 단위 `g`는 데이터셋 관례입니다.
- 온도는 누락/정렬 정책이 없으므로 이번 입력에서 제외합니다.

## 입력·모델·validation

- 입력: 0.1초 진동, 25.6kHz, `[2560,2]`, 수평/수직, `femto/vibration/2ch/25600hz/v1`.
- 특징: 채널당 시간/FFT/주파수 대역 에너지 14개, 총 **28개**.
- 모델: RandomForestRegressor, 64 trees, max_depth=8, min_samples_leaf=2, n_jobs=1, seed=42.
- train: 3개 베어링. validation: 별도 3개. 최종 test: 근거 일치 별도 10개.
- 모델은 train만 사용해 한 번 학습합니다. validation/test 지표는 따로 저장하며
  이번 기준 실험은 파라미터를 고정하므로 validation을 보고 선택/재학습하지 않습니다.
  최종 test도 튜닝에 사용하지 않습니다. 표본 수 상한 25,000으로 각 분할 전체를 사용합니다.
- 모든 분할 사이의 asset/session/NPZ 경로 중복을 거부합니다.
- 입력 NPZ는 캐시이며 재학습 때 다시 CSV를 해제할 필요가 없습니다.

## 실행 (프로젝트 루트 PowerShell)

작은 smoke는 `--max-per-bearing 20`, 새 출력 경로를 사용합니다.
전체 데이터 변환은 약 23,000개 NPZ, 수백 MB 디스크이며 한 번에 CSV 하나만 메모리에 읽습니다.
학습용 그래프 의존성은 `requirements-train.txt`, 추론은 `requirements-edge.txt`입니다.

```powershell
$code = '.\12_ai_dev\versions\v0.3'
$prepared = '.\12_ai_dev\data\prepared\femto_rul_v1'
$model = '.\12_ai_dev\outputs\v0.3\femto_rul_v1'
& .\.venv\Scripts\python.exe "$code\prepare_femto_rul.py" `
  --data-dir .\12_ai_dev\data\raw\femto --output-dir $prepared `
  --approval-id user-request-20261010-femto-rul
& .\.venv\Scripts\python.exe "$code\rul.py" train `
  --profile "$prepared\profile.json" --manifest "$prepared\manifest.json" `
  --output-dir $model --n-estimators 64 --max-windows-per-split 25000
& .\.venv\Scripts\python.exe "$code\rul.py" score `
  --model-dir $model --input-npz "$prepared\windows\Bearing1_3\acc_00001.npz"
```

기존 출력은 덮어쓰지 않습니다. 재학습은 새로운 모델 버전 폴더를 지정합니다.
`approval_id`는 backend의 승인 확인을 대체하지 않으며 이번 요청의 추적 식별자입니다.
새 모델은 `candidate`이며 자동 배포/활성화하지 않습니다.

## 별도 저장 결과

- `data/prepared/femto_rul_v1/`: profile, manifest(정답/분할/원본 경로), preparation_report, NPZ.
- `outputs/v0.3/femto_rul_smoke_v1/`: 실행 가능성만 확인한 작은 실험.
- `outputs/v0.3/femto_rul_v1/`: model.joblib, metadata/profile, metrics_validation.json,
  metrics_test.json, 분할별 predictions/asset_metrics CSV, `plots/validation/`, `plots/test/`.
  `metrics.json`은 이전 호환용 test 지표 사본입니다.
- `outputs/v0.3/femto_rul_run_v1/`: prepare.log, train.log 및 추론 확인 결과.
- 데이터·가중치·대용량 예측 결과는 Git 제외. 요약 평가는 별도 Markdown으로 기록합니다.

## 배포 제한

저가 IMU의 낮은 샘플링률 신호를 이 모델에 그대로 넣으면 안 됩니다.
현재 FEMTO 프로필은 25.6kHz에 한정하며 저주파수 센서 배포 시 공통 대역 프로필과 재학습/검증이 필요합니다.
AM6442 실기기 학습/지연은 아직 측정하지 않았습니다. Windows CPU 측정값을 엣지 성능으로 발표하지 않습니다.
수평/수직 2축이라는 채널 개수만으로 다른 센서·부하·설비에 적용 가능하다고 주장할 수 없습니다.
초기 정상 구간의 단일 window만으로 절대 수명을 알아내기 어려우며,
성능이 단순 평균 baseline보다 나쁘면 **검증된 현장 RUL 모델이 아닌 연구용 후보**로 표시합니다.
후속 개선은 더 많은 수명 이력, 운전 조건, 과거 특징 추세를 포함해 별도 validation 실험으로 수행합니다.
