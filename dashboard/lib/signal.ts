import { packedEnvelope } from "../public/workers/signal.mjs";
export interface SignalPoint { index: number; value: number }
export interface Envelope { points: SignalPoint[]; count: number; min: number; max: number }
/** Ordered min/max envelope. Both extrema survive each bucket; not an averaged signal.
 * O(n) time, O(pixelWidth) output; no spread/Math.min(...largeArray) stack overflow. */
export function minMaxEnvelope(values: ArrayLike<number>, maxPoints = 1200): Envelope {
  const packed = packedEnvelope(values,maxPoints); const points:SignalPoint[]=[];
  for(let i=0;i<packed.xy.length;i+=2) points.push({index:packed.xy[i],value:packed.xy[i+1]});
  return {points,count:packed.count,min:packed.min,max:packed.max};
}
export function signalValue(index: number, sps: number, channel = 0): number {
  const t = index / sps;
  // Harmonic signal plus narrow impulses to check that decimation preserves peaks.
  return Math.sin(2 * Math.PI * 37 * t + channel * .3) * 2 + Math.sin(2 * Math.PI * 113 * t) * .7 + (index % 4093 === 0 ? 7 : 0);
}
