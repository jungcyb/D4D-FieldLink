# FEMTO train / validation / test 분리

실행 결과: `12_ai_dev/data/prepared/femto_split_v1/` (Git 제외).
원본 ZIP은 그대로 보존하고 `train.csv`, `validation.csv`, `test.csv`,
`split_summary.json`으로 **파일 참조 목록**을 만들었습니다. 대용량 신호 복제/전체 압축 해제는 없습니다.

| 분할 | 베어링 ID | 진동 CSV | 온도 CSV | 용도 |
|---|---|---:|---:|---|
| train | Bearing1_1, Bearing2_1, Bearing3_1 | 4,229 | 706 | 모델 학습 |
| validation | Bearing1_2, Bearing2_2, Bearing3_2 | 3,305 | 144 | 모델/특징/파라미터 선택 |
| test | Bearing1_3~1_7, Bearing2_3~2_7, Bearing3_3 | 17,355 | 2,168 | 선택 완료 후 최종 평가 |

Learning_set의 6개 베어링을 ID의 세 조건 그룹별로 하나씩 학습/검증에 배정했습니다.
베어링의 전체 수명 이력과 모든 센서 파일은 한 분할에만 들어갑니다.
인접 구간을 무작위로 나누지 않으며 모형에 베어링 ID를 특징으로 넣지 않습니다.
학습/검증 베어링이 각각 3개뿐이므로 일반화 성능의 불확실성은 큽니다.
새로운 운전 조건 자체에 대한 일반화를 검증하는 분할은 아닙니다.

## 원본 ZIP 이름 주의

- train/validation 모두 `Training_set.zip` 내부 `Learning_set`에서 분리했습니다.
- 최종 test는 `Validation_Set.zip` 내부 **Full_Test_Set**의 11개 별도 베어링입니다.
- `Test_set.zip`은 Full_Test_Set과 **같은 11개 베어링의 짧게 잘린 이력**이므로
  별도 독립 데이터로 사용하지 않습니다. 내부 중복 ZIP도 사용하지 않습니다.
- 나중에 잘린 이력의 RUL challenge를 평가해도 같은 베어링의 Full_Test 결과와
  독립된 추가 표본으로 집계하지 않습니다.

## 재생성

프로젝트 루트 PowerShell:

```powershell
& .\.venv\Scripts\python.exe .\12_ai_dev\versions\v0.3\prepare_femto_split.py `
  --data-dir .\12_ai_dev\data\raw\femto `
  --output-dir .\12_ai_dev\data\prepared\femto_split_v1
```

기존 출력 폴더가 있으면 덮어쓰지 않고 실패합니다. 재실행 시 새 출력 경로를 지정하세요.
다른 기기로 데이터 이동 시 `split_summary.json`의 `data_dir`를 새 경로로 재생성합니다.
각 CSV의 `archive`는 이 `data_dir` 기준 상대 경로이고 `member`는 ZIP 내부 경로입니다.
나머지 열: `asset_id`, `signal`(acc/temp), `recording_index`, `bytes`, `crc32`.
CRC는 ZIP 헤더에 기록된 참조값으로, 생성 과정에서 모든 신호 payload를 읽어 검증한 것은 아닙니다.
17개 베어링 포함 여부, 예상 밖 파일, ZIP member 중복을 검사하고 결정론적으로 목록을 생성합니다.

## 분리 완료와 학습 완료는 다릅니다

이 목록에는 **RUL 정답 라벨이 아직 없습니다**. `rul.py`에 바로 넣는 NPZ 학습 manifest도 아닙니다.
이 참조 목록과 별개로, 후속 작업에서 종료 기준/측정 간격 검증을 통한
라벨 생성 어댑터와 `rul.py` validation 처리를 추가했습니다.
[실제 학습 절차](FEMTO_TRAINING.md)는 별도 NPZ manifest를 사용하며, 근거 불일치인
`Bearing1_4`는 원본 분할 목록에서 삭제하지 않고 학습용 test manifest에서만 제외합니다.
validation을 test로 이름만 바꾸어 튜닝하고 최종 성능으로 보고하면 안 됩니다.
최종 test는 특징 선택·스케일링·모델 선택·정상 기준/임계값 설정에 사용하지 않습니다.
온도 누락 자산은 가짜 값으로 채우지 않고, 첫 RUL 모델은 진동 2채널로 구성합니다.
