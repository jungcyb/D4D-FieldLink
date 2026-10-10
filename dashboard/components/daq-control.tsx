"use client";
import {useEffect,useState,useCallback} from "react";
import Link from "next/link";
import type {DaqView,SensorView} from "@/lib/types";
import type {DaqSampling} from "@/lib/daq-types";
import type {AcquisitionStatus,AcquisitionCommand} from "@/lib/server/daq-control";
import {channelRows,channelKey,rateInGroup,samplingFromCapabilities} from "@/lib/daq-sampling";
import {formatSampleRate} from "@/lib/sampling";
import {api,send} from "@/lib/client-api";
import Dialog from "./dialog";

export default function DaqControl({daq,sensors,onRefresh}:{daq:DaqView;sensors:SensorView[];onRefresh:()=>Promise<void>}){
  const [status,setStatus]=useState<AcquisitionStatus|null>(null),[commonDraft,setCommonDraft]=useState<string|null>(null),[drafts,setDrafts]=useState<Record<string,string>>({});
  const [groupDrafts,setGroupDrafts]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState(""),[confirm,setConfirm]=useState<AcquisitionCommand|null>(null);
  const mock=daq.source==="demo";
  const read=useCallback(async(signal?:AbortSignal)=>{const next=await api<AcquisitionStatus>(`/daqs/${daq.uuid}/acquisition`,{signal});setStatus(next);setError("");},[daq.uuid]);
  useEffect(()=>{
    if(mock||busy)return;
    const controller=new AbortController();let inFlight=false;
    const load=async()=>{if(inFlight||document.hidden)return;inFlight=true;try{await read(controller.signal);}catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:"수집 상태 조회 실패");}finally{inFlight=false;}};
    void load();const timer=setInterval(load,5000);document.addEventListener("visibilitychange",load);
    return()=>{controller.abort();clearInterval(timer);document.removeEventListener("visibilitychange",load);};
  },[read,mock,busy]);
  async function execute(){
    if(!confirm)return;setBusy(true);setError("");setMessage("");
    try{const next=await send<AcquisitionStatus>(`/daqs/${daq.uuid}/acquisition`,confirm);setStatus(next);setCommonDraft(null);setDrafts({});setGroupDrafts({});setConfirm(null);setMessage("보드 응답 확인 · 적용된 rate를 갱신했습니다.");await onRefresh();}
    catch(e){setError(e instanceof Error?e.message:"명령 실패");setConfirm(null);}finally{setBusy(false);}
  }
  const mockSampling:DaqSampling={commonRateHz:daq.scanRateHz??null,totalRateHz:sensors.every(s=>s.sps!=null)?sensors.reduce((sum,s)=>sum+(s.sps??0),0):null,channels:sensors.map(s=>({channel:s.channel,sps:s.sps})),complete:true,mode:"per-channel",totalSource:"sum",updatedAt:daq.lastSeen};
  const declared=status?.channel_capabilities?.channels??daq.channels??[],groups=status?.channel_capabilities?.sampleRateGroups??daq.sampleRateGroups??[];
  const sampling=status?.sampling??daq.sampling??(declared.length?samplingFromCapabilities({channels:declared}):mock?mockSampling:undefined);
  const declaredKeys=new Set(declared.map(channel=>channelKey(channel.id))),displaySensors=declared.length?sensors.filter(sensor=>declaredKeys.has(channelKey(sensor.channel))):sensors,undeclaredSensors=declared.length?sensors.length-displaySensors.length:0;
  const rows=channelRows(sampling,displaySensors),common=sampling?.commonRateHz??daq.scanRateHz??null;
  const canControl=!mock&&!!status&&!error&&!busy&&status.capabilities.control;
  const canCommon=!mock&&!!status&&!error&&!busy&&status.capabilities.commonRate;
  const requestedCommon=commonDraft===null?common:Number(commonDraft),validCommon=requestedCommon!=null&&Number.isInteger(requestedCommon)&&requestedCommon>=10&&requestedCommon<=2000;
  const canChannel=!mock&&!!status&&!error&&!busy&&status.capabilities.channelRate;
  const total=sampling?.totalRateHz,pendingStreams=declared.filter(channel=>!channel.streamAvailable).length;
  const summary=total==null?"전체값 미수신":sampling?.totalSource==="board"?"보드가 보고한 모든 채널 합계":"모든 보고 채널의 합계";
  return <div className="daq-control"><div className="acquisition-state"><strong>데이터 수집</strong><span className={`badge ${mock?"normal":error?"warning":status?.acquiring?"normal":"unknown"}`}>{mock?"모의 데이터":error?"상태 확인 불가":status?status.acquiring?"수집 중":"수집 정지":"상태 확인 중"}</span></div>
    <div className="daq-total-rate"><span>전체 샘플레이트</span><strong>{total==null?"—":total.toLocaleString("ko-KR")}<small>samples/s</small></strong><p>{summary} · 채널마다 다른 SPS 지원</p></div>
    {pendingStreams>0&&<p className="daq-rate-note">설정된 채널 합계입니다. {pendingStreams}개 채널은 스트림 연동 대기 중이므로 실제 수신량과 다를 수 있습니다.</p>}
    {undeclaredSensors>0&&<p className="daq-rate-note">보드가 현재 보고하지 않는 기존 센서 매핑 {undeclaredSensors}개는 채널 수와 샘플레이트 합계에서 제외했습니다.</p>}
    {groups.length>0?groups.map(group=>{
      const requested=groupDrafts[group.id]===undefined?group.currentHz:Number(groupDrafts[group.id]),valid=rateInGroup(group,requested);
      return <form key={group.id} className="daq-common-rate" onSubmit={e=>{e.preventDefault();if(canCommon&&valid)setConfirm({action:"rate",groupId:group.id,rate:requested});}}>
        <label>{group.label} <small>{group.channelIds.length}채널 · {group.writable?"그룹 공통 설정":"고정 샘플레이트"}</small><div className="rate-input"><input aria-label={`${daq.label} ${group.label} 샘플레이트`} type="number" min={group.minHz} max={group.maxHz} step={group.stepHz??"any"} required value={groupDrafts[group.id]??group.currentHz} onChange={e=>setGroupDrafts(current=>({...current,[group.id]:e.target.value}))} disabled={!canCommon||!group.writable}/>{group.writable&&<button className="button secondary small" disabled={!canCommon||!valid||requested===group.currentHz}>그룹 적용</button>}</div></label><small>{group.writable?`${group.minHz}–${group.maxHz} SPS · ${group.stepHz} SPS 간격 · 그룹 내 모든 채널에 적용`:"보드 고정 설정 · 변경 불가"}</small>
      </form>;
    }):<form className="daq-common-rate" onSubmit={e=>{e.preventDefault();if(canCommon&&validCommon)setConfirm({action:"rate",rate:requestedCommon!});}}>
      <label>전체 채널 공통 기본값 <small>SPS / 채널</small><div className="rate-input"><input aria-label={`${daq.label} 공통 샘플레이트`} type="number" min={10} max={2000} step={1} required value={commonDraft??common??""} placeholder="미수신" onChange={e=>setCommonDraft(e.target.value)} disabled={!canCommon}/><button className="button secondary small" disabled={!canCommon||!validCommon||requestedCommon===common}>공통 적용</button></div></label><small>기존 보드 공통 제어 범위 10–2,000 SPS / 채널</small>
    </form>}
    <div className="daq-channel-heading"><strong>채널별 샘플레이트</strong><span>{rows.length}채널</span></div>
    {rows.length?<div className="daq-channel-scroll"><table className="daq-channel-table"><thead><tr><th>채널 / 센서</th><th>보고된 SPS</th><th>개별 설정</th></tr></thead><tbody>{rows.map(row=>{
      const key=channelKey(row.channel),sensor=sensors.find(s=>channelKey(s.channel)===key),draft=drafts[key],requested=draft===undefined?row.sps:Number(draft),valid=requested!=null&&Number.isFinite(requested)&&requested>=.01&&requested<=1000000;
      const hardware=declared.find(channel=>channelKey(channel.id)===key),group=groups.find(group=>group.id===hardware?.rateGroupId);
      const reported=status?.sampling.channels.some(c=>channelKey(c.channel)===key),editable=groups.length>0?canCommon&&!!group?.writable&&group.channelIds.length===1:canChannel&&reported;
      const validRate=group?requested!=null&&rateInGroup(group,requested):valid;
      return <tr key={key}><td><strong>{row.channel}</strong>{sensor?<Link href={`/equipment?sensor=${encodeURIComponent(sensor.id)}`}>{row.name}</Link>:<small>{row.name}</small>}{group&&<small>{group.label} · {group.writable?group.channelIds.length>1?"그룹에서 함께 변경":"개별 변경 가능":"고정"}</small>}{hardware?.streamAvailable===false&&<small className="daq-channel-offline">수집 연동 대기</small>}{row.connected===false&&<small className="daq-channel-offline">센서 분리됨</small>}</td><td className="mono">{formatSampleRate(row.sps)}</td><td><form onSubmit={e=>{e.preventDefault();if(editable&&validRate)setConfirm(group?{action:"rate",groupId:group.id,rate:requested!}:{action:"channel_rate",channel:row.channel,sps:requested!});}}><input aria-label={`${daq.label} ${row.channel} 샘플레이트`} type="number" min={group?.minHz??.01} max={group?.maxHz??1000000} step={group?.stepHz??"any"} value={draft??row.sps??""} placeholder="미수신" disabled={!editable} onChange={e=>setDrafts(current=>({...current,[key]:e.target.value}))}/><button className="button secondary small" disabled={!editable||!validRate||requested===row.sps}>적용</button></form></td></tr>;
    })}</tbody></table></div>:<p className="muted daq-no-channels">DAQ가 센서 목록이나 채널별 rate를 보내면 여기에 표시됩니다.</p>}
    <p className="daq-rate-note">{mock?"모의 센서의 채널별 값을 표시합니다. 보드 명령은 전송하지 않습니다.":groups.length?"동일 그룹의 채널은 함께 변경됩니다. 고정 그룹은 변경할 수 없습니다.":status?.capabilities.channelRate?"채널별 설정은 해당 채널에 요청하고 보드의 최종 응답으로 확인합니다.":"개별 변경은 보드의 채널별 설정 지원 후 활성화됩니다. 수신된 채널별 값은 저장·표시됩니다."}</p>
    <div className="acquisition-actions"><button className="button primary" disabled={!canControl||status?.acquiring} onClick={()=>setConfirm({action:"start"})}>수집 시작</button><button className="button danger" disabled={!canControl||!status?.acquiring} onClick={()=>setConfirm({action:"stop"})}>수집 정지</button></div>
    {message&&<p role="status" className="control-success">{message}</p>}{error&&<p className="form-error" role="alert">{error}</p>}
    {confirm&&<Dialog title={confirm.action==="stop"?"보드 데이터 수집을 정지할까요?":confirm.action==="start"?"보드 데이터 수집을 시작할까요?":"샘플레이트를 변경할까요?"} subtitle={daq.label} onClose={()=>setConfirm(null)} busy={busy}>
      <p>{confirm.action==="channel_rate"?`${confirm.channel}를 ${confirm.sps} SPS로 변경 요청합니다. 적용 결과는 보드 응답에서 확인합니다.`:confirm.action==="rate"&&confirm.groupId?`${groups.find(group=>group.id===confirm.groupId)?.label??confirm.groupId}를 ${confirm.rate} SPS로 변경합니다. 대상 채널: ${groups.find(group=>group.id===confirm.groupId)?.channelIds.join(", ")??""}. 그룹 내 모든 채널이 함께 변경됩니다.`:confirm.action==="rate"?`공통 기본값을 ${confirm.rate} SPS / 채널로 변경합니다. 전체 채널에 영향을 줄 수 있으므로 변경 후 각 채널의 보고값을 확인하세요.`:confirm.action==="stop"?"보드의 새 샘플 수집과 저장이 멈춥니다. 다른 사용자에게도 영향을 줍니다.":"현재 샘플레이트 설정으로 수집을 시작합니다."}</p>
      <div className="ops-form-actions"><button className="button secondary" disabled={busy} onClick={()=>setConfirm(null)}>취소</button><button className={`button ${confirm.action==="stop"?"danger":"primary"}`} disabled={busy} onClick={()=>void execute()}>{busy?"보드 응답 대기…":"확인 · 보드에 적용"}</button></div>
    </Dialog>}
  </div>;
}
