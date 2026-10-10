# v0.3 edge 설치·실행

AM6442의 **Linux/AArch64 Cortex-A53**에서 Python 3.13과 호환 wheel이 설치되는지 먼저 확인합니다. R5F/M4F용 바이너리가 아닙니다. 실기 설치·성능은 아직 확인하지 않았습니다. [입출력 계약](INPUT_OUTPUT.md)을 먼저 읽고 DAQ의 센서 단위·채널·rate·동기성을 확인하세요.

```bash
uname -m
python3.13 --version
ldd --version | head -1
python3.13 -m venv .venv
. .venv/bin/activate
python -m pip install --only-binary=:all: -r requirements-edge.txt
python -c "import numpy, scipy, sklearn, joblib; print(numpy.__version__, scipy.__version__, sklearn.__version__, joblib.__version__)"
```

보드에 `v0.3/` 폴더 전체를 복사한 뒤 그 폴더에서 실행합니다. 프로필 예시는 실제 센서 스펙으로 교체하고, 승인된 manifest와 NPZ는 backend가 준비합니다. 각 학습 명령은 **새 후보 폴더**에만 씁니다.

```bash
python anomaly.py train --profile /data/profiles/vibration.json --manifest /data/manifests/normal.json --output-dir /data/candidates/vibration-if-001
# 실제 고장 종점/시간 라벨이 있을 때만:
python rul.py train --profile /data/profiles/vibration.json --manifest /data/manifests/rul.json --output-dir /data/candidates/vibration-rul-001
# 전문가 확인 정상/고장 유형 라벨이 있을 때만:
python fault.py train --profile /data/profiles/vibration.json --manifest /data/manifests/fault.json --output-dir /data/candidates/vibration-fault-001
python predictive.py --manifest /data/equipment_window.json
```

`metrics.json`의 테스트 성능과 입력 프로필을 전문가가 검토한 뒤 backend가 후보를 활성화합니다. 이상탐지 정상 test는 고장 검출율을 증명하지 못합니다. RUL은 held-out 자산 MAE와 운전 조건을 따로 확인해야 합니다. 네트워크 단절 시 로그·구간 저장, 재연결 동기화, 승인 인증, 활성화·롤백, 정비 우선순위는 backend 경계입니다. `joblib`는 신뢰된 로컬 모델만 로드합니다.
