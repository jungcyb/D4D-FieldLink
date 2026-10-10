import {test} from "node:test";
import assert from "node:assert/strict";
import {selectRawWindow} from "../lib/raw-window.ts";
import type {Reading} from "../lib/types.ts";
const start=Date.parse("2026-10-10T10:00:00.000Z");
function batch(index:number,sps=1000,count=sps,offset=index*1000):Reading{return{id:String(index),sensorId:"sensor",timestamp:new Date(start+offset).toISOString(),sps,raw:Array.from({length:count},(_,i)=>index*10000+i),value:0,source:"external"};}
test("display duration combines contiguous batches rather than only changing the polling timer",()=>{
  const rows=[batch(0),batch(1),batch(2)];
  const one=selectRawWindow(rows,1),two=selectRawWindow(rows,2);
  assert.equal(one.raw.length,1000);assert.equal(two.raw.length,2000);assert.equal(two.batchCount,2);assert.equal(two.timestamp,rows[1].timestamp);assert.equal(two.raw[0],10000);assert.equal(two.raw.at(-1),20999);assert.equal(two.boundary,null);
});
test("2000 SPS uses 2000 received samples for one second, including split wire batches",()=>{
  const rows=[batch(0,2000,1000,0),batch(1,2000,1000,500)];
  const result=selectRawWindow(rows,1);assert.equal(result.raw.length,2000);assert.equal(result.sps,2000);assert.equal(result.batchCount,2);
});
test("rate changes, gaps and overlaps stop aggregation without inventing samples",()=>{
  assert.equal(selectRawWindow([batch(0),batch(1,2000)],2).boundary,"rate_change");
  const gap=selectRawWindow([batch(0),batch(2)],2);assert.equal(gap.boundary,"gap");assert.equal(gap.raw.length,1000);
  assert.equal(selectRawWindow([batch(0),batch(1,1000,1000,500)],2).boundary,"overlap");
});
test("partial history, fractional SPS, rounded timestamps and hard memory limit stay explicit",()=>{
  assert.equal(selectRawWindow([batch(0)],2).boundary,"history");
  assert.equal(selectRawWindow([batch(0,.5,1)],1).raw.length,1);
  assert.equal(selectRawWindow([batch(0),batch(1,1000,1000,1001)],2).raw.length,2000);
  const trimmed=selectRawWindow([batch(0),batch(1)],2,1500);assert.equal(trimmed.raw.length,1500);assert.equal(trimmed.limited,true);assert.equal(trimmed.timestamp,new Date(start+500).toISOString());
  assert.equal(selectRawWindow([],2).sps,null);assert.throws(()=>selectRawWindow([],0));
});
test("wall-clock time alone never evicts a stopped stream",()=>{
  const rows=[batch(0),batch(1),batch(2)],before=selectRawWindow(rows,2),original=Date.now;
  Date.now=()=>start+24*60*60*1000;
  try{assert.deepEqual(selectRawWindow(rows,2),before);}finally{Date.now=original;}
});
