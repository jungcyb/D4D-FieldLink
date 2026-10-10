# RAG 현장 질의 API

대시보드는 선택한 현장 컨텍스트를 구성하고 RAG 처리 계층의 JSON 답변을 표시한다. RAG·CLIKA 로컬 추론은 별도 서버로 운영하거나 백엔드와 함께 배치할 수 있다. 현재는 HTTP 연동 경계를 제공하며, 내장 벡터 DB·모델 실행기는 포함하지 않는다.

## 연결 설정

`.env.local`에 **정확한 POST 질의 주소**를 지정하고 Next 서버를 재시작한다. 서버 형식이 정해지면 `lib/server/rag.ts`의 `query()` 요청·응답 변환만 수정하면 된다. 동일 호스트의 RAG 서비스 주소도 사용할 수 있다. 백엔드 프로세스에 RAG를 내장할 경우 같은 서비스 계층에서 내부 함수를 호출하도록 교체할 수 있으며 채팅 UI는 그대로 유지한다. HTTP로 함께 배치할 때 질의 주소를 `/api/rag/query` 자체로 지정하면 순환 호출되므로 실제 RAG 처리 엔드포인트를 지정한다.

```dotenv
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

컨텍스트 구성·원본 제외·피크 보존·소속 검증·누락 데이터·단절 상태·질의 시점 갱신·인용 검증·서버 오류 처리 테스트를 포함한다. 실제 별도 RAG 서버는 아직 미정이므로 실서버 검색·모델 응답은 연결 후 검증해야 한다.


## 대화와 브라우저 세션

채팅은 루트 레이아웃에서 유지하므로 페이지 이동·최소화로 사라지지 않는다. `sessionStorage`의 `fieldlink.rag.chat.v1:demo` / `fieldlink.rag.chat.v1:external` 키에 대화·현재 선택·입력 중인 메시지를 저장한다. 같은 탭의 새로고침에서 복원하고, 탭/브라우저 세션을 초기화하거나 세션 저장소를 비우면 사라진다. 브라우저의 탭 복원 기능은 sessionStorage를 복원할 수도 있다. localStorage·대시보드 DB에 대화를 영구 저장하지 않는다. 별도 RAG 서버의 자체 로그·보관 정책은 이 클라이언트 설정과 별개다.

질문과 답변을 말풍선으로 표시하고, 각 질문에 당시 DAQ·센서를 기록한다. Enter 전송, Shift+Enter 줄바꿈, 한글 조합 중 Enter는 전송하지 않는다. 요청 중 최소화해도 응답 수신을 계속하며, 취소 버튼으로 중단할 수 있다. 새로고침 중이던 요청은 복원 시 interrupted로 표시하고 가짜 답변을 만들지 않는다. 대화는 최대 40회·512KB까지 최근 기록을 유지한다. 저장 권한/용량이 제한되면 메모리 대화로 동작하고 새로고침 시 유실될 수 있음을 표시한다.

후속 질문에 완료된 이전 대화 최근 6회(12개 user/assistant 메시지, 총 32,000자 이하)를 `history`로 전송한다. 실패·취소·대기 중인 질의는 후속 대화에서 제외한다. `history`는 `{role,content,daqUuid?,sensorIds?}[]`이며 system role은 받지 않는다. 새로운 context는 매번 최신 상태를 재구성한다. 다른 DAQ에 대한 과거 대화와 현재 센서 데이터를 혼동하지 않도록 메시지별 범위도 전달한다. **별도 RAG 서버가 history를 읽어 후속 질문을 처리하도록 구현해야 실제 모델의 다중 대화가 이어진다.** 이전 raw/context 전체를 저장하거나 반복 전송하지 않는다.
