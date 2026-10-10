"use client";
import Link from "next/link";
import {useFieldChat} from "./chat-provider";
import { useState, useEffect, useCallback } from "react";
import { useLiveRefresh } from "./use-live-refresh";
import type { Snapshot, EquipmentView, SensorView, Sensor, TaskView, DiagnosisView } from "@/lib/types";
import { api, send } from "@/lib/client-api";
import Icon from "./icons";
import {formatLifetime,formatEquipmentLifetime,anomalyText} from "@/lib/prediction";
import RegistrationForm, { type FormState } from "./registration-form";
import EquipmentWorkspace from "./equipment-workspace";
import SensorSignalPreview from "./sensor-signal-preview";
import DaqControl from "./daq-control";
import RecoveryWorkspace from "./recovery-workspace";
import LogWorkspace from "./log-workspace";
import DependencyWorkspace from "./dependency-workspace";
import { useRouter } from "next/navigation";

type View = "overview" | "equipment" | "daqs" | "maintenance" | "recovery" | "logs" | "dependencies";
const states = { normal: "정상", warning: "주의", critical: "위험", unknown: "상태 미확인" };
const time = (date: string) => new Date(date).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });
const priorities = { critical: "긴급", high: "높음", normal: "일반" };
const taskStatuses = { pending: "대기", in_progress: "진행 중", completed: "완료" };
const nav = [
  { view: "overview", href: "/", label: "운용 현황", icon: "grid" },
  { view: "equipment", href: "/equipment", label: "장비 · 센서", icon: "equipment" },
  { view: "daqs", href: "/daqs", label: "DAQ 관리", icon: "chip" },
  { view: "maintenance", href: "/maintenance", label: "정비 관리", icon: "wrench" },
  { view: "recovery", href: "/recovery", label: "연결 · 데이터 복구", icon: "refresh" },
  { view: "dependencies", href: "/dependencies", label: "설비 관계 · 장애 사건", icon: "link" },
  { view: "logs", href: "/logs", label: "운용 로그", icon: "clock" },
] as const;
const headings = {
  recovery: ["RECONNECTION & RECOVERY", "연결 · 데이터 복구", "DAQ 연결 상태와 Raw·Log 복구 범위를 관리하세요."],
  logs: ["OPERATION LOGS", "운용 로그", "연결·복구·장애·센서 위치 확인 기록을 조회하세요."],
  dependencies: ["DEPENDENCIES & INCIDENTS", "설비 관계 · 장애 사건", "선후관계와 연관 증상으로 장애 원인 후보를 추적하세요."],
  overview: ["OPERATIONS OVERVIEW", "운용 현황", "장비 상태와 이상탐지 결과로 다음 정비를 준비하세요."],
  equipment: ["EQUIPMENT & SENSORS", "이상탐지 모니터링", "센서 요약 신호·이상 탐지 결과를 확인하고 정상 기간으로 모델 학습을 요청하세요."],
  daqs: ["DATA ACQUISITION", "DAQ 관리", "장치 연결, 샘플레이트와 데이터 수집을 관리합니다."],
  maintenance: ["MAINTENANCE OPERATIONS", "정비 관리", "진단 결과를 정비 작업으로 연결하고 진행 상태를 관리하세요."],
};
function Badge({ severity }: { severity: keyof typeof states }) { return <span className={`badge ${severity}`}><i/>{states[severity]}</span>; }
function Empty({ title, message, action }: { title: string; message?: string; action?: React.ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon name="chip" size={28}/></div><h3>{title}</h3>{message && <p>{message}</p>}{action}</div>;
}
export default function Dashboard({ view }: { view: View }) {
  const {publishSnapshot,snapshot:cachedSnapshot}=useFieldChat();
  const [data, setData] = useState<Snapshot | null>(cachedSnapshot); const [error, setError] = useState(""); const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState(""); const [filter, setFilter] = useState("all"); const [form, setForm] = useState<FormState | null>(null);
  const router = useRouter();
  const setEquipmentId = (id: string) => router.push(`/equipment?equipment=${encodeURIComponent(id)}`);
  const setSensorId = (id: string) => router.push(`/equipment?sensor=${encodeURIComponent(id)}`);
  const [toastMessage, setToastMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [scanning, setScanning] = useState(false); const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [signalSensor,setSignalSensor]=useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [requestMs, setRequestMs] = useState<number | null>(null);
  const toast = useCallback((text: string, error = false) => setToastMessage({ text, error }), []);
  useEffect(() => { if (!toastMessage) return; const timeout = setTimeout(() => setToastMessage(null), 5000); return () => clearTimeout(timeout); }, [toastMessage]);
  const load = useCallback(async (signal: AbortSignal) => {
    const started = performance.now(); setRefreshing(true);
    try { const next=await api<Snapshot>("/dashboard", {signal}); if (!signal.aborted) { setData(next); publishSnapshot(next); setReceivedAt(Date.now()); setRequestMs(Math.round(performance.now()-started)); setError(""); } }
    catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : "서버 연결 실패"); }
    finally { if (!signal.aborted) setRefreshing(false); }
  }, [publishSnapshot]);
  const {live,refresh} = useLiveRefresh(load);
  async function discover() {
    setScanning(true);
    try { const result = await send<{ count: number }>("/discovery", {}); await refresh(); toast(`${result.count}개 DAQ 응답을 확인했습니다.`); }
    catch (error) { toast(error instanceof Error ? error.message : "DAQ 탐색 실패", true); }
    finally { setScanning(false); }
  }
  async function submit(fields: Record<string, unknown>, photo: File | null) {
    if (!form) return;
    if (photo && photo.size > 5 * 1024 * 1024) throw new Error("사진은 5MB 이하여야 합니다.");
    let savedSensor: Sensor | null = null;
    if (form.kind === "equipment") await send(`/equipment${form.item ? `/${form.item.id}` : ""}`, fields, form.item ? "PATCH" : "POST");
    if (form.kind === "bind") await send(`/daqs/${form.item.uuid}`, fields, "PATCH");
    if (form.kind === "task") await send(`/tasks${form.item ? `/${form.item.id}` : ""}`, fields, form.item ? "PATCH" : "POST");
    if (form.kind === "sensor") {
      savedSensor = await send<Sensor>(`/sensors${form.item ? `/${form.item.id}` : ""}`, fields, form.item ? "PATCH" : "POST");
      if (photo) {
        try { const body = new FormData(); body.set("photo", photo); await api(`/sensors/${savedSensor.id}/photo`, { method: "POST", body }); }
        catch (error) { setForm(null); await refresh(); setSensorId(savedSensor.id); toast(`센서는 저장되었습니다. 사진 등록 실패: ${error instanceof Error ? error.message : "다시 시도해 주세요."}`, true); return; }
      }
    }
    setForm(null); await refresh(); if (savedSensor) setSensorId(savedSensor.id); toast("변경사항을 저장했습니다.");
  }
  async function deleteSensor(sensor:SensorView){
    await api(`/sensors/${sensor.id}`,{method:"DELETE"});
    await refresh();
    router.replace(sensor.equipmentId?`/equipment?equipment=${encodeURIComponent(sensor.equipmentId)}`:"/equipment",{scroll:false});
    toast(`${sensor.name} 센서 매핑을 삭제했습니다.`);
  }
  async function updateTask(task: TaskView) {
    const status = task.status === "pending" ? "in_progress" : task.status === "in_progress" ? "completed" : "pending";
    setActionBusy(task.id);
    try { await send(`/tasks/${task.id}`, { status }, "PATCH"); await refresh(); toast(`작업 상태를 '${taskStatuses[status]}'로 변경했습니다.`); }
    catch (error) { toast(error instanceof Error ? error.message : "작업 변경 실패", true); }
    finally { setActionBusy(null); }
  }
  async function acknowledge(diagnosis: DiagnosisView) {
    setActionBusy(diagnosis.id);
    try { await send(`/diagnoses/${diagnosis.id}/acknowledge`, {}); await refresh(); toast("진단을 확인 처리했습니다. 장비 위험 상태는 새 진단이 수신되면 갱신됩니다."); }
    catch (error) { toast(error instanceof Error ? error.message : "처리 실패", true); }
    finally { setActionBusy(null); }
  }
  const matched = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase());
  const equipment = data?.equipment.filter(e => matched(`${e.name} ${e.location} ${e.category} ${e.sensors.map(s => s.name).join(" ")}`) && (filter === "all" || e.severity === filter || filter === "offline" && !e.online)) || [];
  const daqs = data?.daqs.filter(d => matched(`${d.label} ${d.uuid} ${d.ip} ${d.equipmentName}`) && (filter === "all" || filter === "unassigned" && !d.equipmentId || filter === "offline" && !d.online || filter === "online" && d.online)) || [];
  const tasks = data?.tasks.filter(t => matched(`${t.title} ${t.equipmentName} ${t.assignee}`) && (filter === "all" || t.status === filter)) || [];
  const alerts = data?.diagnoses.filter(d => d.severity === "warning" || d.severity === "critical") || [];
  const diagnosticInbox=data?.diagnoses.filter(d=>d.severity==="warning"||d.severity==="critical"||!!d.edgePrediction)||[];
  const latestDiagnoses=(data?.diagnoses||[]).toSorted((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,5);
  const summary = data?.summary;
  const primaryAction = () => view === "daqs" ? void discover() : setForm(view === "maintenance" ? { kind: "task" } : { kind: "equipment" });
  return <div className="app-shell"><a className="skip-link" href="#main-content">본문으로 이동</a>
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}><Link className="brand" href="/"><div className="brand-mark"><Icon name="pulse" size={26}/></div><span>FIELD<span className="brand-light">LINK</span><small>PREDICTIVE MAINTENANCE</small></span></Link>
      <div className="workspace-label"><Icon name="chip" size={14}/>D4D · 현장 운용 콘솔</div>
      <p className="nav-caption">WORKSPACE</p><nav aria-label="주요 메뉴">{nav.map(n => <Link key={n.view} href={n.href} onClick={() => setMobileNav(false)} className={`nav-item ${view === n.view ? "active" : ""}`} aria-current={view === n.view ? "page" : undefined}><Icon name={n.icon} size={19}/>{n.label}{n.view === "maintenance" && !!summary?.openTasks && <span className="nav-count">{summary.openTasks}</span>}{n.view === "daqs" && !!data?.daqs.filter(d => !d.equipmentId).length && <span className="nav-count">{data.daqs.filter(d => !d.equipmentId).length}</span>}</Link>)}</nav>
      <div className="sidebar-bottom"><div className="operator"><div className="avatar">OP</div><div><strong>현장 운영자</strong><span>Local workspace</span></div><span className={`dot ${error ? "red" : "teal"}`}/></div></div>
    </aside>
    {mobileNav && <button className="mobile-scrim" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)}/>}
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="메뉴 열기"><Icon name="menu"/></button><span>Workspace</span><Icon name="chevron" size={13}/><strong>{nav.find(n => n.view === view)?.label}</strong></div><div className="topbar-right"><span className={`connection ${error ? "offline" : ""}`}><i/>{error ? "서버 연결 오류" : data ? "서버 연결됨" : "연결 중"}</span><span className="topbar-divider"/><span className="environment-tag">{data?.mode === "external" ? "장치 데이터" : data ? "모의 데이터" : "연결 확인 중"}</span><div className="avatar small">OP</div></div></header>
      <main id="main-content"><div className="page-heading"><div><p className="eyebrow">{headings[view][0]}</p><h1>{headings[view][1]}</h1><p>{headings[view][2]}</p></div><div className="heading-actions"><button className="button secondary icon-only" aria-label="데이터 새로고침" onClick={() => void refresh()} disabled={refreshing}><Icon name="refresh" className={refreshing ? "spinning" : ""}/></button>{["overview","equipment","daqs","maintenance"].includes(view) && <button className="button primary" onClick={primaryAction} disabled={!data || scanning || view === "maintenance" && !data.equipment.length}><Icon name={view === "daqs" ? "scan" : "plus"} size={18}/>{view === "daqs" ? scanning ? "DAQ 탐색 중…" : "DAQ 탐색" : view === "maintenance" ? "정비 작업 등록" : "장비 등록"}</button>}</div></div>
        {error && <div className="error-banner" role="alert"><Icon name="warning" size={19}/><div><strong>서버 연결을 확인해 주세요</strong><p>{error}{data ? " · 화면에는 마지막으로 조회한 데이터가 표시됩니다." : ""}</p></div><button className="button small secondary" onClick={() => void refresh()}>다시 시도</button></div>}
        {data?.mode === "demo" && <div className="demo-banner"><span className="demo-tag">DEMO</span><p><strong>모의 데이터 환경입니다. 실제 장비 측정값이 아닙니다.</strong></p></div>}
        <div className={`live-status-bar ${error ? "stale" : ""}`} aria-label="화면 갱신 상태"><span><i className={`dot ${error ? "red" : data ? "teal" : "gray"}`}/>{error ? "통신 오류 · 마지막 조회값" : live ? "이벤트 즉시 갱신 · 5초 안전 조회" : "1초마다 조회 · 이벤트 재연결 중"}</span><span className="mono">{receivedAt ? `${time(new Date(receivedAt).toISOString())} KST 조회 · API ${requestMs} ms` : "서버 응답 대기"}</span>{data&&<Link className="live-alarm-link" href="/maintenance"><Icon name="warning" size={14}/>위험 {data.diagnoses.filter(d=>d.severity==="critical").length} · 주의 {data.diagnoses.filter(d=>d.severity==="warning").length}<Icon name="arrow" size={14}/></Link>}</div>
        {!data ? <div className="loading-state"><Icon name="refresh" className="spinning" size={26}/><h3>{error ? "데이터를 불러오지 못했습니다" : "현장 데이터를 불러오고 있습니다"}</h3><p>DAQ · 장비 · 센서 상태를 확인합니다.</p></div> : <>
          {view === "overview" && <section className="metrics" aria-label="상태 요약"><Metric label="등록 장비" value={summary!.equipment} unit="대" icon="equipment" detail={`${summary!.sensors}개 센서가 등록되어 있습니다`}/><Metric label="응답 중 DAQ" value={summary!.onlineDaqs} unit={`/ ${summary!.daqs}`} icon="chip" detail="최근 30초 내 응답 · TCP 연결 상태와 별도" color="teal"/><Metric label="정비 필요 장비" value={summary!.critical + summary!.warning} unit="대" icon="warning" detail={`위험 ${summary!.critical} · 주의 ${summary!.warning}`} color="orange"/><Metric label="진행할 정비 작업" value={summary!.openTasks} unit="건" icon="wrench" detail={`${data.tasks.filter(t => t.status === "in_progress").length}건 진행 중 · ${data.tasks.filter(t => t.status === "pending").length}건 대기`}/></section>}
          {view === "recovery" && <RecoveryWorkspace data={data} onRefresh={refresh} toast={toast}/>}
          {view === "logs" && <LogWorkspace data={data}/>}
          {view === "dependencies" && <DependencyWorkspace data={data} onRefresh={refresh} toast={toast}/>}
          {view === "overview" && <><div className="overview-grid"><section className="panel equipment-panel"><PanelHeading eyebrow="FLEET STATUS" title="장비 운용 현황" trailing={<Link href="/equipment" className="text-link">전체 보기<Icon name="arrow" size={16}/></Link>}/><div className="panel-tools"><div className="filter-tabs">{[["all", "전체"], ["critical", "위험"], ["warning", "주의"], ["normal", "정상"]].map(([value, label]) => <button key={value} onClick={() => setFilter(value)} className={filter === value ? "active" : ""}>{label}{value === "all" && <span>{data.equipment.length}</span>}</button>)}</div><Search value={query} onChange={setQuery} placeholder="장비 검색"/></div><EquipmentTable items={equipment} onSelect={setEquipmentId}/><div className="panel-footer"><span><span className="dot teal"/>장비 상태 · 이벤트 갱신</span><span className="mono">{time(data.serverTime)} KST</span></div></section>
            <section className="panel priority-panel"><PanelHeading eyebrow="ACTION REQUIRED" title="우선 점검 대상" trailing={<span className="count-pill">{alerts.length}</span>}/><div className="priority-list">{alerts.length ? alerts.slice(0, 3).map((d, i) => <button key={d.id} className={`priority-item ${d.severity}`} onClick={() => setSensorId(d.sensorId)}><span className="priority-index">0{i+1}</span><div><div className="priority-title"><strong>{d.equipmentName || d.sensorName}</strong><Badge severity={d.severity}/></div><p>{d.title}</p><div className="priority-meta"><span><Icon name="clock" size={13}/>예상 수명 {formatLifetime(d)}</span><span>{d.edgePrediction?anomalyText(d):d.confidence == null ? "—" : `${Math.round(d.confidence*100)}% 신뢰도`}</span></div></div><Icon name="chevron" size={16}/></button>) : <Empty title="점검이 필요한 진단이 없습니다"/>}</div><div className="priority-note"><Icon name="info" size={16}/><p>위험도와 잔여수명을 참고해 점검 순서를 판단하세요. 진단 확인과 작업 완료는 위험 상태를 해제하지 않습니다.</p></div><Link href="/maintenance" className="button secondary full">정비 작업 관리<Icon name="arrow" size={16}/></Link></section></div>
            {data.sensors.length>0&&<><div className="signal-selector"><label>실시간 요약 센서<select aria-label="요약 신호 센서 선택" value={data.sensors.some(s=>s.id===signalSensor)?signalSensor:data.sensors[0].id} onChange={e=>setSignalSensor(e.target.value)}>{data.sensors.map(s=><option key={s.id} value={s.id}>{s.equipmentName||s.daqLabel} · {s.channel} · {s.name}</option>)}</select></label><Link className="text-link" href={`/equipment?sensor=${encodeURIComponent(data.sensors.find(s=>s.id===signalSensor)?.id??data.sensors[0].id)}`}>정상 기간 학습·진단 상세</Link></div><SensorSignalPreview key={signalSensor||data.sensors[0].id} sensor={data.sensors.find(s=>s.id===signalSensor)??data.sensors[0]}/></>}
            <div className="lower-grid"><section className="panel signal-panel"><PanelHeading eyebrow="ANOMALY RESULTS" title="최근 이상탐지 결과" trailing={<Link href="/recovery" className="text-link"><Icon name="download" size={15}/>기간 데이터 다운로드</Link>}/><div className="priority-list">{latestDiagnoses.length?latestDiagnoses.map(d=><button key={d.id} className={`priority-item ${d.severity}`} onClick={()=>setSensorId(d.sensorId)}><div><div className="priority-title"><strong>{d.equipmentName||d.sensorName}</strong><Badge severity={d.severity}/></div><p>{d.title}</p><div className="priority-meta"><span>{d.sensorName} · {d.position}</span><span>{time(d.timestamp)} · {d.model}</span></div></div><Icon name="chevron" size={16}/></button>):<Empty title="수신된 이상탐지 결과가 없습니다" message="실시간 파형은 Live Console에서 확인하세요."/>}</div><div className="priority-note"><Icon name="info" size={16}/><p>웹에서는 가벼운 요약 신호와 이상 탐지 결과를 함께 확인합니다. 정밀 파형은 Live Console에서 확인하세요.</p></div><Link href="/recovery" className="button secondary full"><Icon name="download" size={16}/>서버 저장 데이터 내보내기</Link></section>
              <section className="panel network-panel"><PanelHeading eyebrow="DAQ NETWORK" title="연결 현황" trailing={<Icon name="chip" size={19}/>}/><div className="network-visual"><div className="network-core"><Icon name="pulse" size={25}/><span>SERVER</span></div><div className="network-nodes">{data.daqs.slice(0, 6).map(d => <button key={d.uuid} className={`network-node ${d.online ? "online" : ""}`} title={`${d.label} · ${d.online ? "최근 응답" : "응답 없음"}`} onClick={() => setForm({ kind: "bind", item: d })}><Icon name="chip" size={18}/><span>{d.label.split("-").at(-1)}</span></button>)}</div></div><div className="network-stat"><span>장비 미등록 DAQ</span><strong>{data.daqs.filter(d => !d.equipmentId).length}<small>개</small></strong></div><p className="muted network-description">보드 UUID로 식별하고 장비에 연결합니다.</p><Link href="/daqs" className="text-link">DAQ 관리로 이동<Icon name="arrow" size={16}/></Link></section></div></>}
          {view === "equipment" && <EquipmentWorkspace data={data} onRegister={setForm} onDelete={deleteSensor}/>}
          {view === "daqs" && <><p className="ops-note">DAQ 탐색으로 장치를 찾고 장비에 연결하세요. 수집 제어는 보드에 직접 적용되며, 모든 사용자에게 영향을 줍니다.</p><div className="section-toolbar"><div className="filter-tabs">{[["all","전체"],["unassigned","장비 미등록"],["online","최근 응답"],["offline","응답 없음"]].map(([v,l]) => <button key={v} className={filter === v ? "active" : ""} onClick={() => setFilter(v)}>{l}</button>)}</div><Search value={query} onChange={setQuery} placeholder="UUID · DAQ · IP 검색"/></div><div className="daq-grid">{daqs.map(d => <section key={d.uuid} className="panel daq-card"><div className="daq-card-top"><div className="device-icon"><Icon name="chip" size={24}/></div><span className={`connection ${d.online ? "" : "offline"}`}><i/>{d.online ? "최근 응답" : "응답 없음"}</span></div><h3>{d.label}</h3><div className="daq-uuid"><span>BOARD UUID</span><code>{d.uuid}</code></div><dl className="daq-facts"><div><dt>접속 주소</dt><dd className="mono">{d.ip}:{d.port}</dd></div><div><dt>연결 장비</dt><dd>{d.equipmentName || <span className="unassigned">미등록</span>}</dd></div><div><dt>등록 센서</dt><dd>{d.sensorCount}개</dd></div><div><dt>마지막 응답</dt><dd>{time(d.lastSeen)}</dd></div></dl><DaqControl daq={d} sensors={data.sensors.filter(s=>s.daqUuid===d.uuid)} onRefresh={refresh}/><div className="daq-actions"><button className={`button ${d.equipmentId ? "secondary" : "primary"}`} onClick={() => setForm({ kind: "bind", item: d })}><Icon name="link" size={16}/>{d.equipmentId ? "연결 정보" : "장비 연결"}</button><button className="button secondary" onClick={() => setForm({ kind: "sensor", daqUuid: d.uuid })}><Icon name="plus" size={16}/>센서 등록</button></div></section>)}</div>{!daqs.length && <section className="panel"><Empty title={query || filter !== "all" ? "검색 결과가 없습니다" : "발견된 DAQ가 없습니다"} message="보드 전원과 같은 네트워크 연결을 확인한 뒤 DAQ 탐색을 실행하세요."/></section>}</>}
          {view === "maintenance" && <><section className="panel diagnosis-panel"><PanelHeading eyebrow="DIAGNOSTIC INBOX" title="진단 · 점검 제안" trailing={<span className="muted">위험도 순</span>}/>{diagnosticInbox.length ? <div className="diagnosis-list">{diagnosticInbox.map(d => { const task = data.tasks.find(t => t.diagnosisId === d.id && t.status !== "completed"); return <div className="diagnosis-row" key={d.id}><div className={`diagnosis-icon ${d.severity}`}><Icon name={d.severity==="warning"||d.severity==="critical"?"warning":"pulse"} size={21}/></div><div className="diagnosis-copy"><div><strong>{d.title}</strong><Badge severity={d.severity}/>{d.acknowledgedAt && <span className="ack-tag"><Icon name="check" size={13}/>확인됨</span>}</div><p>{d.equipmentName || "장비 미등록"} · {d.sensorName} · {d.source === "demo" ? "모의 진단" : "엣지 진단"}</p></div><div className="diagnosis-rul"><span>예상 수명</span><strong>{formatLifetime(d)}</strong></div><div className="diagnosis-actions"><button className="button small secondary" onClick={() => setSensorId(d.sensorId)}>상세</button>{!d.acknowledgedAt && <button className="button small secondary" disabled={actionBusy === d.id} onClick={() => void acknowledge(d)}>확인</button>}<button className="button small primary" disabled={!!task || !d.equipmentId} onClick={() => setForm({ kind: "task", equipmentId: d.equipmentId!, diagnosisId: d.id, title: `${d.equipmentName} · ${d.title} 점검`, priority: d.severity === "critical" ? "critical" : d.severity === "warning" ? "high" : "normal" })}>{task ? "작업 등록됨" : "정비 작업 생성"}</button></div></div>; })}</div> : <Empty title="새로운 점검 제안이 없습니다"/>}</section><section className="panel task-panel"><PanelHeading eyebrow="WORK ORDERS" title="정비 작업" trailing={<span className="muted">총 {data.tasks.length}건</span>}/><div className="panel-tools"><div className="filter-tabs">{[["all","전체"],["pending","대기"],["in_progress","진행 중"],["completed","완료"]].map(([v,l]) => <button key={v} className={filter === v ? "active" : ""} onClick={() => setFilter(v)}>{l}</button>)}</div><Search value={query} onChange={setQuery} placeholder="작업 · 장비 · 담당자 검색"/></div><div className="table-scroll"><table className="task-table"><thead><tr><th>정비 작업 / 장비</th><th>우선순위</th><th>담당자</th><th>마감일</th><th>상태</th><th>작업</th></tr></thead><tbody>{tasks.map(t => <tr key={t.id}><td><button className="table-name" onClick={() => setForm({ kind: "task", item: t })}>{t.title}</button><small>{t.equipmentName}</small></td><td><span className={`priority-badge ${t.priority}`}>{priorities[t.priority]}</span></td><td>{t.assignee || <span className="muted">미배정</span>}</td><td className="mono">{t.dueDate || "—"}</td><td><span className={`task-status ${t.status}`}>{taskStatuses[t.status]}</span></td><td><button className="button small secondary" onClick={() => void updateTask(t)} disabled={actionBusy === t.id}>{actionBusy === t.id ? "처리 중…" : t.status === "pending" ? "작업 시작" : t.status === "in_progress" ? "완료 처리" : "다시 열기"}<Icon name={t.status === "in_progress" ? "check" : "arrow"} size={14}/></button></td></tr>)}</tbody></table></div>{!tasks.length && <Empty title="표시할 정비 작업이 없습니다" message="진단 결과에서 작업을 생성하거나 직접 등록할 수 있습니다."/>}</section></>}
          <footer className="page-footer"><span>FIELDLINK <span>·</span> OPERATIONS CONSOLE</span><span>이벤트 즉시 갱신 · 연결 중 5초 안전 조회 · KST</span></footer>
        </>}
      </main>
    </div>
    {data && form && <RegistrationForm state={form} snapshot={data} onClose={() => setForm(null)} onSubmit={submit}/>}
    {toastMessage && <div className={`toast ${toastMessage.error ? "toast-error" : ""}`} role={toastMessage.error ? "alert" : "status"}><Icon name={toastMessage.error ? "warning" : "check"} size={20}/><span>{toastMessage.text}</span><button aria-label="알림 닫기" onClick={() => setToastMessage(null)}><Icon name="x" size={16}/></button></div>}
  </div>;
}
function Metric({ label, value, unit, icon, detail, color = "slate" }: { label: string; value: number; unit: string; icon: string; detail: string; color?: string }) {
  return <article className={`metric metric-${color}`}><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon name={icon} size={18}/></span></div><div className="metric-value"><strong>{value.toString().padStart(2, "0")}</strong><span>{unit}</span></div><p>{detail}</p></article>;
}
function PanelHeading({ eyebrow, title, trailing }: { eyebrow: string; title: string; trailing?: React.ReactNode }) {
  return <div className="panel-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{trailing}</div>;
}
function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <label className="search-box"><Icon name="search" size={16}/><input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}/>{value && <button type="button" aria-label="검색 초기화" onClick={() => onChange("")}><Icon name="x" size={14}/></button>}</label>;
}
function EquipmentTable({ items, onSelect }: { items: EquipmentView[]; onSelect: (id: string) => void }) {
  return <><div className="table-scroll"><table className="equipment-table"><thead><tr><th>장비 / 설치 위치</th><th>진단 상태</th><th>DAQ · 센서</th><th>잔여수명</th><th><span className="sr-only">상세</span></th></tr></thead><tbody>{items.map(e => <tr key={e.id}><td><div className="equipment-cell"><div className={`equipment-icon ${e.severity}`}><Icon name={e.category === "냉각장치" ? "thermometer" : e.category === "펌프" ? "wave" : e.category === "차량" ? "equipment" : "bolt"} size={21}/></div><div><button className="table-name" onClick={() => onSelect(e.id)}>{e.name}</button><small><Icon name="pin" size={11}/>{e.location}</small></div></div></td><td><Badge severity={e.severity}/>{!e.online && <small className="offline-label">DAQ 응답 없음</small>}</td><td><span className="daq-count"><span className={`dot ${e.online ? "teal" : "gray"}`}/>{e.daqCount} DAQ</span><small>{e.sensorCount}개 센서</small></td><td><strong className={`rul ${e.severity}`}>{formatEquipmentLifetime(e)}</strong></td><td><button className="icon-button" onClick={() => onSelect(e.id)} aria-label={`${e.name} 상세 보기`}><Icon name="chevron" size={17}/></button></td></tr>)}</tbody></table></div>{!items.length && <Empty title="표시할 장비가 없습니다" message="검색 조건을 변경하거나 새 장비를 등록해 주세요."/>}</>;
}
