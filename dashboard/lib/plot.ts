import type { SignalPoint } from "./signal.ts";
export type PlotRange = [number, number];
export function fitRange(start: number, end: number, count: number): PlotRange {
  const max = Math.max(1, count - 1), span = Math.min(max, Math.max(1, end - start));
  const left = Math.max(0, Math.min(start, max - span));
  return [left, left + span];
}
export function nearestPoint(points: SignalPoint[], index: number): SignalPoint | undefined {
  if (!points.length) return undefined;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].index < index) lo = mid + 1; else hi = mid; }
  return lo && index - points[lo - 1].index <= points[lo].index - index ? points[lo - 1] : points[lo];
}
export function valueDomain(points: SignalPoint[]): PlotRange {
  let min = Infinity, max = -Infinity;
  for (const p of points) { min = Math.min(min, p.value); max = Math.max(max, p.value); }
  if (!points.length) return [-1, 1];
  const padding = Math.max((max - min) * .12, Math.abs(max) * .00001, .00001);
  return [min - padding, max + padding];
}
export const formatValue = (value: number) => Number(value.toPrecision(7)).toString();
