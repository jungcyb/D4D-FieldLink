"use client";
import {useCallback,useState} from "react";
import type {SensorView} from "@/lib/types";
import {api} from "@/lib/client-api";
import {formatSampleRate} from "@/lib/sampling";
import RawCanvas,{type RawWindow} from "./raw-canvas";
import {useLiveRefresh} from "./use-live-refresh";
export default function SensorSignalPreview({sensor}:{sensor:SensorView}){
  const [signal,setSignal]=useState<RawWindow|null>(null),[error,setError]=useState("");
  const load=useCallback(async(abort:AbortSignal)=>{try{setSignal(await api<RawWindow>(`/sensors/${sensor.id}/window?maxPoints=400`,{signal:abort}));setError("");}catch(e){if(!abort.aborted)setError(e instanceof Error?e.message:"요약 신호 조회 실패");}},[sensor.id]);
  const {live}=useLiveRefresh(load);
  return <section className="panel sensor-signal-preview" aria-label={`${sensor.name} 요약 신호`}><div className="panel-heading"><div><p className="eyebrow">LIGHTWEIGHT LIVE SIGNAL</p><h2>센서 데이터 요약</h2><p className="workspace-summary">{sensor.name} · {sensor.channel} · {formatSampleRate(signal?.count?signal.sps:sensor.sps)}</p></div><span className={`badge ${live?"normal":"unknown"}`}>{live?"실시간 갱신":"연결 확인"}</span></div>
    <div className="signal-preview-body">{error&&<p className="form-error" role="alert">{error}</p>}{signal?.count?<><RawCanvas compact window={signal} unit={sensor.unit} height={210}/><p className="chart-caption">원본 {signal.count.toLocaleString()}개 → 표시 {signal.points.length}점 · 피크 보존 요약 · {signal.timestamp&&new Date(signal.timestamp).toLocaleString("ko-KR",{timeZone:"Asia/Seoul",hour12:false})} 수집</p></>:<div className="empty compact">센서 데이터 수신 대기</div>}
    <p className="ops-note">웹은 최신 수신 배치를 최대 400점으로 요약합니다. 정밀한 연속 파형은 Live Console에서 확인하세요.</p>{!sensor.online&&<p className="data-warning">DAQ 응답 없음 · 마지막 수신 데이터가 표시될 수 있습니다.</p>}</div></section>;
}
