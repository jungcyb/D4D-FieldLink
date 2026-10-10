# R5FSS1-0 ADS1263 4채널 스캔 (remoteproc 빌드)

`ipc_rpmsg_echo_am64x-sk_r5fss0-0_freertos_ti-arm-clang/`의 CCS 프로젝트 소스
(`ads1263.c`, `ads1263_task.c`)를 그대로 R5FSS1-0용으로 빌드한다.
소스는 복사하지 않고 makefile이 그 디렉터리를 직접 참조한다. 이 빌드 전용은 `example.syscfg`와
`scan_main.c`(Linux remoteproc 종료 핸드셰이크)뿐이다. 커널 6.12 k3_r5는 펌웨어가
SHUTDOWN을 ACK하고 WFI에 들어가야 `stop`을 허용하므로, 이것이 없으면 재부팅 전까지 코어를 교체할 수 없다.

- 코어: R5FSS1-0 (ADS8688 서비스가 쓰는 R5FSS0-0과 분리)
- 메모리 맵·resource table: `r5_ads1263`과 동일 (DDR 0xA2000000~)
- SPI1 POLLED, DRDY=GPMC0_BE0n_CLE, RESET=GPMC0_ADVn_ALE
- 로그: UART 대신 Linux remoteproc trace (`/sys/kernel/debug/remoteproc/remoteprocN/trace0`).
  UART0은 Linux 콘솔이라 쓰지 않는다.

## 빌드·업로드·시험

```powershell
.\firmware\r5_ads1263_scan\build.ps1            # 빌드만 (설치된 최신 CCS/SysConfig 자동 선택)
.\tools\deploy_ads1263_scan.ps1                  # 빌드 → 보드 복사 → 5초 시험 → 기본 펌웨어 복귀
.\tools\deploy_ads1263_scan.ps1 -SkipBuild -Keep # 시험 후 스캔 펌웨어를 계속 실행
```

보드 접속 정보는 `.meta/connection.txt`(`tools/connection.example.txt` 참고).
보드에서 직접: `/opt/ads1263/ads1263_scan_test.py --seconds 10`.

판정(`RESULT PASS`) 조건: 초기화 에러 없음, ID 상위 3비트=001, MODE0/1/2/INPMUX=00 00 8B 0A,
4채널 모두 ADC1 new-data(status bit6) 샘플이 있고 코드가 0/-1로 고정되지 않음.
배선·신호 품질까지 보증하지는 않는다.
