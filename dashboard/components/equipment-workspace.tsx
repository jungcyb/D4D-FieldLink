"use client";
import Link from "next/link";
import {useFieldChat} from "./chat-provider";
import { useState } from "react";
import { useRouter,useSearchParams } from "next/navigation";
import type { Snapshot,SensorView } from "@/lib/types";
import type { FormState } from "./registration-form";
import Icon from "./icons";
import SensorMonitor from "./sensor-monitor";
const names={normal:"정상",warning:"주의",critical:"위험",unknown:"진단 대기"};
const icons={vibration:"wave",temperature:"thermometer",current:"bolt",analog:"pulse"};
function Status({sensor}:{sensor:SensorView}){return <><span className={`badge ${sensor.diagnosis?.severity||"unknown"}`}><i/>{names[sensor.diagnosis?.severity||"unknown"]}</span><span className={`connection ${sensor.online?"":"offline"}`}><i/>{sensor.online?"최근 응답":"응답 없음"}</span></>;}
export default function EquipmentWorkspace({data,onRegister,onRefresh,toast}:{data:Snapshot;onRegister:(form:FormState)=>void;onRefresh:()=>Promise<void>;toast:(message:string,error?:boolean)=>void}){
  const {openChat}=useFieldChat();
  const router=useRouter(),params=useSearchParams(),[query,setQuery]=useState(""),[filter,setFilter]=useState("all"),[page,setPage]=useState(0);
  const requestedSensor=data.sensors.find(s=>s.id===params.get("sensor"));
  const equipmentId=params.get("equipment")||(requestedSensor?requestedSensor.equipmentId||"unassigned":"all");
  const equipment=data.equipment.find(e=>e.id===equipmentId);
  const sensors=data.sensors.filter(s=>(equipmentId==="all"||equipmentId==="unassigned"&&!s.equipmentId||s.equipmentId===equipmentId)&&`${s.name} ${s.position} ${s.channel} ${s.equipmentName||""}`.toLowerCase().includes(query.toLowerCase())&&(filter==="all"||filter==="offline"&&!s.online||s.diagnosis?.severity===filter||filter==="unknown"&&!s.diagnosis));
  const pages=Math.max(1,Math.ceil(sensors.length/12));const currentPage=Math.min(page,pages-1),visible=sensors.slice(currentPage*12,currentPage*12+12);
  const selected=visible.find(s=>s.id===requestedSensor?.id)||visible[0];
  const impact=data.operations?.impacts.find(i=>i.equipmentId===equipmentId);
  const selectEquipment=(id:string)=>{setPage(0);router.push(`/equipment?equipment=${encodeURIComponent(id)}`,{scroll:false});};
  const selectSensor=(s:SensorView)=>router.push(`/equipment?equipment=${encodeURIComponent(equipmentId)}&sensor=${encodeURIComponent(s.id)}`,{scroll:false});
  return <div className="equipment-workspace"><div className="fleet-select" aria-label="장비 선택"><button onClick={()=>selectEquipment("all")} className={equipmentId==="all"?"selected":""}><Icon name="grid" size={20}/><span><strong>전체 장비</strong><small>{data.sensors.length}개 센서 상태</small></span></button>{data.equipment.map(e=><button key={e.id} className={equipmentId===e.id?"selected":""} onClick={()=>selectEquipment(e.id)}><Icon name="equipment" size={20}/><span><strong>{e.name}</strong><small>{e.sensorCount}개 센서 · {e.location}</small></span><span className={`dot ${e.severity==="critical"?"red":e.online?"teal":"gray"}`}/></button>)}{data.sensors.some(s=>!s.equipmentId)&&<button className={equipmentId==="unassigned"?"selected":""} onClick={()=>selectEquipment("unassigned")}><Icon name="chip" size={20}/><span><strong>장비 미등록</strong><small>DAQ에 연결된 센서</small></span></button>}</div>
    <section className="panel sensor-overview"><div className="panel-heading"><div><p className="eyebrow">SENSOR HEALTH & LIVE SIGNALS</p><h2>{equipment?.name|| (equipmentId==="unassigned"?"장비 미등록 센서":"전체 센서 상태")}</h2><p className="workspace-summary">{equipment?`${equipment.location} · ${equipment.daqCount} DAQ · `:""}{sensors.length}개 센서 · 정상 {sensors.filter(s=>s.diagnosis?.severity==="normal").length} · 주의 {sensors.filter(s=>s.diagnosis?.severity==="warning").length} · 위험 {sensors.filter(s=>s.diagnosis?.severity==="critical").length}</p></div><div className="workspace-actions">{equipment&&<button className="button secondary small" onClick={()=>onRegister({kind:"equipment",item:equipment})}>장비 수정</button>}<button className="button secondary small" disabled={!data.daqs.length||!!equipment&&!equipment.daqCount} onClick={()=>onRegister({kind:"sensor",daqUuid:equipment?data.daqs.find(d=>d.equipmentId===equipment.id)?.uuid:undefined})}><Icon name="plus" size={15}/>센서 등록</button></div></div>
    {impact && ["upstream_blocked","upstream_risk"].includes(impact.state) && <div className="ops-notice impact-banner"><p>{impact.state==="upstream_blocked"?"상위 설비 장애로 운용 불가 추정":"상위 설비 장애 영향 가능"} · 원인 후보 {impact.roots.map(id=>data.equipment.find(e=>e.id===id)?.name).join(", ")}. 아래 센서 자체 진단과 별도로 판단하세요.</p><Link className="text-link" href="/dependencies">관계·장애 사건 보기</Link></div>}
    <div className="panel-tools"><div className="filter-tabs">{[["all","전체"],["critical","위험"],["warning","주의"],["normal","정상"],["unknown","진단 대기"],["offline","응답 없음"]].map(([v,l])=><button key={v} className={filter===v?"active":""} onClick={()=>{setFilter(v);setPage(0);}}>{l}</button>)}</div><label className="search-box"><Icon name="search" size={15}/><input aria-label="센서 · 위치 · 채널 검색" placeholder="센서 · 위치 · 채널 검색" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label></div>
    <div className="channel-grid">{visible.map(s=><button className={`channel-card ${selected?.id===s.id?"selected":""}`} key={s.id} onClick={()=>selectSensor(s)} aria-pressed={selected?.id===s.id}><span className="channel-title"><Icon name={icons[s.type]} size={16}/><strong>{s.channel}</strong><span>{s.name}</span></span><span className="channel-value">{s.latest?.value.toFixed(5)??"—"} <small>{s.unit}</small></span><span className="channel-status"><Status sensor={s}/></span></button>)}</div>
    {!visible.length&&<div className="empty"><h3>표시할 센서가 없습니다</h3><p>조건을 변경하거나 장비에 DAQ를 연결하고 센서를 등록해 주세요.</p></div>}<div className="panel-footer"><span>채널을 선택해 상세 신호 확인 · 채널 목록 5초마다 갱신</span><div className="pagination"><button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)} aria-label="이전 센서 페이지">이전</button><span>{currentPage+1} / {pages}</span><button disabled={currentPage===pages-1} onClick={()=>setPage(currentPage+1)} aria-label="다음 센서 페이지">다음</button></div></div></section>
    {selected&&<div className="rag-launch"><span>{selected.channel} · {selected.position}</span><button className="button secondary small" onClick={()=>openChat({daqUuid:selected.daqUuid,sensorId:selected.id})}>이 센서로 AI 채팅</button></div>}
    {selected&&<SensorMonitor key={selected.id} sensor={selected} onEdit={()=>onRegister({kind:"sensor",item:selected})} onRefresh={onRefresh} toast={toast}/>}
  </div>;
}
