# v0.3 배포 패키지 (실험용)

**현장 사용 승인된 모델이 아닙니다.** FEMTO RUL test MAE 1.956시간으로
단순 평균 baseline 1.688시간보다 나쁩니다. 정비/안전 결정을 이 추정값만으로 하지 마세요.
상세: RESULTS_FEMTO_RUL_V1.md, FEMTO_TRAINING.md, INPUT_OUTPUT.md.

## 포함 / 제외

- v0.3 코드·재학습 파이프라인, FEMTO RUL 후보 가중치(약1.53MiB), 프로필·평가·그래프.
- 원본 데이터, 전체 NPZ 캐시, .venv, CUDA, 구버전 가중치, 대용량 예측 CSV는 제외.
- synthetic_vibration.npz는 실행 확인용 인공 신호이며 정확도 검증/학습 데이터가 아닙니다.
- **학습된 Isolation Forest / v0.3 고장 분류 가중치는 없습니다.**
  predictive.py 통합 추론은 호환 프로필의 이상 탐지 후보를 먼저 학습해야 합니다.
  현재 포함 모델은 rul.py score로 단독 실행합니다.
- joblib는 신뢰한 출처만 로드하세요. 체크섬은 변조 탐지용이며 발행자 인증 서명이 아닙니다.

## Windows 실행 (압축 해제한 v0.3_export 폴더에서)

```powershell
python .\verify_bundle.py
python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --only-binary=:all: -r .\requirements-runtime.lock.txt
& .\.venv\Scripts\python.exe .\rul.py score --model-dir .\models\femto_rul_v1 --input-npz .\examples\synthetic_vibration.npz
```

## AM6442 / Linux AArch64

Python3.13/Linux Cortex-A53 사용자 공간이 대상이며 R5F/M4F용 펌웨어가 아닙니다.
Windows와 동일 CPU/GPU는 필요 없고 CUDA는 사용하지 않습니다.
아래는 **보드에서 실행할 명령**입니다. 실기 호환성·지연은 검증하지 않았습니다.

```sh
python3.13 verify_bundle.py
python3.13 -m venv .venv
.venv/bin/python -m pip install --only-binary=:all: -r requirements-runtime.lock.txt
.venv/bin/python rul.py score --model-dir models/femto_rul_v1 --input-npz examples/synthetic_vibration.npz
```

동봉 wheel은 없습니다. 정확한 버전의 AArch64 wheel을 설치할 수 없다면 다른 버전으로
강제 로딩하지 말고, 보드에서 설치 가능한 런타임으로 재학습/재평가한 후보를 내보내세요.
오프라인 설치는 보드와 호환되는 OS/아키텍처/Python 환경에서 미리 wheel을 준비해야 합니다.
requirements-edge.txt는 새 후보 학습/실행 범위이며 기존 가중치 실행에는 lock 파일을 사용합니다.
RUL 학습 그래프까지 생성할 경우 requirements-train.txt의 matplotlib도 설치해야 합니다.

입력은 FEMTO 규격 25.6kHz·0.1초·수평/수직2축·native g입니다.
저가 IMU의 저주파수/다른 단위 신호를 그대로 사용하지 마세요.
출력 시간은 실험 run 기록 종료 기준의 조건부 추정이며 장비 전체 보장 수명이 아닙니다.
승인 인증·후보 활성화/롤백·통신·로그·정비 우선순위는 backend 담당입니다.
