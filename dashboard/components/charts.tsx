"use client";
import { memo, useId, useMemo, useState } from "react";
import { minMaxEnvelope } from "@/lib/signal";
function LineChart({ values, color = "#209982", height = 180, unit = "", labels = [], compact = false }: { values: number[]; color?: string; height?: number; unit?: string; labels?: string[]; compact?: boolean }) {
  const id = useId().replaceAll(":", ""); const [hover, setHover] = useState<number | null>(null);
  const plot = useMemo(() => {
    const envelope = minMaxEnvelope(values, 1200);
    const width = 760, left = compact ? 0 : 46, top = 14, bottom = height - (compact ? 4 : 30);
    const padding = Math.max((envelope.max - envelope.min) * .22, Math.abs(envelope.max) * .03, .05);
    const low = envelope.min - padding, high = envelope.max + padding;
    const x = (i: number) => left + i / Math.max(values.length - 1, 1) * (width - left - 12);
    const y = (v: number) => bottom - (v - low) / (high - low) * (bottom - top);
    const line = envelope.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.index).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");
    return { ...envelope, width, left, top, bottom, low, high, x, y, line, area: `${line} L${x(values.length-1)},${bottom} L${left},${bottom} Z` };
  }, [values, compact, height]);
  if (!values.length) return <div className="chart-empty" style={{height}}>아직 수신된 데이터가 없습니다</div>;
  return <div className="chart-wrap"><svg viewBox={`0 0 ${plot.width} ${height}`} role="img" aria-label={`센서 데이터 그래프: ${values.length}개, 최소 ${plot.min.toFixed(2)}, 최대 ${plot.max.toFixed(2)} ${unit}`} preserveAspectRatio="none" onPointerLeave={() => setHover(null)} onPointerMove={e => { const box = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(values.length-1, Math.round(((e.clientX-box.left)/box.width*plot.width-plot.left)/(plot.width-plot.left-12)*(values.length-1))))); }} style={{height}}>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".19"/><stop offset="100%" stopColor={color} stopOpacity=".015"/></linearGradient></defs>
    {!compact && [0,1,2,3].map(i => <g key={i}><line x1={plot.left} y1={plot.top+(plot.bottom-plot.top)*i/3} x2={plot.width-12} y2={plot.top+(plot.bottom-plot.top)*i/3} stroke="#e7eceb" strokeDasharray="3 5"/><text x={plot.left-9} y={plot.top+(plot.bottom-plot.top)*i/3+4} textAnchor="end" fill="#87908d" fontSize="11">{(plot.high-(plot.high-plot.low)*i/3).toFixed(1)}</text></g>)}
    <path d={plot.area} fill={`url(#${id})`}/><path d={plot.line} fill="none" stroke={color} strokeWidth={compact?2.5:2} vectorEffect="non-scaling-stroke"/>
    {!compact && labels.length > 0 && [0,Math.floor((labels.length-1)/2),labels.length-1].map((i,j) => <text key={j} x={plot.x(i)} y={height-7} textAnchor={j===0?"start":j===2?"end":"middle"} fill="#87908d" fontSize="11">{labels[i]}</text>)}
    {hover != null && hover < values.length && <g><line x1={plot.x(hover)} y1={plot.top} x2={plot.x(hover)} y2={plot.bottom} stroke={color} strokeDasharray="3 3" opacity=".5"/><circle cx={plot.x(hover)} cy={plot.y(values[hover])} r="4" fill={color} stroke="white" strokeWidth="2"/></g>}
  </svg>{hover != null && hover < values.length && <div className="chart-tooltip">{labels[hover] || `Sample ${hover}`} <strong>{values[hover].toFixed(3)} {unit}</strong></div>}</div>;
}
export default memo(LineChart);
