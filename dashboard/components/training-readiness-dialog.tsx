"use client";
import {useState} from "react";
import Link from "next/link";
import type {SensorView} from "@/lib/types";
import {api,send} from "@/lib/client-api";
import Dialog from "./dialog";
import Icon from "./icons";

interface Readiness{
  from:string;to:string;rawBatches:number;hotBatches:number;recoveredBatches:number;rawSamples:number;estimatedWindows:number;recommendedWindows:number;contiguousSegments:number;normalReviewState:"unreviewed"|"approved";dataReady:boolean;trainingApiAvailable:boolean;note:string;
  requirements:{id:string;label:string;ok:boolean;detail:string}[];
}
const local=(date:Date)=>date.toLocaleString("sv-SE",{timeZone:"Asia/Seoul",hour12:false}).replace(" ","T").slice(0,19);
const kstIso=(value:string)=>new Date(`${value}${value.length===16?":00":""}+09:00`).toISOString();
export default function TrainingReadinessDialog({sensor,onClose}:{sensor:SensorView;onClose:()=>void}){
  const now=new Date(),[from,setFrom]=useState(local(new Date(now.getTime()-10*60000))),[to,setTo]=useState(local(now)),[checking,setChecking]=useState(false),[approving,setApproving]=useState(false),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(""),[result,setResult]=useState<Readiness|null>(null);
  async function load(){const query=new URLSearchParams({from:kstIso(from),to:kstIso(to)});return api<Readiness>(`/sensors/${sensor.id}/training-readiness?${query}`);}
  async function inspect(event:React.FormEvent){event.preventDefault();setError("");setResult(null);setConfirmed(false);if(!from||!to||from>=to){setError("검사할 시작·종료 시각을 확인해 주세요.");return;}setChecking(true);try{setResult(await load());}catch(error){setError(error instanceof Error?error.message:"재학습 준비 상태 조회 실패");}finally{setChecking(false);}}
  async function approve(){if(!result||!confirmed)return;setApproving(true);setError("");try{await send(`/sensors/${sensor.id}/normal-ranges`,{from:result.from,to:result.to,confirmNormal:true,acceptIntegrity:true});setResult(await load());}catch(error){setError(error instanceof Error?error.message:"정상 기간 승인 실패");}finally{setApproving(false);}}
  const change=(setter:(value:string)=>void)=>(event:React.ChangeEvent<HTMLInputElement>)=>{setter(event.target.value);setResult(null);setConfirmed(false);};
  return <Dialog title="정상 학습 기간 선택" subtitle={`${sensor.name} · ${sensor.channel} · v0.4 normal-only`} onClose={onClose} busy={checking||approving} wide>
    <form className="training-readiness" onSubmit={inspect}><div className="training-flow" aria-label="모델 재학습 단계">{[["01","정상 데이터"],["02","운영자 승인"],["03","후보 학습·검증"],["04","명시적 활성화"]].map(([step,label])=><div key={step}><span>{step}</span><strong>{label}</strong></div>)}</div>
      <p className="training-note"><Icon name="info" size={17}/><span><strong>MVP 운영 기준: 선택한 기간을 사용자가 정상 데이터로 확정합니다.</strong><br/>시스템은 Raw 존재 여부와 윈도우 수만 안내하며, 선택 기간의 실제 정상 운전 여부와 데이터 무결성은 승인한 사용자의 판단을 따릅니다.</span></p>
      <div className="ops-form-grid"><label>정상 기간 시작 (KST)<input type="datetime-local" step={1} value={from} onChange={change(setFrom)} required/></label><label>정상 기간 종료 (KST)<input type="datetime-local" step={1} value={to} onChange={change(setTo)} required/></label></div>
      {error&&<p className="form-error" role="alert"><Icon name="warning" size={16}/>{error}</p>}
      {result&&<div className="training-result" aria-live="polite"><div className="training-counts"><span>Raw 배치<strong>{result.rawBatches.toLocaleString()}</strong><small>중앙 {result.hotBatches.toLocaleString()} · 복구 {result.recoveredBatches.toLocaleString()}</small></span><span>원본 샘플<strong>{result.rawSamples.toLocaleString()}</strong></span><span>학습 후보<strong>{result.estimatedWindows.toLocaleString()}</strong><small>권장 {result.recommendedWindows.toLocaleString()}</small></span><span>연속 구간<strong>{result.contiguousSegments.toLocaleString()}</strong></span></div><div className={`training-review-state ${result.normalReviewState}`}><Icon name={result.normalReviewState==="approved"?"check":"info"} size={16}/><span><strong>{result.normalReviewState==="approved"?"사용자 정상 승인 완료":"사용자 정상 승인 대기"}</strong><small>{result.normalReviewState==="approved"?"선택 기간과 데이터 무결성 확인 기록됨":"자동 정상 판정 없음 · 사용자가 선택"}</small></span></div><div className="training-checklist">{result.requirements.map(row=><div className={row.ok?"ok":"blocked"} key={row.id}><Icon name={row.ok?"check":"warning"} size={16}/><span><strong>{row.label}</strong><small>{row.detail}</small></span></div>)}</div>{result.normalReviewState!=="approved"&&<label className="training-confirm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>이 기간은 정상 운전 상태이며, 포함된 데이터의 무결성을 직접 확인했습니다.</span></label>}<p className={`training-verdict ${result.dataReady?"ready":"blocked"}`}>{result.dataReady?result.normalReviewState==="approved"?"정상 학습 기간으로 기록했습니다.":"Raw 윈도우가 확인되어 사용자가 정상 기간으로 승인할 수 있습니다.":"선택 기간에 완전한 Raw 윈도우가 없습니다. 기간 데이터 복구 후 다시 확인하세요."}</p><p className="ops-note">{result.note} 이 승인만으로 운영 모델이 즉시 교체되지는 않습니다.</p></div>}
      <div className="modal-actions"><Link className="button secondary" href="/recovery" onClick={onClose}>기간 데이터·복구 관리</Link>{result&&result.normalReviewState!=="approved"&&<button type="button" className="button secondary" disabled={!result.dataReady||!confirmed||approving} onClick={approve}>{approving?"승인 기록 중…":"정상 기간으로 승인"}</button>}<button className="button primary" disabled={checking||approving}>{checking?"확인 중…":"기간 데이터 확인"}</button></div>
    </form>
  </Dialog>;
}
