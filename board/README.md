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
