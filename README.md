# AM6442 SK + ADS8688 FIELDLINK

ADS8688 8채널을 AM6442 M4F에서 취득하고 R5F/RPMsg를 거쳐 Linux에 저장한 뒤, 서버가 웹 대시보드로 여러 장치를 모니터링하는 단일 저장소입니다.

```text
ADS8688 -> M4F SPI -> R5F relay -> Linux ads8688d
          -> board ring storage + UDP discovery/TCP stream
          -> server collector -> Next.js API/dashboard -> browser users
```

## 폴더

- `firmware/`: M4 ADS8688 취득 및 R5 RPMsg relay
- `board/`: Python 3.13 Linux 데몬, systemd 단위
- `client/`: CLI와 pygame 8채널 scope
- `integration/`: 서버 collector와 재연결/checkpoint 상태
- `dashboard/`: 장치별 웹 모니터링, affine calibration, 복구·기간 export UX
- `anamolydetection/`: 정상 구간 승인 후 학습하는 Isolation Forest 코드
- `hardware/`, `docs/`: MCU header 배선, 프로토콜, 운영·참조 문서
- `tools/`: 빌드·배포·SSH 보조 스크립트
- `.meta/`: 로컬 접속 정보, 계획·작업 메모, 보드 백업, 다운로드 자료와 과거 측정 결과 (Git 제외)

`.meta/`는 저장소에 포함되지 않습니다. 새 PC에서는 `tools/connection.example.txt`를 `.meta/connection.txt`로 복사해 개인 접속 정보를 설정하고, 필요하면 `.meta/client/host.txt`에 보드 주소 한 줄을 저장하세요. SSH 호스트 키 기록은 `.meta/tools/ssh/known_hosts`에 보관합니다. 실제 비밀번호는 커밋하지 않습니다.

실행 중인 `dashboard/data/`, `integration/state/`, `.tmp/` 로그와 `node_modules`, 가상환경·빌드 캐시는 실행 경로를 유지하면서 Git에서 제외합니다. `.meta/`는 암호화나 백업이 아니므로 필요한 로컬 자료는 별도로 안전하게 백업하세요.

## 서버 실행

Node.js 22.18 이상과 `dashboard/node_modules`가 필요합니다.

```powershell
# UDP discovery 사용
.\start-server.ps1

# 보드 주소 고정
.\start-server.ps1 -BoardHost 192.168.0.240

# 전원/배선 점검 중에는 collector 없이 UI만 실행
.\start-server.ps1 -DashboardOnly
```

대시보드는 모든 인터페이스의 TCP 3000번에 열립니다. 같은 LAN의 사용자는 `http://<server-ip>:3000`으로 접속합니다. collector는 보드가 끊겨도 재접속하며, 보드 취득과 로컬 링 저장은 멈추지 않습니다.

현재 구현된 운영 UX:

- UUID 기반 DAQ 탐색·장비/센서 등록과 8채널 실시간 조회
- 센서별 두 점 affine calibration (`physical = input * scale + offset`), 원본 불변
- 연결 단절 감지, timestamped backlog 복구, gzip 원본 아카이브와 누락 구간 표시
- DAQ와 KST 기간을 지정한 센서 Raw + 로그 `JSONL.gz` export
- 진단 결과, 설비 의존관계, 정비 작업, 로컬 RAG 연결 경계

센서 방향과 극성은 자동 변경하지 않습니다. 실제 채널 calibration 기본값은 모두 `scale=1`, `offset=0`입니다.

## 검증

```powershell
python -m unittest discover -s tests -v
node --test integration\collector.test.mjs
cd dashboard
node node_modules\typescript\bin\tsc --noEmit
node --experimental-strip-types --test tests\*.test.mts
```

보드 배포는 `tools/deploy.ps1`, TCP/UDP wire format은 `docs/PROTOCOL.md`를 참고하세요. 과거 phase 계획과 실측 기록은 로컬 `.meta/plan.md`, `.meta/docs/TEST_RESULTS.md`에 보관합니다. 실제 센서 프로필과 승인된 정상 데이터가 없으므로 이상진단 모델은 아직 활성화하지 않으며, 가짜 정상/이상 판정을 생성하지 않습니다.
