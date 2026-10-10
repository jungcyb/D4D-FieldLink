"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import type { SensorView, Reading } from "@/lib/types";
import { api } from "@/lib/client-api";
import Icon from "./icons";
import Dialog from "./dialog";
import LineChart from "./charts";
const time = (value: string) => new Date(value).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
export default function SensorDetail({ sensor, onClose, onEdit, onRefresh, toast }: { sensor: SensorView; onClose: () => void; onEdit: () => void; onRefresh: () => Promise<void>; toast: (message: string, error?: boolean) => void }) {
  const [readings, setReadings] = useState<Reading[]>([]); const [tab, setTab] = useState<"trend" | "raw">("trend"); const [error, setError] = useState(""); const [uploading, setUploading] = useState(false); const [limit, setLimit] = useState(60);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true; let inFlight = false; const controller = new AbortController();
    async function load() { if (inFlight) return; inFlight = true; try { const rows = await api<Reading[]>(`/sensors/${sensor.id}/telemetry?limit=${limit}`, { signal: controller.signal }); if (alive) { setReadings(rows); setError(""); } } catch (error) { if (alive) setError(error instanceof Error ? error.message : "데이터 조회 실패"); } finally { inFlight = false; } }
    void load(); const interval = setInterval(load, 5000);
    return () => { alive = false; controller.abort(); clearInterval(interval); };
  }, [sensor.id, limit]);
  const upload = useCallback(async (photo: File) => {
    if (photo.size > 5 * 1024 * 1024) { toast("사진은 5MB 이하여야 합니다.", true); return; }
    setUploading(true);
    try { const form = new FormData(); form.set("photo", photo); await api(`/sensors/${sensor.id}/photo`, { method: "POST", body: form }); await onRefresh(); toast("부착 위치 사진을 저장했습니다."); }
    catch (error) { toast(error instanceof Error ? error.message : "사진 업로드 실패", true); }
    finally { setUploading(false); if (file.current) file.current.value = ""; }
  }, [sensor.id, onRefresh, toast]);
  const last = readings.at(-1); const diagnosis = sensor.diagnosis;
  function download() {
    if (!readings.length) return;
    const csv = "timestamp,value,unit,sps,raw_samples\n" + readings.map(r => `${r.timestamp},${r.value},"${sensor.unit.replaceAll('"', '""')}",${r.sps},"${r.raw.join(";")}"`).join("\n");
    const href = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = href; link.download = `sensor-${sensor.id}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  return <Dialog title={sensor.name} subtitle={`${sensor.equipmentName || "장비 미등록"} / ${sensor.daqLabel} / ${sensor.channel}`} onClose={onClose} wide busy={uploading}>
    <div className="sensor-meta"><span><Icon name="pin" size={16}/>{sensor.position}</span><span className="mono">{sensor.sps.toLocaleString()} SPS</span><span className={`connection ${sensor.online ? "" : "offline"}`}><i/>{sensor.online ? "DAQ 최근 응답" : "DAQ 응답 없음"}</span></div>
    <div className="sensor-value"><strong>{last?.value.toFixed(2) ?? "—"}</strong><span>{sensor.unit}</span><small>{last ? `${time(last.timestamp)} 수집 · ${last.source === "demo" ? "모의 데이터" : "보드 수신"}` : "데이터 수신 대기"}</small></div>
    <div className="chart-toolbar"><div className="segmented"><button onClick={() => setTab("trend")} className={tab === "trend" ? "active" : ""}>대표값 추이</button><button onClick={() => setTab("raw")} className={tab === "raw" ? "active" : ""}>Raw Data</button></div><div className="toolbar-actions"><select aria-label="조회 배치 수" value={limit} onChange={e => setLimit(Number(e.target.value))}><option value={60}>최근 60배치</option><option value={120}>최근 120배치</option><option value={720}>최근 720배치</option></select><button className="button small secondary" onClick={download} disabled={!readings.length}><Icon name="download" size={15}/>CSV</button></div></div>
    {error ? <p className="form-error" role="alert">{error}</p> : <LineChart values={tab === "raw" ? last?.raw || [] : readings.map(r => r.value)} labels={tab === "raw" ? last?.raw.map((_, i) => `${(i / last.sps * 1000).toFixed(1)} ms`) || [] : readings.map(r => time(r.timestamp))} unit={sensor.unit} height={220}/>}
    <p className="chart-caption">{tab === "raw" ? `최근 배치의 ${last?.raw.length || 0}개 샘플 · 시간 간격 1/SPS · 연속 전체 신호가 아닌 수신 배치` : "보드가 전달한 대표값의 시간별 추이 · SPS는 Raw Data의 샘플링 속도입니다."}</p>
    <div className="detail-columns"><section className="detail-section"><h3><Icon name="pulse" size={17}/>진단 결과</h3>{diagnosis ? <><div className={`diagnosis-title ${diagnosis.severity}`}>{diagnosis.title}<span>{diagnosis.source === "demo" ? "모의 진단" : "엣지 AI"}</span></div><p>{diagnosis.description}</p><dl className="diagnosis-numbers"><div><dt>잔여수명 (RUL)</dt><dd>{diagnosis.rulHours == null ? "추정 없음" : `${diagnosis.rulHours.toLocaleString()} h`}</dd></div><div><dt>신뢰도</dt><dd>{diagnosis.confidence == null ? "—" : `${(diagnosis.confidence * 100).toFixed(0)}%`}</dd></div></dl><small className="muted">{diagnosis.model} · {time(diagnosis.timestamp)}</small></> : <div className="empty compact">아직 수신된 진단 결과가 없습니다.</div>}</section>
      <section className="detail-section"><h3><Icon name="camera" size={17}/>센서 부착 위치</h3>{sensor.photo ? <div className="sensor-photo">{/* eslint-disable-next-line @next/next/no-img-element */}<img src={`/api/photos/${sensor.photo}`} alt={`${sensor.name} 부착 위치: ${sensor.position}`}/></div> : <div className="photo-placeholder"><Icon name="camera" size={26}/><p>부착 위치 사진을 등록해 주세요</p></div>}<input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="부착 위치 사진 선택" onChange={e => { const photo = e.target.files?.[0]; if (photo) void upload(photo); }}/><button className="button secondary small full" onClick={() => file.current?.click()} disabled={uploading}><Icon name="upload" size={16}/>{uploading ? "업로드 중…" : sensor.photo ? "사진 변경" : "사진 업로드"}</button></section></div>
    <div className="modal-actions"><button className="button secondary" onClick={onEdit} disabled={uploading}>센서 정보 수정</button><button className="button primary" onClick={onClose} disabled={uploading}>닫기</button></div>
  </Dialog>;
}
