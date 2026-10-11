"use client";
import {useCallback,useState} from "react";
import type {SensorView,Diagnosis} from "@/lib/types";
import {api} from "@/lib/client-api";
import {useLiveRefresh} from "./use-live-refresh";
const value=(n:number)=>n.toLocaleString("ko-KR",{maximumFractionDigits:5});
export default function AnomalyResult({sensor}:{sensor:SensorView}){
  const [history,setHistory]=useState<Diagnosis[]>([]),[error,setError]=useState("");
  const load=useCallback(async(signal:AbortSignal)=>{try{setHistory(await api<Diagnosis[]>(`/sensors/${sensor.id}/diagnoses?limit=20`,{signal}));setError("");}catch(e){if(!signal.aborted)setError(e instanceof Error?e.message:"판정 조회 실패");}},[sensor.id]);
  useLiveRefresh(load);
  const diagnosis=history[0]??sensor.diagnosis,anomaly=diagnosis?.edgePrediction?.anomaly_detection;
  const severity=anomaly?.status==="ok"?anomaly.is_anomaly?"warning":"normal":diagnosis?.severity??"unknown";
  return <section className={`panel anomaly-verdict ${severity}`} aria-label={`${sensor.name} 이상 탐지 결과`}><div className="panel-heading"><div><p className="eyebrow">ANOMALY DETECTION</p><h2>이상 탐지 결과</h2></div><span className={`badge ${severity}`}>{anomaly?.status==="ok"?anomaly.is_anomaly?"이상 감지":"정상 범위":diagnosis?.source==="demo"?"모의 진단":anomaly?"평가 불가":"점수 미수신"}</span></div>
    <div className="anomaly-verdict-body">{error&&<p className="form-error" role="alert">{error} · 마지막 판정을 표시합니다.</p>}<strong className="verdict-title">{anomaly?.status==="ok"?anomaly.is_anomaly?"정상 기준에서 벗어난 신호가 감지됐습니다":"현재 신호는 모델의 정상 기준 안에 있습니다":anomaly?anomaly.reason:diagnosis?.title??"아직 이상 탐지 결과를 받지 못했습니다"}</strong>
    {anomaly?.status==="ok"&&<div className="anomaly-score-grid"><div><span>이상 점수</span><strong>{value(anomaly.anomaly_score)}</strong></div><div><span>판정 임계값</span><strong>{value(anomaly.threshold)}</strong></div><div><span>모델 버전</span><strong>{anomaly.model_version}</strong></div></div>}
    <p>{diagnosis?.description??"정상 기간을 승인하고 보드에서 학습·활성화를 완료하면 수신된 판정이 여기에 표시됩니다."}</p>
    {diagnosis&&<p className="ops-note">판정 {new Date(diagnosis.timestamp).toLocaleString("ko-KR",{timeZone:"Asia/Seoul",hour12:false})} · {diagnosis.model}{diagnosis.receivedAt&&` · 서버 수신 ${new Date(diagnosis.receivedAt).toLocaleTimeString("ko-KR",{timeZone:"Asia/Seoul",hour12:false})}`}</p>}
    <p className="ops-note">이상 점수는 미보정 모델 점수이며 고장 확률이 아닙니다. 연결 상태와 센서 자체 판정은 별도로 확인합니다.</p>
    {history.length>0&&<details className="anomaly-history"><summary>최근 판정 이력 {history.length}개</summary><table><thead><tr><th>판정 시각 (KST)</th><th>결과</th><th>점수 / 임계값</th><th>모델</th></tr></thead><tbody>{history.map(d=>{const a=d.edgePrediction?.anomaly_detection;return <tr key={d.id}><td>{new Date(d.timestamp).toLocaleString("ko-KR",{timeZone:"Asia/Seoul",hour12:false})}</td><td>{a?.status==="ok"?a.is_anomaly?"이상":"정상":a?"평가 불가":d.title}</td><td>{a?.status==="ok"?`${value(a.anomaly_score)} / ${value(a.threshold)}`:"—"}</td><td>{d.model}</td></tr>;})}</tbody></table></details>}
    </div></section>;
}
