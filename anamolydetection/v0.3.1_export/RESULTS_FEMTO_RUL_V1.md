# FEMTO RUL v1 실데이터 학습 결과

실행일: 2026-10-10. Windows CPU, seed42, RandomForest64/depth8, 28개 특징. **실험용 candidate, 자동 활성화하지 않음.**

## 데이터와 라벨

- Train 3베어링 / 4,227구간, validation 3베어링 / 3,305구간, test 10베어링 / 15,927구간.
- 모든 구간 평가, 분할별 무작위 표본 축소 없음. 모든 asset/session/file이 분리됨.
- Bearing1_4: 공개 RUL과 archive 잔여시간 불일치로 제외. Bearing1_1의 시각 불일치 구간 2121/2122 제외.
- 정답은 10초 취득 간격에 따른 기록 종료까지 남은 시간. 현장 설비의 보장 수명 아님.
- 고정 설정으로 train에만 fit. validation/test로 모델 선택이나 튜닝하지 않음.

## 성능 (시간 단위)

| 분할 | MAE (낮을수록 좋음) | RMSE | 자산 macro MAE | 단순 평균 baseline MAE |
|---|---:|---:|---:|---:|
| validation | 2.0700 | 2.6789 | 2.1283 | 1.5098 |
| test | 1.9560 | 2.4572 | 2.0914 | 1.6879 |

**판정:** 최종 test에서 단순 학습 평균 예측보다 오차가 큽니다. 학습/추론 파이프라인은 동작하지만, 신뢰 가능한 현장 RUL 성능을 확보한 모델로 배포/발표하면 안 됩니다.
초기 정상 단일 구간의 특징만으로 절대 수명 구분이 어렵고 베어링별 수명 편차가 큽니다. 다음 실험은 과거 추세/운전 조건을 추가하여 validation으로 설계하고 새 미사용 평가 자산을 확보해야 합니다. 인과적인 실패 원인을 확정한 분석은 아닙니다.
본 평가는 전체 수명 구간의 회귀이며 원 PHM2012의 잘린 이력 마지막 지점 평가/공식 score와 다르므로 직접 비교하지 않습니다.

## 경량성 및 실행 검증

- 모델 크기: 1,606,433 bytes (1.53 MiB).
- RF fit: 2.56초. CSV 변환·NPZ/특징 추출·그래프 저장은 제외. 전체 파이프라인은 수분 소요.
- 단일 구간 특징 추출+추론: Windows CPU median 3.36ms / p95 4.05ms, 50회. 파일 읽기/모델 초기화 제외. AM6442 실측 아님.
- 저장 모델 재로딩·실제 held-out NPZ 추론 성공, 저장 CSV MAE 재계산 일치, 모든 분할 자산 중복 없음 확인.

## 결과 위치

- 모델/지표/예측 CSV: `12_ai_dev/outputs/v0.3/femto_rul_v1/`
- Validation 그래프: `12_ai_dev/outputs/v0.3/femto_rul_v1/plots/validation/` (scatter + 베어링별 3개)
- Test 그래프: `12_ai_dev/outputs/v0.3/femto_rul_v1/plots/test/` (scatter + 베어링별 10개)
- 실행 로그/추론 예제/지연/해시: `12_ai_dev/outputs/v0.3/femto_rul_run_v1/`
- 라벨 manifest/품질 제외 내역/NPZ: `12_ai_dev/data/prepared/femto_rul_v1/`

[재현 명령·라벨 근거·제한](FEMTO_TRAINING.md). 기존 v0.1/v0.2와 v0.3 이상 탐지/고장 분류 모델을 대체하거나 새로 학습한 작업이 아닙니다.
