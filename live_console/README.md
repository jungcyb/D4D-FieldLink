# FIELDLINK Live Console

여러 DAQ에 직접 TCP로 연결하는 pygame 데스크톱 앱입니다. 밝은 WinUI/Fluent 스타일을 pygame으로 그리며, 실제 WinUI 네이티브 컨트롤은 아닙니다. 브라우저, Next.js, collector, SSH가 필요하지 않습니다. 기존 웹 collector와 별도의 클라이언트로 동작합니다.

## 실행

저장소 루트에서 현재 PC의 `.venv-client`를 그대로 사용합니다.

```powershell
.\start-live-console.ps1

# 선택 사항: 직접 접속, 여러 DAQ 지정
.\start-live-console.ps1 -BoardHost '192.0.2.10','192.0.2.11:8765'

# 선택 사항: 자동 선택 대신 특정 LAN의 broadcast 주소 사용
.\start-live-console.ps1 -DiscoveryAddress '192.0.2.255'
```

주소는 예시입니다. 기본 실행은 PC의 사설 LAN별 UDP broadcast로 장치를 탐색합니다. 앱에서도 **직접 연결 +**로 주소를 입력할 수 있습니다. 가상 어댑터는 기본 탐색에서 제외합니다. 다른 서브넷/VPN/방화벽 때문에 탐색이 안 되면 IP를 지정하세요. 방화벽 설정은 자동 변경하지 않습니다.

새 PC에서만 Python 3.13 가상환경과 pygame을 준비합니다. 전역 설치는 필요 없습니다.

```powershell
py -3.13 -m venv .venv-client
.\.venv-client\Scripts\python.exe -m pip install -r live_console\requirements.txt
```

터미널에서 오류를 직접 확인하려면 `.\.venv-client\Scripts\python.exe -m live_console`을 실행합니다. 실행 로그는 `.meta/live_console/*.log`, CSV 기본 저장 위치는 `.meta/live_console/exports/`입니다. 모두 Git 제외 대상입니다.

## 표시와 조작

- 왼쪽 DAQ 목록: 최대 16대 동시 수신. 선택하지 않은 장치도 계속 수신합니다.
- 11채널 혼합 파형: ADS8688 CH0–7은 V, NU40 CH8–10은 g로 표시합니다. 채널별 자동 Y축 / 센서 전체 범위, 배경 grid, 현재값, SPS, 최소·최대·변동폭을 제공합니다. 작은 창에서는 통계를 생략합니다.
- 호버: 표시 구간 내 0부터 시작하는 인덱스, 원본 record ID, sequence, raw code, 전압. 축약 표시용 포인트가 아니라 실제 원본에서 찾습니다.
- 채널 클릭 후 **선택 채널 확대** 또는 더블클릭: 한 채널 크게 보기.
- `SPACE`: 파형 일시정지/재개. 수신·장치 상태·이상진단은 계속 갱신합니다.
- 파형 위 마우스 휠 / `+` / `-`: 시간축 확대·축소(0.05–10초), 이때 파형만 고정됩니다. `←` / `→`: 고정된 이력 이동.
- `A`: Y축 자동/전체. `F`: 확대/전체. `TAB`: 장치 전환. `F5`: 다시 탐색. `ESC`: 대화상자 닫기 → 확대 해제 → 앱 종료.
- **표시 구간 CSV**: 현재 시간 구간에 속한 모든 전송 채널의 원본 code와 V를 저장합니다. 수신과 저장은 UI 밖에서 처리합니다.
- **수집 시작/정지, SPS 설정**: 보드가 지원한다고 명시한 기능만 활성화됩니다. 확인 대화상자 후 UUID/최신 capability를 다시 검증하고, ACK와 STATUS 재조회가 일치해야 성공입니다. 보드 제어는 다른 클라이언트에도 영향을 줍니다.

연결·일시정지·연결 해제·앱 종료는 **보드 수집을 시작하거나 정지하지 않습니다**. 보드가 수집 정지 상태이면 버튼으로 명시적으로 시작해야 합니다.

## 갱신 방식

**고정 FPS 제한이나 파형 갱신 타이머가 없습니다.** 수신 스레드가 TCP 패킷을 해석하고 보관한 뒤 pygame 이벤트를 보내면 화면이 즉시 깨어나 최신 스냅샷을 그립니다. 그리는 동안 추가 도착한 패킷은 모두 이력에 반영하되, 대기 화면 갱신 이벤트는 하나로 합쳐 오래된 화면이 줄 서지 않게 합니다. 물리 디스플레이 주사율과 그리기 시간보다 빠르게 패킷마다 별도 화면을 표시한다는 뜻은 아닙니다.

마우스·키 입력도 즉시 화면을 갱신합니다. 아무 이벤트가 없을 때의 1초 대기는 연결 경과시간·시계 표시만 위한 것이며, 새 TCP 이벤트가 오면 즉시 해제됩니다. STATUS 재조회는 2초, 장치 재탐색은 탐색 완료 후 5초입니다. `ANOMALY_EVENT`를 제공하는 DAQ의 판정은 도착 즉시 반영합니다. 웹 서버에서만 생성하는 이상진단 결과는 직접 DAQ 연결에 포함되지 않습니다.

## 데이터 범위와 한계

- AM6442의 mixed stream v3를 우선 사용합니다. ADS8688은 `code × 20.48 / 65536 − 10.24` V, NU40은 signed code × 0.000061 g로 변환합니다. NU40 값은 보드에서 median(10) → moving average(10)를 거친 스트림이며 이상진단은 raw 입력을 사용합니다. 서버의 센서 이름·affine calibration·극성은 적용하지 않습니다.
- 채널 목록과 단위는 discovery v2 / STATUS capability를 사용합니다. `streamAvailable=false` 채널은 다른 ADC 값으로 대체하지 않습니다.
- 이력은 DAQ당 32,000 scans의 메모리 링입니다. 예를 들어 1,000 SPS에서 약 32초, 2,000 SPS에서 약 16초입니다. CSV는 이 범위 안의 표시 구간이며, 상시 디스크 기록이나 보드 전체 아카이브 export가 아닙니다.
- CRC 실패는 버리고 집계합니다. sequence 누락, 재접속, rate 변경 지점은 선을 잇지 않습니다. 보드 타임스탬프/record가 되돌아가면 이전 세션 이력을 지웁니다.
- 자동 재접속은 최신 LIVE부터 시작합니다. 누락된 과거 데이터의 자동 backlog 재생은 하지 않습니다. 로컬 저장·복구는 기존 보드 데몬/서버의 기능을 그대로 사용하세요.
- 그래프는 많은 점을 표시할 때 구간별 극값과 단절 경계를 보존해 그립니다. 원본 이력과 CSV를 다운샘플하지 않습니다.
- 다중 클라이언트 수는 펌웨어별 제한을 따릅니다(현재 ESP32-P4 기본 4개). 제어 시 확인용 TCP 연결 하나를 추가로 사용하므로 연결 슬롯이 가득 차면 제어가 실패할 수 있습니다.
- 인증/TLS 없는 기존 프로토콜이므로 신뢰된 LAN에서만 사용하세요. 앱은 DHCP/보드 네트워크/펌웨어/전원을 바꾸지 않습니다.

## 검증

```powershell
.\.venv-client\Scripts\python.exe -m unittest discover -s tests -v

# 장비 없이 화면 초기화/종료 확인 (가짜 데이터를 앱에 표시하지 않음)
.\.venv-client\Scripts\python.exe -m live_console --headless --seconds 2 --screenshot .meta/live_console/empty.png
```

`tests/test_live_console.py`는 localhost 테스트 DAQ로 2대 동시 수신, 한 DAQ의 다중 클라이언트, 분할 패킷과 timeout 경계, 재연결, capability/UUID/명령 read-back, 수신 이벤트 기반 갱신, 원본 CSV, 화면 정지 중 수신을 검증합니다. SDL dummy로 렌더링과 작은 창 배치도 확인합니다. 테스트 파형은 테스트 파일에만 존재하며 실제 앱에 demo/fake 데이터 모드는 없습니다.
