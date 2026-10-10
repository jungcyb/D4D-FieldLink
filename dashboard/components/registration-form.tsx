"use client";
import { useState } from "react";
import type { EquipmentView, SensorView, DaqView, Snapshot, TaskView } from "@/lib/types";
import Dialog from "./dialog";
import Icon from "./icons";
export type FormState = { kind: "equipment"; item?: EquipmentView } | { kind: "sensor"; item?: SensorView; daqUuid?: string } | { kind: "bind"; item: DaqView } | { kind: "task"; item?: TaskView; equipmentId?: string; diagnosisId?: string; title?: string; priority?: string };
export default function RegistrationForm({ state, snapshot, onClose, onSubmit }: { state: FormState; snapshot: Snapshot; onClose: () => void; onSubmit: (data: Record<string, unknown>, photo: File | null) => Promise<void> }) {
  const initialDaqUuid = state.kind === "sensor" ? state.item?.daqUuid || state.daqUuid || snapshot.daqs[0]?.uuid || "" : "";
  const initialDaq = snapshot.daqs.find(daq => daq.uuid === initialDaqUuid);
  const usedChannels = new Set(snapshot.sensors.filter(sensor => sensor.daqUuid === initialDaqUuid && sensor.id !== (state.kind === "sensor" ? state.item?.id : undefined)).map(sensor => sensor.channel));
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [type, setType] = useState(state.kind === "sensor" ? state.item?.type || "vibration" : "vibration");
  const [daqUuid, setDaqUuid] = useState(initialDaqUuid);
  const [channel, setChannel] = useState(state.kind === "sensor" ? state.item?.channel || initialDaq?.channels?.find(item => !usedChannels.has(item.id))?.id || "" : "");
  const selectedDaq = snapshot.daqs.find(daq => daq.uuid === daqUuid), selectedChannel = selectedDaq?.channels?.find(item => item.id === channel);
  const label = state.kind === "equipment" ? state.item ? "장비 정보 수정" : "새 장비 등록" : state.kind === "sensor" ? state.item ? "센서 정보 수정" : "새 센서 등록" : state.kind === "bind" ? "DAQ 장비 연결" : state.item ? "정비 작업 수정" : "정비 작업 등록";
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget); const data: Record<string, unknown> = Object.fromEntries(form.entries());
    const photo = form.get("photo"); delete data.photo;
    if (state.kind === "sensor") data.sps = Number(data.sps);
    if (state.kind === "task" && state.diagnosisId) data.diagnosisId = state.diagnosisId;
    try { await onSubmit(data, photo instanceof File && photo.size > 0 ? photo : null); }
    catch (error) { setError(error instanceof Error ? error.message : "저장에 실패했습니다."); }
    finally { setBusy(false); }
  }
  return <Dialog title={label} subtitle={state.kind === "bind" ? "보드에서 수신한 UUID를 기준으로 장비를 연결합니다." : "등록한 정보는 서버에 저장됩니다."} onClose={onClose} busy={busy}>
    <form onSubmit={submit} className="registration-form">
      {state.kind === "equipment" && <>
        <label>장비명<input name="name" defaultValue={state.item?.name} placeholder="예: 비상 발전기 G-05" maxLength={120} required/></label>
        <div className="form-grid"><label>장비 종류<select name="category" defaultValue={state.item?.category || "발전기"}>{["발전기", "차량", "펌프", "냉각장치", "기타"].map(v => <option key={v}>{v}</option>)}</select></label><label>설치 위치<input name="location" defaultValue={state.item?.location} placeholder="예: A동 · 발전실" maxLength={120} required/></label></div>
        <label>장비 설명<textarea name="description" defaultValue={state.item?.description} placeholder="장비 정보와 정비 참고사항" maxLength={1000} rows={3}/></label>
      </>}
      {state.kind === "bind" && <>
        <div className="uuid-box"><span>BOARD UUID</span><code>{state.item.uuid}</code><small>{state.item.ip}:{state.item.port}</small></div>
        <label>DAQ 이름<input name="label" defaultValue={state.item.label} maxLength={120} required/></label>
        <label>연결할 장비<select name="equipmentId" defaultValue={state.item.equipmentId || ""}><option value="">미등록 · 연결하지 않음</option>{snapshot.equipment.map(e => <option key={e.id} value={e.id}>{e.name} — {e.location}</option>)}</select></label>
        {state.item.equipmentId && state.item.sensorCount > 0 && <p className="form-note"><Icon name="info" size={16}/>데이터 이력이 있는 DAQ는 기존 장비 연결을 유지합니다.</p>}
      </>}
      {state.kind === "sensor" && <>
        <label>연결 DAQ<select name="daqUuid" value={daqUuid} onChange={event => { const next = event.target.value, daq = snapshot.daqs.find(item => item.uuid === next), used = new Set(snapshot.sensors.filter(sensor => sensor.daqUuid === next).map(sensor => sensor.channel)); setDaqUuid(next); setChannel(daq?.channels?.find(item => !used.has(item.id))?.id || ""); }} disabled={!!state.item} required>{snapshot.daqs.map(d => <option key={d.uuid} value={d.uuid}>{d.label} · {d.equipmentName || "장비 미등록"}</option>)}</select></label>
        {state.item && <input type="hidden" name="daqUuid" value={state.item.daqUuid}/>}
        <label>센서명<input name="name" defaultValue={state.item?.name} placeholder="예: 구동축 베어링 진동" maxLength={120} required/></label>
        <div className="form-grid"><label>센서 종류<select name="type" value={type} onChange={e => setType(e.target.value as typeof type)}><option value="vibration">진동 (IMU)</option><option value="temperature">온도</option><option value="current">전류</option><option value="analog">범용 아날로그</option></select></label><label>DAQ 입력 채널{selectedDaq?.channels?.length ? <select name="channel" value={channel} onChange={event => setChannel(event.target.value)} required><option value="" disabled>채널 선택</option>{selectedDaq.channels.filter(item => item.id === state.item?.channel || !snapshot.sensors.some(sensor => sensor.daqUuid === daqUuid && sensor.channel === item.id)).map(item => <option key={item.id} value={item.id}>{item.label} · {item.sampleRateHz.toLocaleString()} SPS{item.streamAvailable ? "" : " · 수집 연동 대기"}</option>)}</select> : <input name="channel" value={channel} onChange={event => setChannel(event.target.value)} placeholder="예: CH0" maxLength={40} required/>}</label></div>
        <label>부착 위치<input name="position" defaultValue={state.item?.position} placeholder="예: 모터 하우징 측면" maxLength={120} required/></label>
        <div className="form-grid"><label>현재 채널 샘플레이트<input readOnly name="sps" type="number" min="0.01" max="1000000" step="any" value={selectedChannel?.sampleRateHz || state.item?.sps || 1000}/><small>{selectedChannel ? `${selectedChannel.adc} ${selectedChannel.adcChannel} · ${selectedChannel.rateGroupId}` : "실제 샘플레이트는 DAQ 관리에서 설정합니다."}</small></label><label>측정 단위<input key={type} name="unit" defaultValue={state.item?.type === type ? state.item.unit : type === "vibration" ? "mm/s" : type === "temperature" ? "°C" : type === "current" ? "A" : "V"} maxLength={20} required/></label></div>
        <input type="hidden" name="inputUnit" value={selectedChannel?.inputUnit || state.item?.calibration.inputUnit || "V"}/>
        {selectedChannel && !selectedChannel.streamAvailable && <p className="form-note"><Icon name="info" size={16}/>이 채널은 보드가 보유하고 있지만 서버 스트림 연동 확인 전입니다. 매핑은 저장할 수 있으며 데이터는 연동 후 표시됩니다.</p>}
        <label>부착 위치 사진 <span className="optional">선택 · PNG / JPEG / WebP · 최대 5MB</span><input name="photo" type="file" accept="image/png,image/jpeg,image/webp"/></label>
      </>}
      {state.kind === "task" && <>
        <label>대상 장비<select name="equipmentId" defaultValue={state.item?.equipmentId || state.equipmentId || snapshot.equipment[0]?.id} disabled={!!state.item} required>{snapshot.equipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        {state.item && <input type="hidden" name="equipmentId" value={state.item.equipmentId}/>}
        <label>작업명<input name="title" defaultValue={state.item?.title || state.title} placeholder="예: 베어링 점검 및 교체" maxLength={120} required/></label>
        <div className="form-grid"><label>우선순위<select name="priority" defaultValue={state.item?.priority || state.priority || "normal"}><option value="critical">긴급</option><option value="high">높음</option><option value="normal">일반</option></select></label><label>작업 상태<select name="status" defaultValue={state.item?.status || "pending"}><option value="pending">대기</option><option value="in_progress">진행 중</option><option value="completed">완료</option></select></label></div>
        <div className="form-grid"><label>담당자 / 정비팀<input name="assignee" defaultValue={state.item?.assignee} placeholder="예: 정비 1팀" maxLength={120}/></label><label>마감일<input name="dueDate" type="date" defaultValue={state.item?.dueDate || ""}/></label></div>
        <label>작업 메모<textarea name="notes" defaultValue={state.item?.notes} rows={3} maxLength={2000} placeholder="필요 부품, 점검 사항 등"/></label>
      </>}
      {error && <div className="form-error" role="alert"><Icon name="warning" size={16}/>{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>취소</button><button type="submit" className="button primary" disabled={busy}>{busy ? "저장 중…" : "저장하기"}<Icon name="check" size={17}/></button></div>
    </form>
  </Dialog>;
}
