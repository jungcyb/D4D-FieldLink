# 로컬 하드웨어 문서

2026-10-10 기준 TI 공식 자료를 로컬 `.meta/docs/ti/`에 보관한다. 아래 파일명은 `.meta/docs/` 기준이며, 대용량 PDF와 ZIP은 Git에서 제외한다. 새 환경에서는 아래 공식 원본과 SHA-256을 이용해 자료를 준비한다.

| 로컬 파일 | 문서 | 공식 원본 | SHA-256 |
|---|---|---|---|
| `ti/ADS868x-datasheet-SBAS582.pdf` | ADS8684/ADS8688 datasheet, Rev. C | https://www.ti.com/lit/pdf/sbas582 | `c776e2307a48d547c394e1b778dcec2433b8c485a88cd6796da963bd2514eb6a` |
| `ti/AM64x-AM243x-TRM-SPRUIM2.pdf` | AM64x/AM243x TRM, Rev. J | https://www.ti.com/lit/pdf/spruim2 | `cf4d8786c48330d798e1718055aca1fe938693f62977d628a38ba1bf77abbb2c` |
| `ti/AM64x-SK-EVM-user-guide-SPRUIY9.pdf` | AM64x SK EVM User Guide, Rev. C | https://www.ti.com/lit/pdf/spruiy9 | `e9592e6aa41c02347d444b2921a2feae26d5cda20592150bc53bb9929e01f691` |
| `ti/AM64x-datasheet-SPRS916.pdf` | AM64x Sitara Processor datasheet, Rev. J | https://www.ti.com/lit/ds/symlink/am6422.pdf | `dfa1436ece7c5be321e07a9b0714b4bcbf5b87831b5302892922ca75da289225` |
| `ti/AM64x-AM243x-silicon-errata-SPRZ457.pdf` | AM64x/AM243x silicon errata, Rev. J | https://www.ti.com/lit/pdf/sprz457 | `85f37a9ceed19ce7914cd033a6b7fc2d3ba438875b25eb2e05f905f283089504` |
| `ti/SK-AM64B-design-files-SPRR460.zip` | SK-AM64B design files, Rev. C | https://www.ti.com/lit/zip/sprr460 | `8f02af5afc9909c6a6814a1b5c789c3ba58624a1ffd06345a8ee21625aa7aea3` |
| `ti/SK-AM64B-schematic-PROC100A-002.pdf` | 위 설계 ZIP에서 추출한 최신 표시 회로도 | `SPRR460` 내부 | 로컬에서 `Get-FileHash`로 확인 가능 |
| `ti/SK-AM64B-schematic-revision-readme.pdf` | 회로도 revision 안내 | `SPRR460` 내부 | 로컬에서 `Get-FileHash`로 확인 가능 |

MCU+ SDK 11.02의 오프라인 API 문서는 다음 위치에 이미 설치되어 있다.

```text
C:\ti\mcu_plus_sdk_am64x_11_02_00_24\docs\api_guide_am64x
```

온라인 기준 자료:

- MCU+ SDK 최신 문서: https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/
- MCU+ SDK 다운로드/호환 도구: https://www.ti.com/tool/download/MCU-PLUS-SDK-AM64X
- Processor SDK Linux AM64x: https://www.ti.com/tool/PROCESSOR-SDK-AM64X
