# FIELDLINK — Next.js 장비 예측정비 대시보드

Next.js 16.4 App Router + React + TypeScript. 프론트와 백엔드(Route Handler)를 한 프로젝트에서 실행합니다. 추가 런타임 의존성 없이 해커톤 시연에 필요한 등록·조회·사진·정비 흐름을 구현했습니다.

## 실행

Node.js **22.18 이상**이 필요합니다. 권장: Node 24. 기존 설치된 `node_modules`를 그대로 사용합니다.

```powershell
cd C:\Users\frin0\Desktop\Projects\D4D\D4D-FieldLink\dashboard
npm run dev
```

기본 Node가 오래된 Windows 환경에서는 `./dev.ps1`을 실행하면 설치된 Node와 Codex 제공 런타임 중 지원 버전을 찾아 사용합니다. 접속: http://localhost:3000

```powershell
npm run typecheck
npm test
npm run build
npm start
```

## 구현된 화면

- `/`: 장비 현황, 위험·주의 장비, 수신 대표값 그래프, DAQ 응답 현황
- `/equipment`: 장비 등록·수정, DAQ·센서 확인, 센서 등록·수정
- `/daqs`: 모의 탐색, 보드 UUID 확인, 장비 연결, 센서 등록
- `/maintenance`: 진단 확인, 정비 작업 생성·수정, 담당자·마감일, 대기→진행→완료
- 센서 상세: 대표값/Raw, 두 점 affine calibration, SPS, 엣지 진단·RUL·신뢰도, 사진 업로드, CSV 다운로드
- `/recovery`: 단절 복구 정책·gzip 원본 아카이브, KST 기간별 센서 Raw+로그 `JSONL.gz` export

데모 측정값·진단은 모든 화면에서 표시합니다. 백엔드는 AI 추론을 하지 않습니다. 사진은 PNG/JPEG/WebP 5MB 이하입니다. 장비 미등록 DAQ에도 센서를 등록할 수 있으며 추후 장비 연결이 가능합니다.

## 서버 구성

```text
app/api/[...path]/route.ts    HTTP 라우팅·업로드·요청 크기 제한·오류 응답
lib/types.ts                프론트/백엔드 공유 타입·정규화된 보드 프레임
lib/server/service.ts       UUID upsert·장비 연결·센서·수신·진단·정비 업무 로직
lib/server/repository.ts    영구 저장 경계
lib/server/adapters.ts      보드 탐색 인터페이스·데모 응답·연동 지점
lib/server/seed.ts          데모 보드 응답·측정값·진단
components/                API를 호출하는 React 화면
tests/service.test.mts      UUID·영속성·검증·재전송·정비·모드 분리 테스트
```

`data/demo.json`, `data/external.json`에 모드별 데이터를 저장합니다. 사진은 `data/photos/<mode>/`에 저장합니다. 요청마다 디스크를 읽고 동기 read-modify-write 후 임시 파일을 rename하므로 단일 Next.js 프로세스에서는 작업이 겹치지 않습니다. 개발 서버 재시작에도 데이터가 남습니다. `data/`는 Git에서 제외됩니다.

이 저장소는 **로컬 단일 프로세스 PMVP**용입니다. 다중 인스턴스/서버리스 배포 시 `repository.ts`를 DB 저장소로 교체하고 사진도 오브젝트 스토리지로 옮겨야 합니다. external 모드의 웹 그래프는 센서별 최근 12배치만 유지하고, 장기 Raw는 보드 링과 복구 gzip 아카이브가 담당합니다. 진단은 최근 100개와 작업에서 참조하는 진단을 보관합니다. 실제 인증은 아직 없으며 운영자 API는 로컬·신뢰된 해커톤 환경을 전제로 합니다.

## 모드 전환

```powershell
# 실제 데이터만 사용하는 빈 저장소에서 시작. 데모와 완전히 분리됩니다.
$env:DAQ_MODE = 'external'
$env:EDGE_API_TOKEN = 'your-local-shared-token'
npm run dev
```

`DAQ_MODE`를 지정하지 않으면 `next dev`/`npm run dev`는 모의 데이터(`demo`), `next start`/`npm run start`는 실제 장비 데이터(`external`)를 사용합니다. `next build` 후 `next start`를 실행하세요. 명시적인 `DAQ_MODE=demo` 또는 `external` 설정은 자동 선택보다 우선합니다. `.env.local`에서는 `DAQ_MODE`를 비우거나 생략하면 됩니다. 모의 데이터는 화면 조회 요청에 맞춰 최대 5초마다 추가됩니다. 이 방식은 실제 백그라운드 수집기나 연속 신호 수집이 아닙니다. 데모 차량 DAQ는 오프라인 상황을 보여줍니다. `DATA_DIR`로 저장 위치를 변경할 수 있습니다. `.env.example`을 `.env.local`로 복사해도 됩니다.

## 보드 연결 확장

보드가 UUID를 발급하고 응답으로 전달합니다. 백엔드는 UUID를 발급하지 않습니다. 예시 보드 UUID도 고정된 데모 응답값입니다. 같은 UUID를 다시 받으면 IP·포트·이름·마지막 응답 시각만 갱신하며 기존 장비 연결은 유지합니다.

1. `Ads8688DiscoveryAdapter`가 UDP `A8DQ/A8DR` broadcast로 UUID/IP/TCP 포트를 찾습니다.
2. DAQ가 TCP 서버, 수집기가 TCP 클라이언트입니다. TCP 연결·재접속·스트림 프레이밍·디코딩을 별도 수집기에서 처리합니다. 지속 TCP 연결을 Route Handler 요청 수명에 묶지 않습니다.
3. 수집기는 `POST /api/edge/boards`와 `POST /api/edge/frames`를 호출하거나, 같은 Node 프로세스에서 `MaintenanceService` 메서드를 호출합니다. 프론트 화면·업무 로직은 그대로 사용합니다.
4. `integration/collector.mjs`가 timestamped backlog를 재생하고 복구 범위 원본을 gzip 아카이브로 전송합니다. 과거 프레임은 최신 대표값을 덮어쓰지 않습니다.

실제 UDP 탐색, TCP 연결, 보드 링 복구까지 구현했습니다. AI 모델은 프로필·승인 정상 데이터·활성 모델이 준비되기 전에는 실행하지 않습니다. DAQ 온라인 표시의 의미는 **최근 30초 내 응답/수신**이며 TCP 소켓 연결 상태와는 별도입니다.

## API 규격

성공: `{ "data": ... }`. 오류: `{ "error": { "code": "...", "message": "..." } }`. 조회는 `no-store`입니다.

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/api/health` | 서버 상태·모드 |
| GET | `/api/dashboard` | 전체 화면용 스냅샷 |
| GET / POST | `/api/equipment` | 장비 목록 / 등록 |
| GET / PATCH | `/api/equipment/:id` | 상세 / 수정 |
| GET | `/api/daqs` | UUID별 DAQ 목록 |
| PATCH | `/api/daqs/:uuid` | `{ equipmentId, label? }` 장비 연결 |
| POST | `/api/discovery` | 어댑터를 통한 탐색·upsert |
| GET / POST | `/api/sensors` | 센서 목록 / 등록 |
| GET / PATCH | `/api/sensors/:id` | 센서 상세 / 수정 |
| GET | `/api/sensors/:id/telemetry?limit=120` | 최근 배치 (limit 1~720) |
| PATCH | `/api/sensors/:id/calibration` | affine `scale`, `offset`, 입력 단위 저장 |
| GET | `/api/exports/range` | DAQ·기간별 Raw/로그 JSONL.gz export |
| POST | `/api/sensors/:id/photo` | multipart `photo` 필드 |
| GET | `/api/photos/:filename` | 저장된 사진 |
| GET | `/api/diagnoses` | 센서별 최신 진단 |
| POST | `/api/diagnoses/:id/acknowledge` | 진단 확인 처리 |
| GET / POST | `/api/tasks` | 정비 작업 목록 / 생성 |
| GET / PATCH | `/api/tasks/:id` | 상세 / 수정, 부분 상태 변경 |
| POST | `/api/edge/boards` | 보드 응답 등록·갱신 |
| POST | `/api/edge/frames` | 정규화된 Raw Data·진단 수신 |

`EDGE_API_TOKEN` 설정 시 두 `/api/edge/*` 쓰기 API에는 `Authorization: Bearer <token>`이 필요합니다.

### 보드 응답

```json
{ "uuid": "11111111-2222-4333-8444-555555555555", "label": "DAQ-GEN-01", "ip": "192.168.10.101", "port": 9000 }
```

### 센서 등록

```json
{ "daqUuid": "11111111-2222-4333-8444-555555555555", "channel": "CH-1", "name": "베어링 진동", "type": "vibration", "position": "구동축 베어링", "unit": "mm/s" }
```

종류: `vibration | temperature | current`. 동일 DAQ의 채널은 유일합니다. 진동 측정 단위는 센서/팀의 정의에 맞춰 `g`, `m/s²`, `mm/s` 등으로 등록할 수 있습니다.

### 프레임 수신

```json
{
  "daqUuid": "11111111-2222-4333-8444-555555555555",
  "frameId": "boot-42:sequence-1001",
  "readings": [{ "channel": "CH-1", "timestamp": "2026-10-10T02:00:00.000Z", "value": 7.82, "sps": 1000, "raw": [0.12, -0.08, 0.17] }],
  "diagnoses": [{ "channel": "CH-1", "timestamp": "2026-10-10T02:00:00.000Z", "severity": "critical", "title": "베어링 마모 징후", "description": "진동 이상 패턴 감지", "confidence": 0.96, "rulHours": 36, "model": "edge-model-v1" }]
}
```

시각은 시간대를 포함한 ISO 8601 형식입니다. 대표값 `value`는 엣지가 전달한 값이며 서버에서 RMS 등을 새로 계산하지 않습니다. `timestamp`는 배치 첫 샘플 시각, `raw[i]` 시각은 `timestamp + i / sps`입니다. 각 프레임은 readings 또는 diagnoses가 하나 이상 필요하고 각각 최대 100개를 받습니다. 각 raw 배열은 1~4096개 숫자를 받습니다. 진단의 RUL/신뢰도는 생략하거나 null일 수 있으며 0도 유효합니다. 진단 상태: `normal | warning | critical | unknown`. 신규 모델 결과는 [v0.3 계약](docs/edge-prediction-v03.md)을 사용합니다.

장비 상태는 센서별 최신 진단의 가장 높은 위험도를 사용하고, RUL은 센서별로 표시하며 설비 전체 RUL은 통합 모델이 없어 추정 불가입니다. **진단 확인/정비 완료는 진단 상태를 바꾸지 않습니다.** 새 정상 진단이 수신되어야 장비 상태가 바뀝니다. 이력이 있는 DAQ의 장비 이동은 기존 측정값의 의미가 달라지므로 409로 차단하며, 추후 이력 이전 정책을 정해 확장할 수 있습니다.

## 고속 Raw·복구·장애 관계

- `/daqs`: 보드 수집 상태, 채널당 샘플레이트 설정, 수집 시작·정지와 확인 절차.
- `/equipment`: 센서 상태·추이와 선택 센서 Raw/진단/사진을 전체 페이지에서 표시.
- `/recovery`, `/logs`: 연결 단절·재연결, 기간/Raw/Log/용량 정책, 원본 gzip 아카이브와 이벤트 조회.
- `/dependencies`: 설비 DAG, 상위 장애의 하위 영향 추정, 연관 증상 사건 묶기.

[시연 순서·복구 API·현재 제한](docs/operations.md)을 참고하세요. 센서 부착 위치와 설치 사진은 장비·센서 페이지에서 관리하며 AI 채팅 컨텍스트에 포함합니다.

제거된 개발용 성능 화면의 과거 측정 보고서는 저장소 외 로컬 `.meta/dashboard/docs/`에 보관합니다.

## RAG 현장 질의

모든 대시보드에서 AI 채팅 플로팅 버튼 → 데이터 선택 모달 → 채팅창으로 질의합니다. 대화는 브라우저 sessionStorage에만 보관하며, 세션 초기화 시 사라집니다. 선택한 DAQ·센서·현재 상태·최근 배치와 이전 대화를 RAG 처리 계층에 전달합니다. RAG는 백엔드와 함께 배치하거나 별도 서버로 운영할 수 있습니다. RAG_API_URL 환경변수로 정확한 JSON POST 주소를 지정하세요. [요청·응답 계약과 연결 설정](docs/rag.md).


CLIKA 채팅 연결은 [RAG 설정](docs/rag.md), 새 추론 결과 수신은 [v0.3 예측 계약](docs/edge-prediction-v03.md)을 참고하세요. `DAQ_MODE` 미설정 시 개발 서버는 모의 데이터, 프로덕션 서버는 실제 장비 데이터를 사용합니다. 같은 `DATA_DIR`에서도 `demo.json`과 `external.json`을 분리하므로 개발용 센서는 실제 장비 목록에 섞이지 않습니다.

센서 등록에서 SPS는 선택 사항입니다. 모르는 값은 null로 저장하고, 수신 배치 또는 DAQ 상태의 실제 rate를 사용합니다. 가변 rate의 그래프·CSV·RAG 시간축과 컬렉터 배치 정책은 [가변 샘플레이트](docs/edge-prediction-v03.md#가변-샘플레이트)를 참고하세요.


DAQ의 센서 자동 등록과 전체/공통/채널별 rate, 향후 보드 구현용 JSON·TCP 연결 형식은 [DAQ 센서와 샘플레이트 계약](docs/daq-sensors-and-rates.md)을 참고하세요.
