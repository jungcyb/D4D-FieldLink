"use client";
import { useEffect, useState, useCallback } from "react";
import type { DaqView } from "@/lib/types";
import type { AcquisitionStatus, AcquisitionCommand } from "@/lib/server/daq-control";
import { api, send } from "@/lib/client-api";
import Dialog from "./dialog";
export default function DaqControl({daq, onRefresh}: {daq: DaqView; onRefresh: () => Promise<void>}) {
  const [status, setStatus] = useState<AcquisitionStatus | null>(null), [rate, setRate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<AcquisitionCommand | null>(null);
  const read = useCallback(async (signal?: AbortSignal) => {
    const next = await api<AcquisitionStatus>(`/daqs/${daq.uuid}/acquisition`, {signal});
    setStatus(next); setError("");
  }, [daq.uuid]);
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController(); let inFlight = false;
    const load = async () => {if (inFlight || document.hidden) return; inFlight = true; try {await read(controller.signal);} catch (error) {if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "수집 상태 조회 실패");} finally {inFlight = false;}};
    void load(); const timer = setInterval(load, 5000);
    document.addEventListener("visibilitychange", load);
    return () => {controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load);};
  }, [read, busy]);
  async function execute() {
    if (!confirm) return; setBusy(true); setError(""); setMessage("");
    try {const next = await send<AcquisitionStatus>(`/daqs/${daq.uuid}/acquisition`, confirm); setStatus(next); setRate(null); setConfirm(null); setMessage("보드 응답 확인 · 설정이 적용됐습니다."); await onRefresh();}
    catch (error) {setError(error instanceof Error ? error.message : "명령 실패"); setConfirm(null);}
    finally {setBusy(false);}
  }
  const requestedRate = rate === null ? status?.scan_rate_hz : Number(rate);
  const validRate = requestedRate !== undefined && Number.isInteger(requestedRate) && requestedRate >= 10 && requestedRate <= 2000;
  return <div className="daq-control"><div className="acquisition-state"><strong>데이터 수집</strong><span className={`badge ${error ? "warning" : status?.acquiring ? "normal" : "unknown"}`}>{error ? "상태 확인 불가" : status ? status.acquiring ? "수집 중" : "수집 정지" : "상태 확인 중"}</span></div>
    <p className="muted">보드 상태 5초마다 확인 · 8채널 공통 설정</p>
    <form onSubmit={e => {e.preventDefault(); if (validRate) setConfirm({action:"rate", rate:requestedRate!});}}>
      <label>샘플레이트 / 채널 (SPS)<div className="rate-input"><input aria-label={`${daq.label} 샘플레이트`} type="number" min={10} max={2000} step={1} required value={rate ?? status?.scan_rate_hz ?? ""} onChange={e => setRate(e.target.value)} disabled={busy || !status || !!error}/><button className="button secondary small" disabled={busy || !status || !!error || !validRate || requestedRate === status.scan_rate_hz}>적용</button></div></label>
      <small>10–2,000 SPS / 채널 · 현재 전체 {status ? (status.scan_rate_hz * 8).toLocaleString() : "—"} samples/s</small>
    </form><div className="acquisition-actions"><button className="button primary" disabled={busy || !!error || !status || status.acquiring} onClick={() => setConfirm({action:"start"})}>수집 시작</button><button className="button danger" disabled={busy || !!error || !status?.acquiring} onClick={() => setConfirm({action:"stop"})}>수집 정지</button></div>
    <p className="ops-note">수집 정지는 보드의 ADC 수집과 새 데이터 저장을 중단합니다. 그래프의 화면 일시 정지와 다릅니다. 기존 기록은 유지됩니다.</p>
    {message && <p role="status" className="control-success">{message}</p>}{error && <p className="form-error" role="alert">{error}</p>}
    {confirm && <Dialog title={confirm.action === "stop" ? "보드 데이터 수집을 정지할까요?" : confirm.action === "start" ? "보드 데이터 수집을 시작할까요?" : "샘플레이트를 변경할까요?"} subtitle={daq.label} onClose={() => setConfirm(null)} busy={busy}>
      <p>{confirm.action === "stop" ? "모든 8채널의 새 샘플 수집과 로컬 저장이 멈춥니다. 다시 시작하기 전까지 데이터에 공백이 생깁니다. 다른 사용자의 실시간 화면에도 영향을 줍니다." : confirm.action === "rate" ? `채널당 ${status?.scan_rate_hz} → ${confirm.rate} SPS로 변경합니다. 모든 8채널에 적용되며, 수집 중이면 다음 배치부터 새 설정이 반영됩니다.` : "현재 샘플레이트로 8채널 수집과 로컬 저장을 시작합니다."}</p>
      <div className="ops-form-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>취소</button><button className={`button ${confirm.action === "stop" ? "danger" : "primary"}`} disabled={busy} onClick={() => void execute()}>{busy ? "보드 응답 대기…" : "확인 · 보드에 적용"}</button></div>
    </Dialog>}
  </div>;
}
