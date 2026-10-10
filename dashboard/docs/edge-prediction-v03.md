# v0.3 엣지 추론 결과 연결

`POST /api/edge/predictions`에 모델 출력 JSON을 그대로 넣고, 전송 계층의 `daqUuid`, `frameId`를 추가한다. 기존 `POST /api/edge/frames`도 같은 v0.3 입력을 받는다. `EDGE_API_TOKEN` 설정 시 Bearer 인증이 필요하다. 성공은 HTTP 202, 동일 DAQ/frameId 재시도는 `duplicate: true`다. Raw 없는 예측 전용 프레임을 지원한다.

```json
{
  "daqUuid": "11111111-2222-4333-8444-555555555555",
  "frameId": "boot-42:prediction-1001",
  "schema_version": "edge_prediction_v0.3",
  "equipment_id": "대시보드에 등록된 장비 ID",
  "sensor_map": { "vibration": "등록 센서 ID 또는 CH0" },
  "sensors": {
    "vibration": {
      "profile_id": "pump-01/vibration/steady/v1",
      "anomaly_detection": {"status": "ok", "profile_id": "pump-01/vibration/steady/v1", "model_version": "if-001", "anomaly_score": 0.62, "threshold": 0.59, "is_anomaly": true},
      "rul": {"status": "available", "estimated_rul_hours": 120, "uncertainty_status": "not_calibrated"},
      "fault_classification": {"status": "ok", "predicted_class": "bearing_fault", "probabilities": {"normal": 0.1, "bearing_fault": 0.9}, "probabilities_calibrated": false}
    }
  },
  "equipment_rul": {"status": "unavailable", "reason": "no_equipment_level_fusion_model"},
  "maintenance_priority": {"status": "not_computed", "owner": "backend_policy"}
}
```

숫자는 형식 예시이며 실제 모델 결과가 아니다. `equipment_id`는 해당 DAQ가 연결된 등록 장비 ID와 같아야 한다. 모델이 별도 설비 ID를 사용하는 경우 수집 어댑터에서 등록 ID로 매핑한다. `sensors`의 키가 등록 센서 ID 또는 해당 DAQ의 채널이면 `sensor_map`은 생략할 수 있다. `vibration` 등 모델 별칭을 쓰면 명시적으로 매핑한다. 센서 종류나 이름으로 추측하지 않는다. 존재하지 않는 센서·다른 장비·중복 매핑·프로필 불일치는 저장 없이 거부한다.

선택적 `timestamp`는 구간 평가 시각(시간대 포함 ISO 8601), 생략 시 수신 시각이다. 오프라인 재전송은 원래 평가 시각을 보존해야 최신 진단을 덮어쓰지 않는다. 각 센서 예측과 설비 요약은 파일 저장소에 영속 저장한다.

- `rul.status=available`: 유한한 0 이상 `estimated_rul_hours`, `uncertainty_status` 필수. 120은 120시간, 0은 0시간으로 표시한다.
- `rul.status=unavailable|error`: `estimated_rul_hours=null`, `reason` 필수. 추정 불가로 표시하며 0이나 무한대로 변환하지 않는다.
- `anomaly_detection.status=ok`: 프로필·모델 버전·유한한 점수/임계값·boolean 이상 여부 필수. 점수는 미보정이며 확률로 표시하지 않는다.
- `anomaly_detection.status=unavailable|error`: `reason`을 표시하고 상태는 미확인으로 둔다. 입력/구간 오류를 정상으로 처리하지 않는다.
- `fault_classification.status=ok`: 클래스·클래스별 0~1 점수·보정 여부 필수. 미보정 여부를 명시하며 미래 고장 확률로 표현하지 않는다.
- `fault_classification.status=unavailable|error`: 사유만 표시한다.

현재 backend 상태 정책은 `is_anomaly=true`를 주의, false를 정상, 평가 불가를 미확인으로 표시한다. 임계값이나 분류 점수로 위험 등급을 임의 산출하지 않는다. 자동 정비 작업·수치 우선순위는 생성하지 않으며 운영자가 작업 우선순위를 선택한다. 설비 전체 RUL은 통합 모델이 없으므로 추정 불가다. 센서별 최솟값을 설비 RUL로 표시하지 않는다.

기존 `readings`/레거시 `diagnoses` 프레임도 유지하지만 새 `{value,unit,error}`를 확률로 해석하는 경로는 추가하지 않는다. 신규 연결은 이 문서의 v0.3을 사용한다. 센서별 예상 수명·이상 점수·고장 유형은 채널 목록, 상세 진단, 정비함과 CLIKA 검색 자료에 반영된다.

`.npz` 구간 생성, 정상/run-to-failure 학습 데이터 승인, 후보 모델 활성화·롤백은 이 JSON 수신·표시 기능의 범위에 포함되지 않는다. DAQ raw 배치가 곧 `edge_window_v2` 고정 길이 구간이라는 보장은 없다. 별도 수집/모델 서버가 실제 균일 rate·동일 시간축·프로필을 검증한 후 추론 결과를 보내야 한다.


## 가변 샘플레이트

센서 등록 시 1,000 SPS 기본값을 보내지 않는다. 미확인 rate는 null이며 UI는 확인 대기로 표시한다. 실제 DAQ 수집 상태 조회/설정값과 수신 배치의 `sps`로 갱신한다. 화면 갱신 주기(1초 등)는 수집 rate와 별개다. 현 보드 제어 범위는 10~2,000 SPS/채널이며 이 제한은 보드 프로토콜의 지원 범위다. 데이터 수신 API는 0.01~1,000,000 SPS를 허용한다.

각 Raw 배치의 `sps`는 해당 구간의 실제 rate이며 과거 배치를 현재 rate로 재해석하지 않는다. 그래프/CSV의 시간은 `index * 1000 / sps` ms, 배치 끝은 `timestamp + (sampleCount - 1) / sps`로 계산한다. RAG에도 동일 rate·수집 기간을 보낸다. 컬렉터는 rate 변경과 record ID 단절에서 배치를 분리하며, 기본적으로 해당 rate만큼(약 1초), 최대 4,096샘플씩 전달한다. 고정 길이 모델 구간은 이 배치와 별도로 프로필에 맞춰 생성해야 한다.
