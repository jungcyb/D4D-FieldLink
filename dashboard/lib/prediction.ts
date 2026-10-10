import type {Diagnosis,EquipmentView} from "./types.ts";
const number=(value:number)=>value.toLocaleString("ko-KR",{maximumFractionDigits:4});
export function formatLifetime(diagnosis:Pick<Diagnosis,"rulHours"|"edgePrediction">|null|undefined):string{
  const prediction=diagnosis?.edgePrediction?.rul;
  if(prediction&&prediction.status!=="available")return "추정 불가";
  const hours=prediction?.status==="available"?prediction.estimated_rul_hours:diagnosis?.rulHours;
  return hours==null?"추정 불가":`${number(hours)}시간`;
}
export function formatEquipmentLifetime(equipment:Pick<EquipmentView,"edgePrediction">):string{
  return equipment.edgePrediction?"추정 불가 · 통합 모델 없음":"설비 RUL 미수신";
}
export function anomalyText(diagnosis:Pick<Diagnosis,"edgePrediction">|null|undefined):string{
  const anomaly=diagnosis?.edgePrediction?.anomaly_detection;
  return anomaly?.status==="ok"?`${number(anomaly.anomaly_score)} / 임계값 ${number(anomaly.threshold)} (미보정 점수)` : anomaly?`평가 불가 · ${anomaly.reason}`:"점수 미수신";
}
export function predictionFields(diagnosis:Pick<Diagnosis,"edgePrediction"|"rulHours">|null|undefined):{label:string;value:string}[]{
  const p=diagnosis?.edgePrediction;
  const rows=[{label:"예상 수명 (RUL)",value:formatLifetime(diagnosis)}];
  if(!p)return rows;
  rows.push({label:"프로필",value:p.profile_id},{label:"이상 탐지",value:anomalyText(diagnosis)});
  if(p.anomaly_detection.status==="ok")rows.push({label:"이상 여부",value:p.anomaly_detection.is_anomaly?"이상 감지":"정상 범위"});
  rows.push({label:"RUL 상태",value:p.rul.status==="available"?`추정 제공 · 불확실성 ${p.rul.uncertainty_status}`:`${p.rul.status} · ${p.rul.reason}`});
  const fault=p.fault_classification;
  rows.push({label:"고장 유형",value:fault.status==="ok"?fault.predicted_class:`${fault.status} · ${fault.reason}`});
  if(fault.status==="ok"){
    rows.push({label:"분류 점수",value:Object.entries(fault.probabilities).map(([name,value])=>`${name}: ${number(value)}`).join(" · ")});
    rows.push({label:"분류 점수 보정",value:`${fault.probabilities_calibrated?"보정됨":"미보정"} · 미래 고장 확률이 아님`});
  }
  return rows;
}
