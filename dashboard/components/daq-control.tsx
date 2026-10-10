"use client";
import { useEffect, useState, useCallback } from "react";
import type { DaqView, SampleRateGroup } from "@/lib/types";
import type { AcquisitionStatus, AcquisitionCommand } from "@/lib/server/daq-control";
import { api, send } from "@/lib/client-api";
import Dialog from "./dialog";

export default function DaqControl({daq, onRefresh}: {daq: DaqView; onRefresh: () => Promise<void>}) {
  const [status, setStatus] = useState<AcquisitionStatus | null>(null), [drafts, setDrafts] = useState<Record<string, string>>({});
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
    try {const next = await send<AcquisitionStatus>(`/daqs/${daq.uuid}/acquisition`, confirm); setStatus(next); setDrafts({}); setConfirm(null); setMessage("보드 응답 확인 · 설정이 적용됐습니다."); await onRefresh();}
    catch (error) {setError(error instanceof Error ? error.message : "명령 실패"); setConfirm(null);}
    finally {setBusy(false);}
  }
  const groups = status?.channel_capabilities?.sampleRateGroups || daq.sampleRateGroups || [];
  const channelCount = status?.channel_capabilities?.channelCount || daq.channelCount || 8;
  const totalRate = groups.reduce((total, group) => total + group.currentHz * group.channelIds.length, 0);
  const groupFor = (command: AcquisitionCommand | null): SampleRateGroup | undefined => command?.action === "rate" ? groups.find(group => group.id === command.groupId) : undefined;
  return <div className="daq-control"><div className="acquisition-state"><strong>데이터 수집</strong><span className={`badge ${error ? "warning" : status?.acquiring ? "normal" : "unknown"}`}>{error ? "상태 확인 불가" : status ? status.acquiring ? "수집 중" : "수집 정지" : "상태 확인 중"}</span></div>
    <p className="muted">보드 상태 5초마다 확인 · 보유 {channelCount}채널 · 현재 총 {totalRate ? totalRate.toLocaleString() : "—"} samples/s</p>
    <div className="rate-groups">{groups.map(group => {
      const value = drafts[group.id] ?? String(group.currentHz), rate = Number(value);
      const valid = Number.isFinite(rate) && rate >= (group.minHz || rate) && rate <= (group.maxHz || rate) && (group.stepHz == null || Number.isInteger((rate - (group.minHz || 0)) / group.stepHz));
      return <form key={group.id} onSubmit={event => {event.preventDefault(); if (group.writable && valid) setConfirm({action:"rate", groupId:group.id, rate});}}>
        <label>{group.label}<div className="rate-input"><input aria-label={`${daq.label} ${group.label} 샘플레이트`} type="number" min={group.minHz} max={group.maxHz} step={group.stepHz || "any"} readOnly={!group.writable} value={value} onChange={event => setDrafts({...drafts,[group.id]:event.target.value})} disabled={busy || !status || !!error}/>{group.writable && <button className="button secondary small" disabled={busy || !status || !!error || !valid || rate === group.currentHz}>적용</button>}</div></label>
        <small>{group.channelIds.join(", ")} · {group.writable ? `${group.minHz?.toLocaleString()}–${group.maxHz?.toLocaleString()} SPS` : "고정 샘플레이트"}</small>
      </form>;
    })}</div>
    {!groups.length && <p className="ops-note">채널 capability를 수신하지 못해 샘플레이트 그룹을 표시할 수 없습니다. DAQ 탐색을 다시 실행하세요.</p>}
    <div className="acquisition-actions"><button className="button primary" disabled={busy || !!error || !status || status.acquiring} onClick={() => setConfirm({action:"start"})}>수집 시작</button><button className="button danger" disabled={busy || !!error || !status?.acquiring} onClick={() => setConfirm({action:"stop"})}>수집 정지</button></div>
    <p className="ops-note">수집 정지는 보드의 ADC 수집과 새 데이터 저장을 중단합니다. 그래프의 화면 일시 정지와 다릅니다. 기존 기록은 유지됩니다.</p>
    {message && <p role="status" className="control-success">{message}</p>}{error && <p className="form-error" role="alert">{error}</p>}
    {confirm && <Dialog title={confirm.action === "stop" ? "보드 데이터 수집을 정지할까요?" : confirm.action === "start" ? "보드 데이터 수집을 시작할까요?" : "샘플레이트를 변경할까요?"} subtitle={daq.label} onClose={() => setConfirm(null)} busy={busy}>
      <p>{confirm.action === "stop" ? `모든 ${channelCount}채널의 새 샘플 수집과 로컬 저장이 멈춥니다. 다시 시작하기 전까지 데이터에 공백이 생깁니다.` : confirm.action === "rate" ? `${groupFor(confirm)?.label}: ${groupFor(confirm)?.currentHz} → ${confirm.rate} SPS로 변경합니다. 같은 그룹의 ${groupFor(confirm)?.channelIds.join(", ")}에 함께 적용됩니다.` : `현재 설정으로 ${channelCount}채널 수집과 로컬 저장을 시작합니다.`}</p>
      <div className="ops-form-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>취소</button><button className={`button ${confirm.action === "stop" ? "danger" : "primary"}`} disabled={busy} onClick={() => void execute()}>{busy ? "보드 응답 대기…" : "확인 · 보드에 적용"}</button></div>
    </Dialog>}
  </div>;
}
