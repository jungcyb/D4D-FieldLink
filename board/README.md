# AM6442 보드 설치와 운영

## 새 Armbian 설치 후

네트워크 설정을 바꾸기 전에 Ethernet DHCP, SSH, 재부팅 복귀를 먼저 확인한다. 그 다음 `bootstrap.sh`를 복사해 Python 3.13과 기본 도구를 준비한다.

```powershell
scp .\board\bootstrap.sh root@<BOARD_IP>:/tmp/bootstrap.sh
ssh root@<BOARD_IP> 'chmod +x /tmp/bootstrap.sh; /tmp/bootstrap.sh --check'
ssh root@<BOARD_IP> '/tmp/bootstrap.sh --install'
```

스크립트는 네트워크·NTP·Device Tree·remoteproc firmware를 바꾸지 않는다. 설치 전 DTB, boot environment, 기본 remoteproc firmware는 `/var/backups/ads8688-initial`에 보존한다.

## 빌드와 배포

PC의 `.meta/connection.txt`에는 사용자와 인증 정보, `.meta/client/host.txt`에는 현재 보드 접속 주소를 둔다. Wi-Fi 또는 Ethernet 중 실제 접속할 주소를 사용한다. 새 환경에서는 `tools/connection.example.txt`를 복사해 설정한다. `.meta/`는 Git에서 제외하며, 비밀번호는 스크립트나 서비스 파일에 복사하지 않는다.

```powershell
.\tools\deploy.ps1
```

이 명령은 M4/R5를 함께 빌드하고, 보드에 firmware·데몬·systemd unit을 설치한 뒤 서비스를 활성화한다. 이미 빌드한 결과를 배포할 때는 `-SkipBuild`, 주소를 바꿀 때는 `-BoardIp <IP>`를 쓴다.

## 서비스

```bash
systemctl status ads8688-phase2.service
journalctl -fu ads8688-phase2.service
/opt/ads8688/activate_phase2.sh status
```

서비스 시작 시 MAIN R5F0_0과 MCU M4F를 프로젝트 firmware로 올리고, 종료 시 원본 firmware로 복원한다. remoteproc 번호는 부팅마다 바뀔 수 있어 sysfs의 core 이름으로 찾는다.

`ads8688d`는 다음을 한 프로세스에서 수행한다.

- RPMsg 8채널 frame 검증과 sequence 추적
- `/var/lib/ads8688/data`의 256 MiB segment 순환 기록
- 매초 `fsync`, `.part` 복구, 10% 또는 2 GiB OS 예약 공간 유지
- UDP 8764 검색, TCP 8765 제어·라이브·누락 데이터 조회
- UUID를 `/var/lib/ads8688/identity`에 영구 보존

기본 scan rate는 채널당 1,000 scan/s이고 v1 보장 범위는 10–2,000 scan/s이다. 현재 범위에서는 DMA가 필요하지 않다. 더 높은 속도는 RPMsg에 여러 scan을 묶은 뒤 SPI CPU/지터 계측에 따라 DMA 이중 버퍼를 추가한다.

네트워크 프로토콜과 단절 복구 절차는 `docs/PROTOCOL.md`에 있다.

## ADS1263 독립 R5FSS1-0 경로

새 ADS1263 펌웨어는 기존 ADS8688 서비스와 다른 R5FSS1-0 및 MAIN_SPI1을
사용한다. 배선은 `hardware/j4-ads1263.md`를 따른다.

```powershell
# 빌드하고 보드에만 복사 (실행 중 코어는 변경하지 않음)
.\tools\deploy_ads1263.ps1

# 외부 전원 배선 완료 후 R5FSS1-0을 교체하고 3초 스모크 테스트
.\tools\deploy_ads1263.ps1 -SkipBuild -Activate
```

보드에서 직접 재시험하려면
`/opt/ads1263/ads1263_smoke.py --reset --seconds 5`를 실행한다. 원본
R5FSS1-0 펌웨어 복귀는 `/opt/ads1263/activate_ads1263.sh stop`이다.
기본값은 외부 전원이며 J4 전원은 건드리지 않는다. 예전 J4-1 전원 방식만
`-PowerSource header`를 명시한다. `PASS`는 온라인 상태뿐 아니라 두 입력의
새 샘플과 RPMsg 프레임 CRC32까지 확인했을 때만 출력한다. 현재 STM 비교
모드는 ADC 체크섬 바이트를 읽지 않으므로 ADC 데이터 무결성 인증은 아니다.

현재 비교 시험 펌웨어는 ADC2를 정지시키고 AIN0/AIN1·AIN6/AIN7 모두 ADC1로
순차 변환한다. STM 압력 예제의 4800 SPS/SINC1/PGA bypass 설정을 공유한다.
MUX 쓰기 후 DRDY가 LOW가 될 때까지 같은 입력을 유지하며, 대기 시간이 길어도
채널 변경·변환 재시작을 하지 않는다. 1초마다 대기 상태만 보고한다.
실제 채널별 속도는 타임스탬프로 측정해야 한다. A126은 version 2,
D126은 version 3이므로 펌웨어와 Python 도구를 함께 배포한다.
이는 별도 진단 경로이며 아직 ADS8688 TCP 수집·검색 서비스와 통합되지 않았다.
