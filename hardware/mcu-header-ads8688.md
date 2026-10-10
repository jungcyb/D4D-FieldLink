# AM64x SK MCU 헤더 ↔ ADS8688 배선 기준

작성일: 2026-10-10

## 결론

ADS8688은 AM64x SK의 MCU 확장 헤더 J9에 있는 `MCU_SPI0`을 M4F 펌웨어가 직접 사용한다. Linux에는 이 SPI 컨트롤러를 노출하지 않는다.

현재 실행 중인 Device Tree에서 다음 상태를 확인했다.

- `spi@4b00000` (`MCU_SPI0`): `status = "disabled"`
- `gpio@4201000` (`MCU_GPIO0`): `status = "reserved"`
- `/dev/spidev*`: 없음

따라서 Linux와 M4F의 소유권 충돌은 없다. 지금 DT를 바꿔 Linux `spidev`를 활성화하면 오히려 충돌을 만든다. M4F SysConfig가 MCU domain pinmux와 peripheral을 설정하는 구성을 유지한다.

검사 당시 DTB와 boot environment는 로컬 `.meta/backups/board-20261010/`에 보관했다 (Git 제외).

## 연결 전 필수 조건

1. SK와 ADS8688 전원을 모두 끈 상태에서 배선한다.
2. ADS8688 digital I/O 전압은 `DVDD = 3.3 V`여야 한다. `DVDD = 5 V`인
   모듈을 level shifter 없이 J9에 직접 연결하지 않는다.
3. ADS8688 analog supply는 `AVDD = 5 V`가 필요하다. J9에는 5 V가 없으므로
   별도 regulated 5 V 전원을 사용한다.
4. 외부 5 V 전원의 GND, ADS8688 AGND/DGND, SK J9 GND를 공통으로 연결한다.
5. `J9 pin 1`은 3.3 V/100 mA 한도이다. 여기에 5 V를 절대 넣지 않는다.

## J9 배선

| ADS8688 신호 | AM64x SK J9 | SoC 신호 | 방향 |
|---|---:|---|---|
| `SCLK` | 18 | `MCU_SPI0_CLK` | M4F → ADC |
| `SDI` (MOSI) | 6 | `MCU_SPI0_D0` | M4F → ADC |
| `SDO` (MISO) | 4 | `MCU_SPI0_D1` | ADC → M4F |
| `/CS` | 8 | `MCU_SPI0_CS0` | M4F → ADC |
| `RST/PD` | 11 | `MCU_GPIO0_7` | M4F → ADC |
| `DGND/AGND` 공통점 | 7, 15, 20 또는 27 | GND | 공통 |

ADS8688에는 `RVS`와 `CONVST` 핀이 없다. `/CS` 하강 에지에서 선택 채널을
샘플링하고 변환을 시작하므로 J9 pin 8의 hardware chip-select가 변환
트리거를 겸한다.

헤더는 보드 위에서 J9의 실크 `1` 또는 square pad를 먼저 찾은 뒤 아래처럼
센다. 케이블의 빨간 선만 믿고 방향을 정하지 않는다.

```text
J9 top view (pin 1 표식을 기준으로 확인)

  1   2
  3   4  <- SDO / MCU_SPI0_D1
  5   6  <- SDI / MCU_SPI0_D0
  7   8  <- GND, /CS
  9  10
 11  12  <- RST/PD
 13  14
 15  16  <- GND
 17  18  <- SCLK
 19  20  <- GND
 21  22
 23  24
 25  26
 27  28  <- GND
```

`/CS`와 `RST/PD`에는 ADC 쪽에서 DVDD(3.3 V)로 10 kΩ pull-up을 두는 것을
권장한다. 배선은 가능한 짧게 유지하고, 첫 시험에서는 10 cm 이내를 목표로
한다.

J9 pin 9(`TEST_LED2`/`MCU_GPIO0_5`)와 pin 10(`MCU_GPIO0_6`)은 보드 내 다른 기능과 연결되어 있으므로 사용하지 않는다.

## 전원 주의

- ADS8688 `AVDD`는 4.75–5.25 V가 필요하다.
- `DVDD`는 3.3 V로 구성해 J9의 3.3 V SPI 로직과 맞춘다.
- J9의 `VCC_3V3_SYS`는 100 mA 한도이며 5 V가 아니다. bare ADS8688의 `AVDD` 전원으로 사용할 수 없다.
- ADS8688 또는 ADC 모듈에는 별도의 안정된 5 V analog supply를 공급하고 SK와 ground를 공통으로 연결한다.
- 사용 중인 ADS8688 모듈에 5 V→3.3 V logic level shifter가 들어 있다면 방향과 지연이 17 MHz SPI 요구 조건을 만족하는지 확인한다.

### bare IC를 직접 연결하는 경우

완제품 모듈이 아니라 TSSOP-38 ADS8688을 직접 사용하는 PCB라면 다음도
필수다.

| ADS8688 pin | 연결 |
|---:|---|
| 1 `SDI` | J9 pin 6 |
| 2 `RST/PD` | J9 pin 11, 10 kΩ pull-up to DVDD |
| 3 `DAISY` | 단일 ADC이면 DGND |
| 4 `REFSEL` | 내부 4.096 V reference 사용 시 AGND |
| 5 `REFIO` | pin 6 `REFGND`에 10 µF decoupling |
| 6 `REFGND` | analog ground plane |
| 7 `REFCAP` | REFGND에 1 µF와 22 µF 병렬 decoupling |
| 8, 28, 29, 31, 32 `AGND` | ground plane |
| 9, 30 `AVDD` | regulated 5 V; 각 supply 근처 1 µF, rail에 최소 10 µF |
| 33 `DGND` | SK GND와 공통 |
| 34 `DVDD` | 3.3 V; pin 근처 10 µF |
| 35 `DNC` | 연결하지 않고 floating |
| 36 `SDO` | J9 pin 4 |
| 37 `SCLK` | J9 pin 18 |
| 38 `/CS` | J9 pin 8, 10 kΩ pull-up to DVDD |

브레드보드에 bare TSSOP IC를 길게 배선하는 방식은 reference decoupling과
12.5 MHz SPI 신호 무결성 때문에 권장하지 않는다. 가능하면 전원과
decoupling이 구현된 ADS8688 module/EVM을 사용한다.

## Analog input 연결

각 채널은 `AIN_nP`와 `AIN_nGND` 한 쌍이다.

```text
signal +/output  -> AIN_nP
signal return    -> AIN_nGND
```

`AIN_nGND`는 ADC ground 기준 -0.1 V에서 +0.1 V 범위에 있어야 한다. 원격
sensor라면 각 채널의 return 선을 대응하는 `AIN_nGND`까지 별도로 가져온다.
입력 신호를 넣기 전에 선택한 range 안에 있는지 multimeter로 확인한다.

내부 4.096 V reference 기준 지원 범위는 다음과 같다.

| firmware range | 허용 입력 범위 |
|---|---:|
| `BIPOLAR_2V5REF` (초기 기본값) | -10.24 V ~ +10.24 V |
| `BIPOLAR_1V25REF` | -5.12 V ~ +5.12 V |
| `BIPOLAR_0V625REF` | -2.56 V ~ +2.56 V |
| `UNIPOLAR_2V5REF` | 0 V ~ 10.24 V |
| `UNIPOLAR_1V25REF` | 0 V ~ 5.12 V |

내부 overvoltage protection은 최종 보호 장치가 아니다. surge/ESD/EFT가
가능한 외부 신호에는 별도 보호 회로를 둔다.

## SPI와 샘플레이트

- SPI: mode 1 (`CPOL=0`, `CPHA=1`), MSB first, 최대 SCLK 17 MHz.
- 한 변환 frame은 32 SCLK이다. 앞 16 bit로 다음 command를 보내고, 뒤 16 bit로 현재 conversion result를 받는다.
- `AUTO_RST` command는 `0xA000`, 8채널 enable register는 address `0x01`의 `0xFF`이다.
- ADS8688 전체 최대 속도는 500,000 conversion/s이며 8채널 round-robin이면 최대 62,500 channel-set/s이다.

프로토콜에서는 다음 두 값을 구분한다.

- `conversion_rate_hz`: ADC 전체 변환 횟수/초, 최대 500,000.
- `frame_rate_hz`: 선택 채널 한 세트/초. `conversion_rate_hz / 선택 채널 수`로 계산한다.

초기 안전 기본값은 8채널, `conversion_rate_hz = 80,000`, `frame_rate_hz = 10,000`으로 둔다. 신호 무결성과 처리량을 확인한 뒤 최대값까지 올린다.

현재 bring-up firmware의 SCLK는 12.5 MHz다. 80 kconversion/s에서는 변환
frame 주기 12.5 µs 안에 32-bit SPI 전송 약 2.56 µs가 들어가므로 충분한
여유가 있다.

## 최초 전원 투입 순서

1. 전원을 끈 상태에서 GND, 5 V AVDD, 3.3 V DVDD를 연결한다.
2. J9의 SCLK, SDI, SDO, `/CS`, `RST/PD`를 표대로 연결한다.
3. ADC 입력 신호는 아직 연결하지 않는다.
4. 전원을 켜고 multimeter로 ADS8688의 AVDD=약 5 V, DVDD=약 3.3 V,
   `/CS`=high, `RST/PD`=high를 확인한다.
5. ADC channel 0의 `AIN_0P`와 `AIN_0GND`를 둘 다 0 V에 연결한다.
6. 보드에서 register readback을 먼저 통과시킨 뒤 channel 0 code를 확인한다.
7. 그 다음 나머지 채널과 실제 입력 신호를 한 채널씩 추가한다.

## 실제 연결 전 확인 목록

- ADC 보드의 정확한 제품명/회로도와 AVDD/DVDD 구성
- J9와 ADC 보드의 pin 1 방향
- common ground와 5 V 전원 극성
- 입력 전압 범위 register 값
- 오실로스코프/로직 분석기로 `/CS`, SCLK, SDI, SDO 확인
