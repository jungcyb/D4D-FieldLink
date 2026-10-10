import type {EdgeSensorPrediction,PredictionUnavailable,EquipmentPrediction} from "../prediction-types.ts";
import type {Store} from "../types.ts";
import {check,object,text,numeric,choice,timestamp} from "./validation.ts";
const unavailable=(input:Record<string,unknown>):PredictionUnavailable=>({status:choice(input.status,["unavailable","error"] as const,"모델 상태"),reason:text(input.reason,"제공 불가 사유",500)});
export function parseSensorPrediction(input:unknown):EdgeSensorPrediction{
  const row=object(input),profile_id=text(row.profile_id,"프로필 ID",300),a=object(row.anomaly_detection),r=object(row.rul),f=object(row.fault_classification);
  let anomaly_detection:EdgeSensorPrediction["anomaly_detection"];
  if(a.status==="ok"){
    check(a.profile_id===profile_id,"이상 탐지 프로필이 센서 프로필과 일치하지 않습니다.");
    check(typeof a.is_anomaly==="boolean","is_anomaly는 boolean이어야 합니다.");
    anomaly_detection={status:"ok",profile_id,model_version:text(a.model_version,"이상 탐지 모델 버전",200),anomaly_score:numeric(a.anomaly_score,"이상 점수",-Number.MAX_VALUE,Number.MAX_VALUE),threshold:numeric(a.threshold,"임계값",-Number.MAX_VALUE,Number.MAX_VALUE),is_anomaly:a.is_anomaly};
  }else anomaly_detection=unavailable(a);
  let rul:EdgeSensorPrediction["rul"];
  if(r.status==="available")rul={status:"available",estimated_rul_hours:numeric(r.estimated_rul_hours,"예상 수명(시간)",0,Number.MAX_VALUE),uncertainty_status:text(r.uncertainty_status,"불확실성 상태",100)};
  else {check(r.estimated_rul_hours===null,"추정 불가 RUL은 null이어야 합니다.");rul={...unavailable(r),estimated_rul_hours:null};}
  let fault_classification:EdgeSensorPrediction["fault_classification"];
  if(f.status==="ok"){
    const values=object(f.probabilities),entries=Object.entries(values);check(entries.length>0&&entries.length<=64,"분류 점수는 1~64개여야 합니다.");
    const predicted_class=text(f.predicted_class,"고장 유형",200);check(Object.hasOwn(values,predicted_class),"예측 클래스의 점수가 없습니다.");
    check(typeof f.probabilities_calibrated==="boolean","분류 점수 보정 여부는 boolean이어야 합니다.");
    fault_classification={status:"ok",predicted_class,probabilities:Object.fromEntries(entries.map(([key,value])=>[text(key,"클래스",200),numeric(value,"분류 점수",0,1)])),probabilities_calibrated:f.probabilities_calibrated};
  }else fault_classification=unavailable(f);
  return {profile_id,anomaly_detection,rul,fault_classification};
}
/** Transport adds board identity and explicit aliases; model keys are never guessed from sensor type. */
export function predictionFrame(data:Record<string,unknown>,store:Store){
  check(data.schema_version==="edge_prediction_v0.3","지원하지 않는 예측 계약 버전입니다.");
  const board=store.daqs.find(d=>d.uuid===data.daqUuid);check(board,"DAQ를 찾을 수 없습니다.",404);check(board.equipmentId&&data.equipment_id===board.equipmentId,"예측 설비 ID와 DAQ가 등록된 장비가 일치하지 않습니다.");
  const rows=Object.entries(object(data.sensors));check(rows.length>0&&rows.length<=100,"센서별 예측은 1~100개여야 합니다.");
  const mapping=data.sensor_map===undefined?{}:object(data.sensor_map),seen=new Set<string>(),at=data.timestamp==null?new Date().toISOString():timestamp(data.timestamp);
  const diagnoses=rows.map(([key,value])=>{
    const id=Object.hasOwn(mapping,key)?text(mapping[key],"센서 매핑 ID"):key;
    const matches=store.sensors.filter(s=>s.daqUuid===board.uuid&&(s.id===id||s.channel===id||s.edgeId===id));check(matches.length===1,`예측 센서 ${key}의 등록 ID 또는 채널 매핑이 필요합니다.`,400,"PREDICTION_SENSOR_MAPPING");
    const sensor=matches[0];check(!seen.has(sensor.id),"한 센서에 중복 예측을 전달할 수 없습니다.");seen.add(sensor.id);
    const edgePrediction=parseSensorPrediction(value),a=edgePrediction.anomaly_detection;
    return {channel:sensor.channel,timestamp:at,edgePrediction,severity:a.status==="ok"?(a.is_anomaly?"warning":"normal"):"unknown",title:a.status==="ok"?(a.is_anomaly?"이상 감지":"정상 범위"):"평가 불가",description:a.status==="ok"?`이상 점수 ${a.anomaly_score}, 임계값 ${a.threshold}. 미보정 점수이며 고장 확률이 아닙니다.`:a.reason,model:a.status==="ok"?a.model_version:"edge · 모델 평가 불가"};
  });
  const equipment=object(data.equipment_rul),priority=object(data.maintenance_priority);
  check(equipment.status==="unavailable","v0.3에는 설비 전체 RUL 통합 모델이 없습니다.");check(priority.status==="not_computed"&&priority.owner==="backend_policy","정비 우선순위는 backend_policy 소유의 not_computed 상태여야 합니다.");
  const equipmentPrediction:EquipmentPrediction={schema_version:"edge_prediction_v0.3",timestamp:at,equipment_rul:{status:"unavailable",reason:text(equipment.reason,"설비 RUL 제공 불가 사유",500)},maintenance_priority:{status:"not_computed",owner:"backend_policy"}};
  return {data:{daqUuid:board.uuid,frameId:data.frameId,diagnoses},equipmentId:board.equipmentId,equipmentPrediction};
}
