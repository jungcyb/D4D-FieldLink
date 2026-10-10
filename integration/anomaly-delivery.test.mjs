import test from "node:test";
import assert from "node:assert/strict";
import {reportAnomaly} from "./collector.mjs";
const anomaly={warn_ratio:2,alarm_ratio:4,short_tau_s:1,long_tau_s:60,channels:[{id:"CH0",state:"alarm",rms_short_v:0.2,rms_long_v:0.04,ratio:5,changed_unix_ms:1760000000123,events:1}]};
const sensors=[{id:"sensor-0",channel:"CH0",name:"motor"}];

test("diagnosis is sent before logs, and a failed log can be retried without losing the alarm",async()=>{
  const reported=new Map(),calls=[];
  const failed=async(path,options)=>{calls.push([path,JSON.parse(options.body)]);if(path==="/edge/logs")throw Error("offline");};
  await assert.rejects(reportAnomaly("board",anomaly,reported,sensors,failed),/offline/);
  assert.equal(calls[0][0],"/edge/frames");assert.equal(reported.size,0);
  const firstId=calls[0][1].frameId;
  const delivered=async(path,options)=>{calls.push([path,JSON.parse(options.body)]);};
  await reportAnomaly("board",anomaly,reported,sensors,delivered);
  assert.equal(calls[2][1].frameId,firstId);assert.equal(reported.get("CH0"),"alarm");
  const count=calls.length;await reportAnomaly("board",anomaly,reported,sensors,delivered);assert.equal(calls.length,count);
});

test("a failed diagnosis does not advance state or upload a misleading successful log",async()=>{
  const reported=new Map(),calls=[];
  await assert.rejects(reportAnomaly("board",anomaly,reported,sensors,async path=>{calls.push(path);throw Error("timeout");}),/timeout/);
  assert.deepEqual(calls,["/edge/frames"]);assert.equal(reported.size,0);
});
