# v0.2-curr AM6442 edge 배포 절차

## 0. 배포 방식과 현재 상태

**Windows에서 학습한 모델을 복사하지 않습니다.** `v0.2-curr` 코드와 센서 프로필을 AM6442의 Linux/AArch64 환경에 설치하고, backend가 전문가 승인 후 지정한 정상 구간으로 **보드에서 후보 모델을 학습**합니다. 서버는 승인·데이터 범위·로그·활성 모델 버전을 관리하고, 모델 파이프라인은 `train`/`score`만 수행합니다. 인터넷 연결은 패키지 설치나 backend 연동에는 필요하지만 학습·추론 자체에는 필요하지 않습니다.

**실기 검증 전:** 현재 AM6442에 코드를 설치하거나 DAQ로 학습·추론한 결과는 없습니다. 이 절차는 준비된 명령과 검증 체크리스트입니다. AM6442의 Arm Cortex-A53/Linux에서 실행하고 R5F/M4F에 Python 모델을 직접 올리는 방식은 아닙니다. [TI AM6442 제품 정보](https://www.ti.com/product/AM6442)

## 1. 보드 사전 점검

보드 Linux 셸에서:

```bash
uname -m                 # aarch64 예상
python3.13 --version
ldd --version | head -1   # glibc 확인
free -h                  # 실제 RAM 확인
df -h                    # 저장 공간 확인
```

현재 PyPI의 Python 3.13/AArch64용 scikit-learn 1.9.1 및 SciPy 1.18.1 wheel은 glibc 2.27+ 태그가 있습니다. **보드 OS가 그보다 오래되거나 Python/ABI가 다르면 아래 설치가 실패할 수 있습니다.** 이 경우 무작정 소스 컴파일하지 말고 호환 wheel/OS를 확인하세요. [scikit-learn PyPI](https://pypi.org/project/scikit-learn/), [SciPy PyPI](https://pypi.org/project/scipy/)

## 2. Windows → 보드로 코드 전송

프로젝트 루트의 PowerShell에서 `<계정>`과 `<보드IP>`를 바꾸세요. 이 스냅샷은 `anomaly.py`, `anomaly_features.py`, `features.py`, 예시 프로필 및 의존성 파일을 포함합니다.

```powershell
$board = '<계정>@<보드IP>'
ssh $board 'mkdir -p ~/d4d'
scp -r .\12_ai_dev\versions\v0.2-curr "${board}:~/d4d/"
```

`outputs/`, AI Hub 원본 ZIP, Windows `.venv`는 전송하지 않습니다. 서버/DAQ 연동이 완료되면 backend가 선택한 정상 구간 `.npz` 파일과 승인 manifest를 **보드의 로컬 데이터 경로**에서 모델 코드에 전달합니다.

## 3. 보드 Python 환경 설치

```bash
cd ~/d4d/v0.2-curr
python3.13 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --only-binary=:all: -r requirements-edge.txt
.venv/bin/python -c 'import platform, numpy, scipy, sklearn; print(platform.machine(), numpy.__version__, scipy.__version__, sklearn.__version__)'
.venv/bin/python -m pip freeze > edge-packages.txt
```

`--only-binary=:all:`은 보드에서 예상치 못한 소스 빌드를 방지합니다. 설치 실패 시 Python 버전·glibc·wheel 호환성을 확인해야 합니다. `edge-packages.txt`는 실제 보드에 설치된 버전 기록으로 보관하세요. 학습과 추론은 같은 보드 환경에서 실행합니다. scikit-learn의 `joblib` 모델을 다른 패키지 버전에서 로드하는 것은 지원되지 않으며, 코드도 저장된 sklearn/NumPy 버전이 다르면 거부합니다. [scikit-learn 모델 저장 문서](https://scikit-learn.org/stable/model_persistence.html)

## 4. 실제 DAQ에 맞는 프로필 확정

`examples/edge_profile.json`은 **형식 예시**입니다. 실제 센서의 물리 단위, 채널 순서, 동시 샘플링, 허용 rate 범위, 운전 조건, 고정 주파수 대역을 확인하여 **새 프로필**로 저장하세요. AI Hub 원본의 전류/진동 단위는 확인되지 않았으므로 예시의 `unit: "A"`를 해당 데이터에 그대로 적용하면 안 됩니다. 프로필 입력 조건을 만족하지 않는 낮은 rate나 다른 센서는 별도 프로필을 만듭니다. 상세 필드는 [INPUT_OUTPUT.md](INPUT_OUTPUT.md)에 있습니다.

## 5. 승인된 정상 구간으로 후보 학습

Backend는 전문가 승인을 검증하고 `approval_id`, `profile_id`, `data_label: "normal"`, 세션이 겹치지 않는 `train`/`calibration`/`test` `.npz` 경로가 포함된 manifest를 생성해야 합니다. 분할마다 최소 20구간이 필요하지만 **20구간은 기능 검증의 최소치일 뿐 신뢰할 만한 임계값을 보장하지 않습니다.** 재학습은 승인된 누적 기록의 새로운 범위로 **새 후보 디렉터리**를 지정해 호출합니다.

```bash
cd ~/d4d/v0.2-curr
export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
.venv/bin/python anomaly.py train \
  --profile /data/d4d/profiles/motor-current.json \
  --manifest /data/d4d/approved/normal-request-001.json \
  --output-dir /data/d4d/candidates/iforest-request-001 \
  --max-windows-per-split 1000
```

`1000`은 보드 첫 실험의 보수적 표본 상한 예시입니다. 기본값은 분할당 5,000입니다. 학습 중 메모리/CPU와 DAQ 수집 누락을 관찰하고 조정하세요. **이 명령은 후보만 만들고 활성 모델을 바꾸지 않습니다.** CLI는 `approval_id`의 권한을 검증하지 않으므로 수동 실행은 개발/검증에만 사용하고 운영 호출은 backend 승인 경로로 제한해야 합니다.

생성 파일: `model.joblib`, `profile.json`, `metadata.json`, `metrics.json`, `normal_test_scores.csv`. `metrics.json`의 정상 테스트 구간 오경보율·점수 분위수와 입력 건수, 실행 시간/RAM을 확인하세요. 고장 데이터가 없으면 실제 고장 탐지율은 평가할 수 없습니다. `joblib`은 신뢰된 로컬 파일만 로드하세요. [scikit-learn 모델 저장 문서](https://scikit-learn.org/stable/model_persistence.html)

## 6. 추론 점검과 운영 연동

단일 구간 smoke test:

```bash
.venv/bin/python anomaly.py score \
  --model-dir /data/d4d/candidates/iforest-request-001 \
  --input-npz /data/d4d/new_window.npz
```

응답은 `status`, `profile_id`, `model_version`, `anomaly_score`, `threshold`, `is_anomaly`를 포함합니다. 점수는 **클수록 이례적**이지만 고장 확률은 아닙니다. 입력/프로필이 맞지 않으면 정상 판정 대신 오류가 납니다. 운영 스트림에서는 CLI를 매 구간 새로 띄우지 말고 Python 프로세스에서 `AnomalyScorer(model_dir)`를 **한 번 로드**한 후 `scorer.score(samples, sampling_rate_hz, timestamps)`를 구간마다 호출하세요. 구간 버퍼링, DAQ 입출력, 연속 경보 규칙은 backend/edge 서비스와 연결해야 합니다.

후보 승인·활성 모델 포인터 교체·롤백·로그 전송은 **backend 담당이며 현재 이 모델 코드에 구현되지 않았습니다.** 새 후보가 부적합하면 기존 모델을 계속 사용해야 합니다. 온라인 연결이 끊겨도 이미 활성화된 모델의 로컬 추론은 계속 가능하도록 서비스 경계를 설계하세요.

## 7. 배포 완료 기준

- 보드에서 Python 의존성 설치 및 import 성공.
- 실제 DAQ 프로필/단위/채널/rate 확인, 정상 `.npz` 입력 검증.
- 승인 manifest로 후보 학습 완료; 정상 holdout 오경보율과 표본 수 기록.
- 단일 및 연속 구간 추론 지연, 피크 RAM, DAQ 수집 누락 측정.
- backend가 후보 활성화·이전 모델 롤백·오프라인 추론을 검증.

위 검증 전에는 **AM6442 배포 성공이나 실시간 처리 가능성을 주장하지 않습니다.**
