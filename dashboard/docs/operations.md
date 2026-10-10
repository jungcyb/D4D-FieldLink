# 연결·복구·로그·장애 사건·CLIKA

## 시연 순서

1. `/equipment`: 모든 센서 상태·추이와 선택 센서의 Raw·진단·설치 사진을 전체 페이지에서 확인한다.
2. `/dependencies`: 발전기 → 냉각장치·펌프 관계와 자동 장애 사건을 확인한다. 펌프 자체 진단은 정상이어도 상위 필수 공급 장애의 영향은 별도로 표시된다.
3. `/recovery`: DAQ를 선택해 정책 저장 → 모의 단절 → 모의 재연결 → 모의 엣지 데이터 복구를 실행한다. 이 버튼은 `DAQ_MODE=demo`에서만 노출된다.
4. `/logs`: `RECOVERY`, `DAQ_DISCONNECTED`, `DAQ_RECONNECTED` 코드로 검색하고 상세 metadata를 펼친다.
5. AI 채팅 플로팅 버튼: DAQ·센서·배치 선택 → 현재 상태 질문. 부착 위치·설치 사진은 `/equipment`에서 관리한다.

## 연결 감지와 복구 정책

보드 UUID는 보드가 발급한다. 서버가 마지막 보드 응답·프레임·heartbeat·로그를 받은 시각으로 30초 제한을 적용한다. 대시보드가 5초마다 조회하고 상태 전환 이벤트를 기록한다. **TCP 소켓 자체 상태가 아니라 응답 기준 상태**이며, 별도 백그라운드 감시 프로세스는 없다. API 요청 또는 수집기 heartbeat에서 상태를 조정하므로 대시보드와 수집기가 모두 중단된 동안에는 즉시 감지하지 않는다.

정책은 마지막 저장 시각 이후 / 최근 1시간 / 최근 24시간 / 사용자 기간 / 자동 복구 안 함을 지원한다. Raw·Log 각각 선택하며 요청별 비압축 JSON 원본 상한은 기본 32 MB, 최대 128 MB다. 사용자 입력 시각은 KST이며 API는 시간대가 있는 ISO 8601을 사용한다.

마지막 저장 시각 정책은 Raw의 센서별 최신 배치 시작 시각 중 가장 이른 시각과 엣지 로그 최신 시각을 비교해 중첩 재전송한다. 서버 이벤트 시각은 엣지 로그 체크포인트에 사용하지 않는다. 이 정책은 **시간 기반 재전송**이며 영구 acquisition sequence 체크포인트를 대신하지 않는다. 완전성은 엣지가 완료 범위와 누락 구간을 정확히 보고한다는 계약에 의존한다. 같은 요청·배치 순서 재전송은 내용 hash로 중복 처리한다. 다른 요청의 중첩 데이터는 별도 수신 레코드·아카이브로 남을 수 있다.

재연결 시 진행 중인 복구가 없으면 저장 정책에 따라 요청을 하나 생성한다. 복구 기간 끝은 요청 생성 시각으로 고정된다. 요청을 취소하면 접수된 원본을 지우지 않는다. 모든 복구 원본은 `data/recovery/<mode>/<planId>/batch-000000.json.gz`에 보관한다. 최근 그래프 저장소는 센서당 720배치로 제한하므로 오래된 복구 데이터는 그래프에서 빠져도 다운로드 원본에 남는다. 요청별 manifest에 파일명·SHA256·배치 개수를 기록한다. JSON 파일 저장소는 단일 Node 프로세스용이다.

## 엣지 수집기가 연결할 API 계약

이것은 대시보드의 정규화된 HTTP 계약이다. 실제 UDP 발견·DAQ TCP 접속·재접속·엣지 저장은 보드 담당 수집기가 구현하고 이 API를 호출한다. TCP 와이어 프로토콜은 아직 결정하지 않았다.

| 메서드 | 경로 | 목적 |
|---|---|---|
| POST | `/api/edge/heartbeat` | `{daqUuid}` 응답 갱신 |
| POST | `/api/edge/logs` | `{daqUuid,batchId,logs:[...]}` 최대 100개 수신 |
| GET | `/api/edge/recovery?daqUuid=...` | 해당 DAQ의 진행 중 요청 조회 |
| PATCH | `/api/daqs/:uuid/recovery-policy` | 정책 저장 |
| POST | `/api/recoveries` | `{daqUuid}` 수동 요청 |
| POST | `/api/recoveries/:id/batches` | 순서 배치 수신 |
| POST | `/api/recoveries/:id/complete` | 범위 완료 선언 |
| POST | `/api/recoveries/:id/cancel` | 요청 취소 |
| GET | `/api/recoveries/:id/manifest` | 전체 원본 목록 |
| GET | `/api/recoveries/:id/batches/:sequence` | gzip 다운로드 |
| GET | `/api/logs?daq=...&level=...&q=...&from=...&to=...&offset=0&limit=50` | 필터·페이지 조회 |

`EDGE_API_TOKEN`이 설정되면 모든 edge 경로와 복구 batches/complete에 Bearer 인증이 필요하다. JSON 요청은 4 MB 이하로 나눈다. Raw readings는 기존 `/api/edge/frames`와 같은 채널·시각·대표값·SPS·raw 형식이며 1~100개 레코드, 각 raw는 최대 4,096개 유한 숫자다. 복구에는 과거 진단을 섞지 않는다. 새로운 진단은 실시간 프레임으로 보내야 한다.

```json
{
  "sequence": 0,
  "batchId": "boot-42:buffer-1001",
  "frame": {"readings": [{"channel":"CH-1","timestamp":"2026-10-10T02:00:00.000Z","value":1.2,"sps":1000,"raw":[0.1,0.2]}]},
  "logs": [{"timestamp":"2026-10-10T02:00:00.000Z","level":"warning","code":"BUFFERED","message":"연결 단절 중 저장","metadata":{}}]
}
```

sequence는 0부터 순서대로 보낸다. 성공 응답 `nextSequence`를 저장하고 실패 시 같은 내용으로 재전송한다. 같은 sequence에 다른 내용은 409, 순서 누락은 409, 상한 초과는 413이다. Raw·Log 시각은 요청 범위 안이어야 한다. Raw 배치의 마지막 샘플 시각도 종료 범위를 넘지 않아야 하므로 경계 배치는 엣지가 잘라 보내야 한다. 전체 배치가 검증되어야 원본과 조회용 이력이 접수된다. 다음 선언에서 `finalSequence`는 마지막 접수 sequence, 배치가 없으면 -1이다.

```json
{
  "edgeComplete": true,
  "rawCoveredThrough": "2026-10-10T02:01:00.000Z",
  "logsCoveredThrough": "2026-10-10T02:01:00.000Z",
  "finalSequence": 0,
  "missing": [{"stream":"raw","from":"2026-10-10T02:00:00.000Z","to":"2026-10-10T02:00:10.000Z","reason":"보관 한계로 원본 만료"}]
}
```

활성 스트림의 coveredThrough는 요청 to 이상이어야 한다. 누락이 있으면 `completed_with_gaps`, 없으면 `completed`다. **완료 상태는 엣지의 전송 완료 선언을 검증한 결과**다. 서버가 수집 연속성을 독립적으로 증명한 결과는 아니다. 운영 로그 조회용 최근 10,000개, 복구 Raw·Log 원본은 별도 보관한다. 로그에는 원본 센서 배열·인증 토큰을 기록하지 않는다.

## 설비 선후관계와 사건 묶기

`POST /api/dependencies`에 `{from,to,kind,required,description}`을 보내고 `DELETE /api/dependencies/:id`로 관계를 제거한다. 방향은 선행 공급 → 후행 의존이다. 자기 참조·중복·순환을 거부한다. kind는 power/cooling/fluid/control/other다.

최신 위험 진단 장비 중 다른 위험 장비의 필수 하위에 속하지 않는 설비를 원인 후보로 삼는다. 연결된 후행 설비와 관련 최신 주의·위험 진단을 사건으로 묶는다. 필수 경로는 운용 불가 추정, 보조 경로 또는 상위 주의는 영향 가능으로 표시한다. 센서 정상 상태·RUL은 바꾸지 않는다. 이것은 등록한 그래프 기반 휴리스틱이며 확정 고장 원인이나 통계적 고장 확률이 아니다. 센서 고장만으로 설비 운용 여부를 확정하지 않도록 화면에 추정으로 표시한다.

`POST /api/incidents/merge`의 `{ids,title}`로 2~10개 사건을 수동 통합한다. 기존 사건은 merged로 보존한다. `POST /api/incidents/:id/acknowledge`는 확인 처리이며 진단 해제가 아니다. 원인 후보의 위험 진단이 해소되면 자동 종료한다.

## CLIKA 위치 분석 API 참고 (별도 화면 없음)

독립 센서 위치 추적 페이지는 제거했다. 아래는 기존 위치 분석 API의 연결 참고이며, 센서의 기본 부착 위치·사진과 저장된 자료는 유지한다. CLIKA의 주 사용처는 AI 채팅의 추론 모델이며 RAG 처리 계층에서 연결한다. AI 채팅 계약과 배치 방식은 `docs/rag.md`를 참고한다.

설치 자료가 공용 클라우드로 전송되지 않도록 기본 주소는 `http://127.0.0.1:8000/v1`이다. 로컬·사설 주소를 허용하며 폐쇄망 DNS 별칭은 `CLIKA_ALLOWED_HOSTS`에 명시한다. 실행할 모델은 CLIKA 서버의 `/v1/models`가 반환하는 ID로 지정한다.

```dotenv
CLIKA_BASE_URL=http://127.0.0.1:8000/v1
CLIKA_MODEL=<local-vision-model-id>
CLIKA_API_TOKEN=
CLIKA_STRUCTURED_OUTPUT=prompt
```

CLIKA 런타임·모델 파일·오프라인 라이선스는 현장 제공본으로 준비한다. 이 프로젝트는 이를 다운로드하거나 설치하지 않는다. 배포판에 따라 명령 이름이 `clika-modelverse` 또는 `clikart-cli`이므로 제공된 실행 파일의 help를 확인한다. 공식 offline 문서의 실행 형태는 `clika-modelverse ./<local-model-dir> serve --offline`이며, 네트워크 차단 보장을 위해 로컬 모델과 offline 설정을 사용하고 offline 라이선스를 준비한다. 상세 절차: [CLIKA offline 실행](https://docs.clika.io/modelverse/how-to/run-fully-offline/index.html), [CLIKA 로컬 HTTP 서빙](https://docs.clika.io/modelverse/how-to/serve-openai-compatible/index.html).

서버는 `/v1/chat/completions`로 동기화된 모델 요청을 보낸다. 이미지 data URI와 UTF-8 텍스트를 사용한다. PDF는 저장하되 선택 페이지를 브라우저의 로컬 PDF.js로 이미지 변환해 전달한다. 모델은 비전 입력을 지원해야 한다. 모든 PDF.js 리소스는 `public/vendor/pdfjs`에 포함하며 CDN을 사용하지 않는다 (PDF.js 5.6.205, Apache 2.0 LICENSE 동봉).

기본은 JSON 출력 지시 + 서버 검증이다. 제공 런타임이 구조화 schema 출력을 지원한다고 확인한 경우에만 `CLIKA_STRUCTURED_OUTPUT=schema`를 사용한다. 센서 ID·자료 ID·정규화 이미지 좌표·신뢰도 범위를 검증하고, 자료 근거와 미확인 제안을 저장한다. 위치 승인 API만 센서 position을 변경한다. 이미지 좌표는 고장 부위 확정값이 아니며 모델이 찾은 근거 위치 후보다.

현재 검증은 로컬 CLIKA HTTP 형식에 대한 모의 응답 계약 테스트까지다. 이 PC에 실제 CLIKA 런타임·모델이 없어 실모델 추론은 검증하지 않았다. 키·모델이 설정되지 않으면 위치 분석 API는 설정 오류를 반환하며 가짜 분석 결과를 생성하지 않는다.

## 검증

`npm test` 22개, TypeScript 검사, `npm run build` 통과. 복구 원자성·순서·재전송·완료 범위·용량·데모 연결 유지, 그래프 사이클·정상 하위 영향 분리·사건 통합, CLIKA 로컬 자료 전송·잘못된 센서 거부·승인 전 위치 보존을 테스트한다. UI 검증용 데이터는 별도 임시 DATA_DIR를 사용했으며 사용자의 실제 데이터 파일에 시연 이력을 추가하지 않았다.
