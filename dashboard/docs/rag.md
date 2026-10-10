# RAG 현장 질의 API

대시보드는 선택한 현장 컨텍스트를 구성하고 RAG 처리 계층의 JSON 답변을 표시한다. RAG·CLIKA 로컬 추론은 별도 서버로 운영하거나 백엔드와 함께 배치할 수 있다. CLIKA 모드에는 현장 자료를 검색하는 로컬 BM25 계층이 있다. 벡터 DB·임베딩 모델·모델 실행기는 포함하지 않는다.

## CLIKA 로컬 모델 직접 연결

현재 AI 채팅을 localhost:8000 모델에 연결하는 설정이다. 브라우저 → POST /api/rag/query → Next 백엔드 → CLIKA /v1/chat/completions 순서로 요청한다. CLIKA의 OpenAI 호환 계약은 [공식 서빙 문서](https://docs.clika.io/modelverse/getting-started/first-model/chat-and-serve/index.html)를 참고한다.

```dotenv
RAG_BACKEND=clika
CLIKA_BASE_URL=http://127.0.0.1:8000/v1
CLIKA_MODEL=
CLIKA_CHAT_TIMEOUT_MS=120000
CLIKA_CHAT_MAX_TOKENS=1024
CLIKA_CHAT_MAX_INPUT_CHARS=40000
CLIKA_CHAT_CONTEXT_TOKENS=4096
CLIKA_RAG_TOP_K=8
```

`.env.local` 변경 후 Next 서버를 재시작한다. base URL에 서빙 루트 `http://127.0.0.1:8000`을 넣어도 `/v1`을 붙인다. `CLIKA_API_TOKEN`이 필요하면 서버 환경변수에 설정한다. API 키·요청 목적지는 브라우저에 전달하지 않는다.

`CLIKA_MODEL`이 비어 있으면 `/v1/models`의 모델이 하나일 때 자동 선택한다. 모델이 없거나 여러 개면 명시적인 오류를 반환한다. `GET /api/clika/status`에서 연결 여부와 모델 ID를 확인한다. `GET /api/rag/config`는 provider/model/timeoutMs를 포함하며 configured는 설정 여부이지 접속 성공이 아니다.

백엔드는 선택 범위의 최신 센서·진단·부착 위치, 최근 배치 통계, DAQ 로그, 설비 의존관계·사건을 개별 검색 자료로 구성한다. 질문의 단어와 한글 복합어를 BM25로 검색하고 명시한 센서·채널·위치, 위험 상태, 질문 유형을 함께 고려해 관련도 순으로 정렬한다. 전체 JSON·Raw 배열·UUID 목록을 프롬프트에 보내지 않는다. 실제 데이터는 서버 저장소에 남고 검색한 짧은 자료만 OpenAI 호환 messages로 전달한다. 일반 텍스트 응답을 기존 RagResult로 변환하므로 플로팅 채팅·세션 저장은 그대로 동작한다. 검색 자료는 [S1] 센서, [B1] 배치, [L1] 로그, [D1] 의존관계, [I1] 사건 표기로 전달하며 서버가 원본 ID를 매핑한다. 답변이 실제 전송한 표기를 인용한 경우에만 답변 근거로 연결한다. 질의에 전달한 자료는 답변 인용과 별도로 채팅에서 확인할 수 있다. 문서 검색 결과나 매뉴얼 인용을 생성하지 않는다. 사진은 경로 참조만 포함되며 이미지 bytes는 보내지 않는다.

이 구성은 **현장 데이터 검색 + CLIKA 답변 생성**이며 매뉴얼 문서 검색은 아직 포함하지 않는다. 검색은 현재 선택한 DAQ·센서, 선택한 최근 배치 수, 최근 DAQ 로그 20개와 관련 설비 범위에 한정한다. 모든 과거 기록을 검색했다는 뜻은 아니다. Raw 미리보기 전체 점은 모델에 보내지 않고 원본으로 계산한 최소·최대·평균·RMS를 사용한다.

**RAG도 모델 길이 제한을 없애지 않는다.** 기본 서버 컨텍스트 4,096토큰에서 출력 1,024토큰과 안전 여유 128토큰을 제외해 입력 예산 2,944토큰을 사용한다. `CLIKA_CHAT_CONTEXT_TOKENS`는 실제 `/props`의 n_ctx에 맞춘다. `/v1/messages/count_tokens`로 system·질문·자료·이전 대화를 합산하고, 예산에 맞는 관련도 순 자료를 최대 `CLIKA_RAG_TOP_K`개 선택한다. 토큰 계산 경로가 404/405/501이면 UTF-8 바이트 기반 보수적 상한으로 대신 계산하고 UI에 추정임을 표시한다. 다른 실패나 잘못된 토큰 응답은 숨기지 않는다.

이전 대화는 최근 최대 4개 메시지, 각 400자 이내를 사용하며 예산의 25%를 넘거나 자료 공간을 침범하면 오래된 대화부터 제외한다. 브라우저에 표시된 전체 기록은 삭제하지 않는다. 질문·최소 자료 자체가 너무 길면 질문을 나누라는 오류를 표시한다. 검색에서 제외된 센서·배치를 정상이나 점검 완료로 간주하지 않도록 전체 선택 범위의 상태 개수와 누락 안내는 항상 보낸다.

응답의 `retrieval`에는 후보·전송·제외 개수, 실제 전송 자료와 원본 ID, 입력 토큰·입력 예산·출력 예약·컨텍스트 창·사용한 이전 메시지 수·토큰 계산 방식을 포함한다. 해당 메타데이터는 모델 요청에 넣지 않는다. 채팅창에서 사용자가 확인할 수 있다. 질의에 전달한 검색 자료는 기본으로 접힌 영역을 눌러 펼친다. 자료마다 자료 번호·종류·근거 표기를 표시하고 개별 접기·펼치기를 지원한다. 각 자료 내용은 **항목 | 값** 표로 표시한다. 센서라면 센서명·채널·종류·부착 위치·상태·연결·최신 값·수집 시각·경과·진단·설명·예상 수명·이상 점수·고장 유형이 각 행이다. 배치·로그·설비 관계·사건도 해당 항목을 각각 행으로 표시한다. 전송한 값은 UI에서 180자로 잘라 숨기지 않는다. 구조화 fields는 응답 메타데이터에만 추가하고 모델 입력 길이는 늘리지 않는다. 기존 세션의 excerpt만 있는 자료도 항목을 복원해 표시한다. 헤더에 전달 개수, 아래에 후보·제외 개수와 이전 대화 메시지 수를 표시한다. 펼친 자료 영역은 스크롤할 수 있다. 답변에서 실제 인용한 근거는 별도로 유지한다. 센서 자료에는 시간 단위 RUL과 모델별 제공 상태, 미보정 이상 점수·임계값 및 고장 분류 점수가 포함된다. 기본 문자 제한은 추가 보호일 뿐 토큰 예산의 대체물이 아니다. 입력 과다·불완전 출력·잘못된 응답·모델 미선택·취소·타임아웃은 오류로 표시한다. 기본 요청 제한은 로컬 추론을 고려해 120초이며 1~300초로 설정할 수 있다.

## 별도 RAG 서버 연결 설정

`.env.local`에 **정확한 POST 질의 주소**를 지정하고 Next 서버를 재시작한다. 서버 형식이 정해지면 `lib/server/rag.ts`의 `query()` 요청·응답 변환만 수정하면 된다. 동일 호스트의 RAG 서비스 주소도 사용할 수 있다. 백엔드 프로세스에 RAG를 내장할 경우 같은 서비스 계층에서 내부 함수를 호출하도록 교체할 수 있으며 채팅 UI는 그대로 유지한다. HTTP로 함께 배치할 때 질의 주소를 `/api/rag/query` 자체로 지정하면 순환 호출되므로 실제 RAG 처리 엔드포인트를 지정한다.

```dotenv
RAG_BACKEND=rag
RAG_API_URL=http://127.0.0.1:8100/query
RAG_API_TOKEN=
RAG_ALLOWED_HOSTS=
```

로컬·사설 IP, `.local`, `.internal` 주소를 허용한다. 폐쇄망 DNS 별칭은 `RAG_ALLOWED_HOSTS`에 쉼표로 지정한다. 토큰은 Next 서버에서만 사용하고 브라우저에 보내지 않는다. 설정되지 않은 상태에서도 컨텍스트 확인은 가능하며, 실제 질의 버튼은 비활성화한다. 설정됨 표시는 접속 성공을 의미하지 않는다. 질의 실패·형식 오류·45초 타임아웃을 화면에 표시하며 모의 답변을 생성하지 않는다.

## 화면

모든 대시보드 페이지의 오른쪽 아래 **AI 채팅** 플로팅 버튼을 누른다. 데이터 선택 모달에서 DAQ·센서·최근 배치 수를 선택하고 **선택 완료 · 채팅 열기**를 누르면 채팅창이 열린다. 장비·센서 상세의 **이 센서로 AI 채팅** 버튼은 해당 센서를 미리 선택한다. 채팅창의 데이터 변경으로 범위를 다시 선택할 수 있다. 별도 AI 질의 페이지·사이드바 항목은 없으며, 기존 `/assistant` 주소는 운용 현황으로 이동한다. 센서별 최근 배치 수는 1/3/5/10개, 선택 센서는 최대 32개다. 컨텍스트 미리보기는 확인 시점에 생성하며 **실제 질의에서는 서버가 최신 데이터를 다시 구성**한다. 미리보기와 질의 사이에 데이터가 달라질 수 있다. 응답에 사용한 컨텍스트 시각·센서 수·배치 수를 함께 표시한다.

## 대시보드 API

| 메서드 | 경로 | 내용 |
|---|---|---|
| GET | `/api/rag/config` | 설정 여부·제한·계약 버전 |
| GET | `/api/rag/context?daqUuid=...&sensorIds=id1,id2&batchesPerSensor=5&includeRawPreview=false` | 구조화 컨텍스트 확인 |
| POST | `/api/rag/query` | `{question,daqUuid,sensorIds?,batchesPerSensor?,includeRawPreview?,history?}` |

서버가 DAQ 소속 센서를 검증한다. 클라이언트가 전송한 임의 context/status 값은 사용하지 않는다. 모든 응답은 기존 `{data:...}` / `{error:{code,message}}` 형식이다.

## 별도 RAG 서버에 보내는 JSON 계약

```json
{
  "schemaVersion": "fieldlink.rag.v1",
  "requestId": "dashboard-generated-request-id",
  "question": "현재 상태를 설명하고 우선 점검할 센서를 알려줘",
  "history": [{"role":"user","content":"이전 질문","daqUuid":"board-issued-uuid","sensorIds":["sensor-id"]},{"role":"assistant","content":"이전 답변","daqUuid":"board-issued-uuid","sensorIds":["sensor-id"]}],
  "selection": {
    "daqUuid": "board-issued-uuid",
    "sensorIds": ["sensor-id"],
    "batchesPerSensor": 5,
    "includeRawPreview": false
  },
  "context": {
    "capturedAt": "2026-10-10T04:00:00.000Z",
    "mode": "external",
    "daq": {"uuid":"board-issued-uuid","label":"DAQ-GEN-01","ip":"192.168.10.101","port":9000},
    "equipment": {"id":"equipment-id","name":"발전기","location":"발전실"},
    "sensors": [{"id":"sensor-id","channel":"CH-1","type":"vibration","position":"구동측 베어링","sps":1000,"unit":"g"}],
    "status": {
      "daqOnline": true,
      "heartbeatAgeMs": 1200,
      "connection": null,
      "equipmentSeverity": "warning",
      "dependencyImpact": null,
      "sensors": [{"sensorId":"sensor-id","online":true,"severity":"warning","latestValue":1.2,"latestTimestamp":"2026-10-10T03:59:59.000Z","dataAgeMs":1000,"diagnosis":null}]
    },
    "placement": {"equipmentLocation":"발전실","sensors":[{"sensorId":"sensor-id","channel":"CH-1","position":"구동측 베어링","photoRef":null}]},
    "batches": [{"id":"reading-batch-id","sensorId":"sensor-id","channel":"CH-1","timestamp":"2026-10-10T03:59:59.000Z","endTimestamp":"2026-10-10T03:59:59.001Z","sps":1000,"value":1.2,"unit":"g","sampleCount":2,"source":"external","rawSummary":{"min":0.1,"max":0.2,"mean":0.15,"rms":0.1581}}],
    "coverage": {"batchesPerSensor":5,"rawPreviewIncluded":false,"rawPreviewLimitPerBatch":32,"perSensor":[{"sensorId":"sensor-id","availableBatches":1,"includedBatches":1,"from":"2026-10-10T03:59:59.000Z","to":"2026-10-10T03:59:59.000Z"}]},
    "related": {"equipment":[],"dependencies":[],"incidents":[],"logs":[]}
  },
  "instructions": "현장 컨텍스트 해석·근거 인용 안내"
}
```

위 예시는 일부 장비·센서 필드를 줄였다. 실제 타입은 `lib/rag-types.ts`에 있다. 상태에는 최신 엣지 진단·RUL·데이터 경과 시각, 그래프 기반 상위 영향 추정, 관련 설비·사건·최근 DAQ 로그를 포함한다. 배치 ID는 저장된 reading ID다. acquisition frame ID와 동일하지 않으며 원본 프레임 매핑은 추후 수집기 계약에서 확장한다.

**배치 정보와 부착 배치 정보 모두 포함한다.** 데이터 배치는 최근 수신한 Raw 묶음이며 센서 위치는 placement와 sensors.position에 있다. 사진은 로컬 참조만 전달하고 이미지 bytes는 보내지 않는다. RAG 서버가 지식을 검색할 때 UUID·장비 종류·센서 종류·채널·부착 위치 등으로 검색 범위를 정할 수 있다. 검색 결과·답변 생성은 RAG 서버 책임이다.

고속 Raw 전체 배열은 포함하지 않는다. 각 배치의 min/max/평균/RMS는 서버에서 원본으로 계산한다. Raw 미리보기를 선택하면 min/max 축약점 최대 32개와 원본 index를 포함하며, 축약점으로 RMS를 다시 계산하지 않는다. 원본 크기·수집 구간·누락된 센서 데이터 여부도 전달한다. 컨텍스트 최대 512KB, 서버 응답 최대 256KB로 제한한다. 현재 시간창은 **최근 N개 배치**이고 완전한 연속 수집을 보장하는 창이 아니다. coverage.availableBatches는 최근 그래프 저장소에서 조회 가능한 수량이다.

## RAG 서버 응답

HTTP 200의 최상위 JSON 객체에 answer를 반환한다. 대시보드의 `{data}` 래퍼를 외부 서버 응답에 붙이지 않는다.

```json
{
  "answer": "발전기 베어링 진동이 증가했습니다. 최근 배치와 정비 매뉴얼의 점검 절차를 함께 확인하세요.",
  "model": "local-rag-model",
  "citations": [
    {"id":"manual-12","title":"발전기 베어링 점검 절차","source":"정비 매뉴얼 12쪽","excerpt":"베어링 하우징 체결 상태 확인","sensorId":null,"batchId":null},
    {"title":"최근 진동 배치","source":"현장 수신 데이터","sensorId":"sensor-id","batchId":"reading-batch-id"}
  ]
}
```

answer는 필수 (최대 24,000자), citations와 model은 선택이다. 인용 최대 24개, title은 필수이고 나머지는 선택·null을 허용한다. sensorId는 선택한 센서, batchId는 전송된 배치여야 한다. 매뉴얼·RAG 문서 근거는 source·excerpt에 기록하고 sensorId/batchId를 생략할 수 있다. 지식 검색 내용의 사실성은 이 API에서 독립적으로 검증하지 않는다. 답변은 텍스트로 표시하고 기존 진단·정비 상태를 자동 변경하지 않는다.

## 검증 범위

컨텍스트 구성·원본 제외·피크 보존·소속 검증·누락 데이터·단절 상태·질의 시점 갱신·인용 검증·서버 오류 처리 테스트를 포함한다. 별도 RAG 서버의 문서 검색은 아직 미검증이다. CLIKA 직접 연결은 2026-10-10에 localhost:8000의 `Qwen2.5-0.5B-Instruct`로 실제 검증했다. 임시 DATA_DIR의 모의 DAQ·센서 2개와 각 1배치를 Next `/api/rag/query`로 보내 HTTP 200 답변을 받았고, 모델이 전달한 센서 상태·최신 값을 답변에 반영했다. 이 요청은 약 16초 걸렸으며 모델 입력·출력 길이와 하드웨어에 따라 달라진다. 실제 사용자 저장소는 검증에 사용하지 않았다. 전체 45개 테스트, TypeScript 포함 Next 프로덕션 빌드, 변경 파일 ESLint를 통과했다.


## 대화와 브라우저 세션

채팅은 루트 레이아웃에서 유지하므로 페이지 이동·최소화로 사라지지 않는다. `sessionStorage`의 `fieldlink.rag.chat.v1:demo` / `fieldlink.rag.chat.v1:external` 키에 대화·현재 선택·입력 중인 메시지를 저장한다. 같은 탭의 새로고침에서 복원하고, 탭/브라우저 세션을 초기화하거나 세션 저장소를 비우면 사라진다. 브라우저의 탭 복원 기능은 sessionStorage를 복원할 수도 있다. localStorage·대시보드 DB에 대화를 영구 저장하지 않는다. CLIKA·별도 RAG 서버의 자체 로그·보관 정책은 이 클라이언트 설정과 별개다.

질문과 답변을 말풍선으로 표시하고, 각 질문에 당시 DAQ·센서를 기록한다. Enter 전송, Shift+Enter 줄바꿈, 한글 조합 중 Enter는 전송하지 않는다. 요청 중 최소화해도 응답 수신을 계속하며, 취소 버튼으로 중단할 수 있다. 새로고침 중이던 요청은 복원 시 interrupted로 표시하고 가짜 답변을 만들지 않는다. 대화는 최대 40회·512KB까지 최근 기록을 유지한다. 저장 권한/용량이 제한되면 메모리 대화로 동작하고 새로고침 시 유실될 수 있음을 표시한다.

후속 질문에 완료된 이전 대화 최근 6회(12개 user/assistant 메시지, 총 32,000자 이하)를 `history`로 전송한다. 실패·취소·대기 중인 질의는 후속 대화에서 제외한다. `history`는 `{role,content,daqUuid?,sensorIds?}[]`이며 system role은 받지 않는다. 새로운 context는 매번 최신 상태를 재구성한다. 다른 DAQ에 대한 과거 대화와 현재 센서 데이터를 혼동하지 않도록 메시지별 범위도 전달한다. CLIKA 연결에서는 history 중 토큰 예산에 맞는 최근 대화 일부를 user/assistant 메시지로 변환해 전달하며 제외·축약해도 브라우저 기록은 유지한다. **별도 RAG 서버 모드에서는 해당 서버가 history를 읽어 처리해야 한다.** 이전 raw/context 전체를 저장하거나 반복 전송하지 않는다.

### 현장 검색 및 길이 제한 검증

2026-10-10 변경된 D4D-FieldLink의 프로덕션 빌드와 localhost:8000 CLIKA `Qwen2.5-0.5B-Instruct`를 연결해 임시 검증용 센서 2개로 확인했다. v0.3 RUL 120시간/null, 이상 점수, 고장 유형을 검색 자료 4개로 전달했고 입력 토큰 계산값 1,108은 입력 예산 2,944 이내였다. 실제 채팅 HTTP 응답과 브라우저의 자료 표를 확인했다. 250→1,800 SPS 전환 후 과거 배치 rate가 보존되고 900샘플 구간이 499.44ms로 계산됐다. 67개 대시보드 테스트와 7개 수집기 테스트, 타입 검사 포함 프로덕션 빌드를 통과했다. [API 검증 기록](clika-live-result.json). 기록의 질문/입력은 검증용 예시이며 실제 장비 결과가 아니다. 작은 현재 모델은 일부 질문에서 제공하지 않은 이미지나 수치를 언급했으므로, 연결 검증을 답변 정확도 검증으로 해석하면 안 된다. 원본 검색 자료 표에서 값을 확인할 수 있다.

v0.3의 `anomaly_score` 및 미보정 `probabilities`는 미래 고장 확률이 아닙니다. 검색에는 센서별 RUL 상태·프로필·이상 점수/임계값·분류 점수 보정 여부가 포함됩니다. 배치 통계에는 대시보드와 동일한 센서 교정을 적용합니다.
