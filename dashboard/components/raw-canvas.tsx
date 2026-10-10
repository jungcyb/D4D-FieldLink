"use client";
import {sampleTimeMs} from "@/lib/sampling";
import { useEffect, useRef, useState } from "react";
import type { Envelope } from "@/lib/signal";
import { fitRange, nearestPoint, valueDomain, formatValue, type PlotRange } from "@/lib/plot";
export interface RawWindow extends Envelope { sensorId: string; timestamp: string | null; sps: number }
const LEFT = 84, RIGHT = 22, TOP = 24, BOTTOM = 42;
export default function RawCanvas({window: signal, unit = "V", labels, onInspect, height = 380}: {
  window: RawWindow; unit?: string; labels?: string[]; onInspect?: () => void; height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null), panel = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<PlotRange | null>(null), [hover, setHover] = useState<number | null>(null);
  const [lockedY, setLockedY] = useState<PlotRange | null>(null), [error, setError] = useState("");
  const view = range ? fitRange(...range, signal.count) : [0, Math.max(1, signal.count - 1)] as PlotRange;
  const [start, end] = view, span = end - start;
  const point = hover === null ? undefined : nearestPoint(signal.points, hover);
  const positionLabel = (index: number) => labels ? labels[Math.round(index)] || "" : formatValue(sampleTimeMs(index,signal.sps)) + " ms";
  function zoom(factor: number) { onInspect?.(); const center = (start + end) / 2; setRange(fitRange(center - span * factor / 2, center + span * factor / 2, signal.count)); }
  function pan(direction: number) { onInspect?.(); setRange(fitRange(start + span * direction / 2, end + span * direction / 2, signal.count)); }
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    let frame = 0;
    function paint() {
      const ctx = canvas!.getContext("2d"); if (!ctx) return;
      const width = canvas!.clientWidth, h = canvas!.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
      canvas!.width = Math.round(width * dpr); canvas!.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const visible = signal.points.filter(p => p.index >= start && p.index <= end);
      const [low, high] = lockedY || valueDomain(visible);
      const x = (index: number) => LEFT + (index - start) / (end - start) * (width - LEFT - RIGHT);
      const y = (value: number) => h - BOTTOM - (value - low) / (high - low) * (h - TOP - BOTTOM);
      ctx.font = "11px Consolas, monospace"; ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i++) {
        const value = low + (high - low) * i / 5, yy = y(value);
        ctx.strokeStyle = "#293c50"; ctx.beginPath(); ctx.moveTo(LEFT, yy); ctx.lineTo(width - RIGHT, yy); ctx.stroke();
        ctx.fillStyle = "#b6c8d8"; ctx.textAlign = "right"; ctx.fillText(formatValue(value), LEFT - 10, yy + 4);
        const index = start + (end - start) * i / 5, xx = x(index);
        ctx.beginPath(); ctx.moveTo(xx, TOP); ctx.lineTo(xx, h - BOTTOM); ctx.stroke();
        ctx.textAlign = i === 0 ? "left" : i === 5 ? "right" : "center";
        ctx.fillText(labels ? labels[Math.round(index)] || "" : formatValue(sampleTimeMs(index,signal.sps)), xx, h - 17);
      }
      ctx.textAlign = "left"; ctx.fillText(unit, 10, 14);
      ctx.textAlign = "right"; ctx.fillText(labels ? "KST" : "ms", width - RIGHT, 14);
      ctx.save(); ctx.beginPath(); ctx.rect(LEFT, TOP, width - LEFT - RIGHT, h - TOP - BOTTOM); ctx.clip();
      ctx.strokeStyle = "#4de1cb"; ctx.lineWidth = 1.6; ctx.beginPath();
      signal.points.forEach((p, i) => { if (i === 0) ctx.moveTo(x(p.index), y(p.value)); else ctx.lineTo(x(p.index), y(p.value)); }); ctx.stroke();
      if (signal.points.length === 1) { ctx.beginPath(); ctx.arc(x(signal.points[0].index), y(signal.points[0].value), 3, 0, Math.PI * 2); ctx.fillStyle = "#4de1cb"; ctx.fill(); }
      if (point && point.index >= start && point.index <= end) {
        ctx.strokeStyle = "#e0edf5"; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x(point.index), TOP); ctx.lineTo(x(point.index), h - BOTTOM); ctx.moveTo(LEFT, y(point.value)); ctx.lineTo(width - RIGHT, y(point.value)); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = "white"; ctx.beginPath(); ctx.arc(x(point.index), y(point.value), 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    const draw = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint); };
    draw(); const resize = new ResizeObserver(draw); resize.observe(canvas);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); };
  }, [signal, start, end, lockedY, point, labels, unit, height]);
  return <div className="signal-instrument" ref={panel}>
    <div className="plot-controls" role="group" aria-label="그래프 보기 설정">
      <button onClick={() => zoom(.5)} disabled={span <= 1 || signal.count < 2} aria-label="시간축 확대">＋ 확대</button>
      <button onClick={() => zoom(2)} disabled={!range} aria-label="시간축 축소">− 축소</button>
      <button onClick={() => pan(-1)} disabled={start <= 0} aria-label="이전 구간">←</button>
      <button onClick={() => pan(1)} disabled={end >= signal.count - 1} aria-label="다음 구간">→</button>
      <button onClick={() => {setRange(null); setHover(null);}}>전체 구간</button>
      <label><input type="checkbox" checked={!lockedY} onChange={e => setLockedY(e.target.checked ? null : valueDomain(signal.points.filter(p=>p.index>=start&&p.index<=end)))}/>Y 자동 스케일</label>
      <button className="plot-expand" onClick={async () => {try { if (document.fullscreenElement) await document.exitFullscreen(); else await panel.current?.requestFullscreen(); } catch {setError("이 브라우저는 전체 화면을 지원하지 않습니다.");}}}>전체 화면</button>
    </div>
    <div className="plot-readout" aria-live="off">{point ? <><b>{labels ? "배치" : "샘플 인덱스"} #{point.index}</b><span>{positionLabel(point.index)}</span><strong>{formatValue(point.value)} {unit}</strong></> : <span>포인터를 올리거나 그래프에 초점을 맞추고 ← → 키로 값을 확인하세요.</span>}</div>
    <canvas ref={ref} className="raw-canvas" tabIndex={0} role="img" aria-label={`${labels ? "대표값 추이" : "Raw Data"}: ${signal.count}개, 최소 ${formatValue(signal.min)}, 최대 ${formatValue(signal.max)} ${unit}. 방향키로 샘플 조회, 더하기/빼기로 확대·축소.`} style={{height}}
      onPointerMove={e => {const box = e.currentTarget.getBoundingClientRect(); setHover(Math.max(start, Math.min(end, start + (e.clientX - box.left - LEFT) / (box.width - LEFT - RIGHT) * span)));}}
      onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)} onFocus={() => setHover(start)}
      onKeyDown={e => {if (e.key === "ArrowLeft" || e.key === "ArrowRight") {e.preventDefault(); const i = point ? signal.points.indexOf(point) : 0; const next = signal.points[Math.max(0, Math.min(signal.points.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))]; if (next) setHover(next.index);} else if (e.key === "+" || e.key === "=") {e.preventDefault(); zoom(.5);} else if (e.key === "-") {e.preventDefault(); zoom(2);}}}/>
    <div className="plot-status"><span>{range ? (Math.max(1, signal.count - 1) / span).toFixed(1) + "× · " : ""}인덱스 {Math.ceil(start)}–{Math.min(signal.count - 1, Math.floor(end))}</span><span>MIN {formatValue(signal.min)} · MAX {formatValue(signal.max)} · Δ {formatValue(signal.max - signal.min)} {unit}</span></div>
    {signal.max === signal.min && <p className="plot-note">이 배치의 모든 값이 동일합니다. 자동 스케일은 없는 변화를 만들지 않습니다.</p>}
    {signal.count > signal.points.length && <p className="plot-note">피크 보존 표시 · 호버는 표시된 실제 샘플의 인덱스·값입니다.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
