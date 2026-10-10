# R5FSS1-0 ADS1263 / STM32-compatible bring-up

This firmware owns MAIN_SPI1 and R5FSS1-0 only. Leave ADS8688 and Linux running.

## Reference and transaction sequence

The reference is the active `ads1263_init` / `ads1263_scan_dual_strain` path
in the locally stored pressure STM32 example, not its unused RDATA helper.
The thermocouple example has different register values; this comparison uses
the **pressure configuration for both AIN0-AIN1 and AIN6-AIN7**, as requested.
It is not a calibrated temperature/pressure conversion.

1. GPIO RESET low 1 ms, high 60 ms; CS stays an output, high when idle.
2. CS low: byte-wise `20 06 00 00 00 00 00 00 00`; CS high.
3. CS low: byte-wise `40 06 00 11 05 00 00 8B 0A`; CS high; wait 10 ms.
4. Read MODE0/1/2/INPMUX with the same four 3-byte RREG transactions.
5. Send START1 `09`, even when observed ID/settings do not match.
6. Select input with `46 00 01` or `46 00 67`, then hold that input until
   DRDY is LOW. No STOP, START, register readback or fixed settling slot.
7. CS low: transmit five zeros, receive status at byte 0 and signed 32-bit
   data at bytes 1–4; CS high. Repeat from step 6.

SPI: mode 1, 8-bit, MSB first, full-duplex DMA, blocking until completion.
PKTDMA resources are allocated by the SDK from this R5's resource partition;
an own-host range check refuses SPI open if that partition is absent.
TX/RX buffers occupy separate aligned cache lines with explicit cache maintenance.

Remaining platform differences: STM has a 4.5 MHz SPI clock; AM64's 50 MHz
source / 12 gives approximately 4.167 MHz (configuration-derived, not measured).
DMA setup and inter-byte timing depend on each MCU/SDK. There is one ADS1263
and two selected input pairs here, versus two devices and four pairs in the
pressure reference. Code matching does not prove matching electrical waveforms.

## DRDY and integrity semantics

A long DRDY wait **never** advances the mux or restarts conversion.
Every second, raw diagnostics report WAITING with no read and no fabricated
zero sample. STOP, RESET, remoteproc shutdown, and the five-second lost-client
diagnostic lease remain responsive. The lease is not a conversion timeout:
regular client heartbeats permit an arbitrarily long wait.

MODE1=00 / MODE2=8B means SINC1 / PGA bypass / ADC setting 4800 SPS.
That is not the per-input delivered sample rate. A126 rate fields are zero
(unmeasured); derive actual readout rates from timestamps.
INTERFACE=05 still enables the ADC's status and additive checksum, but STM
clocks only five bytes, so the checksum is **not read or validated**.
RPMsg frame CRC32 is separate and remains validated.
The legacy A126 crcErrors field stays zero; it is not proof of ADC integrity.

Normal A126 v2 samples require matching startup observations, DRDY LOW,
ADC1-new status, and a complete fresh pair. Explicit diagnostic mode can
expose bytes even if startup checks failed; it does not publish production data.
D126 **v3** is 36 bytes: logical channel 1/2, length 5 for an attempted read or
0 for a wait/error, seven-byte RX storage (two padding bytes), flags and CRC32.
Flag bit 1 means MUX write transport completed, **not** ADC readback verified.
Update firmware, board helper and viewer together; v1/v2 diagnostics are rejected.

## Build and debug

```powershell
.\build.ps1 -Profile debug
```

Debug ELF for CCS: `ti-arm-clang/r5_ads1263.debug.out` (-g, -O0 and Debug SDK
libraries). Load symbols for MAIN_Cortex_R5_1_0 only when Linux remoteproc has
already loaded this build. Do not reset the whole device or run DDR-init GEL.
Remoteproc image: `ti-arm-clang/am64-main-r5f1_0-fw`.
An explicit `-Profile release` build remains available.

Pin directions and read-only startup diagnostics are unchanged; see
`hardware/j4-ads1263.md`. START remains grounded for command control.
No Linux DT or J4 power change is needed for this experiment.

Hardware acceptance remains incomplete. This experimental path is not yet
enabled in the ADS8688 production stream. Test records and STM reference sources
are kept in ignored `.meta/` / `.ref/`; do not infer hardware success from build
or protocol-test success.
