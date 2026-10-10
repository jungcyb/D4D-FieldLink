import { test } from "node:test";
import assert from "node:assert/strict";
import { minMaxEnvelope } from "../lib/signal.ts";
import { SampleRing } from "../public/workers/signal.mjs";
import { syntheticResponse } from "./helpers/benchmark.ts";
test("min/max preserves narrow positive and negative peaks in chronological order",()=>{
  const values=new Float32Array(100000);values[101]=37;values[9001]=-28;values[99999]=5;
  const plot=minMaxEnvelope(values,1200);assert.ok(plot.points.length<=1200);assert.equal(plot.min,-28);assert.equal(plot.max,37);
  assert.ok(plot.points.some(p=>p.index===101&&p.value===37));assert.ok(plot.points.some(p=>p.index===9001&&p.value===-28));
  assert.equal(plot.points.at(-1)?.index,99999);assert.ok(plot.points.every((p,i)=>i===0||p.index>=plot.points[i-1].index));
});
test("one million samples do not overflow the JS argument stack and remain bounded",()=>{
  const values=new Float32Array(1000000);values[999]=4;values[999998]=-6;const plot=minMaxEnvelope(values,600);
  assert.ok(plot.points.length<=600);assert.equal(plot.count,1000000);assert.equal(plot.max,4);assert.equal(plot.min,-6);
});
test("empty and single sample windows are valid",()=>{assert.equal(minMaxEnvelope([]).points.length,0);assert.deepEqual(minMaxEnvelope([3]).points,[{index:0,value:3}]);});
test("ring buffer bounds memory and returns chronological latest values",()=>{const ring=new SampleRing(3);[1,2,3,4,5].forEach(v=>ring.push(v));assert.equal(ring.values.length,3);assert.deepEqual(Array.from(ring.ordered()),[3,4,5]);});
test("synthetic binary and JSON output agree and oversized requests fail",async()=>{
  const binary=syntheticResponse(new URL("http://local/api/benchmark/raw?sps=1000&samples=100&channels=2"));assert.equal((await binary.arrayBuffer()).byteLength,800);
  const payload=await syntheticResponse(new URL("http://local/api/benchmark/raw?sps=1000&samples=100&channels=2&format=json")).json();assert.equal(payload.channels.length,2);assert.equal(payload.channels[0].length,100);assert.equal(payload.channels[0][0],7);
  assert.throws(()=>syntheticResponse(new URL("http://local/api/benchmark/raw?samples=1000000&channels=8")));
});
