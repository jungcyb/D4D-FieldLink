# M4F ADS8688 acquisition

AM64x SK의 M4F에서 J9 `MCU_SPI0`으로 ADS8688을 취득하고 MAIN R5FSS0-0에 RPMsg frame을 보내는 firmware다.

## 현재 범위

- MCU_SPI0: mode 1, 12.5 MHz, D0=MOSI, D1=MISO, CS0 active-low
- J9 pin 11 (`MCU_GPIO0_7`)을 `RST/PD` output으로 사용
- hardware reset, program register read/write/verify
- 8채널 `AUTO_RST`, 기본 ±2.5×VREF 범위
- 8채널 scan마다 CRC가 있는 48-byte RPMsg frame 전송
- Linux→R5→M4 `START`, `STOP`, `SET_RATE` 제어와 ACK
- 기본 1,000 scan/s, 검증 범위 10–2,000 scan/s

현재 검증 범위에서는 polling SPI로 오류 없이 동작한다. 더 높은 속도는 여러 scan을 한 RPMsg에 묶은 뒤, M4 CPU 사용률이나 SPI 지터가 병목으로 확인될 때 DMA 이중 버퍼를 추가한다.

## 빌드

```powershell
.\build.ps1
```

기본 `out` target은 Linux remoteproc용 ELF를 만든다.

```text
ti-arm-clang/m4_ads8688.release.out
```

SBL용 signed appimage까지 필요할 때는 Git for Windows의 OpenSSL을 PATH에 넣는 `all` target을 사용한다.

```powershell
.\build.ps1 all
```

실제 배선과 전원 조건은 `hardware/mcu-header-ads8688.md`를 따른다.
