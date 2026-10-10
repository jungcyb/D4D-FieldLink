import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { crc32 } from "node:zlib";
import { anomalyEvents, discover, discoverBoards, decodeDiscoveryResponse, decodeFrame, rawCodeToVolts, recoveryCursor, recoveryGaps, BatchWriter, LiveSampleClock, batchFrameCount } from "./collector.mjs";

test("ADS8688 straight-binary conversion preserves polarity", () => {
  assert.equal(rawCodeToVolts(0), -10.24); assert.equal(rawCodeToVolts(32768), 0); assert.ok(rawCodeToVolts(65535) > 10.239);
});

test("NU40 decodes signed acceleration in g with its reconstructed sample timestamp", () => {
  const payload = Buffer.alloc(64), frame = payload.subarray(16);
  payload.writeBigUInt64BE(42n, 0); payload.writeBigUInt64BE(1760000001000000000n, 8);
  frame.writeUInt32LE(0x3034554e, 0); frame.writeUInt16LE(1, 4); frame.writeUInt16LE(28, 6);
  frame.writeUInt32LE(7, 8); frame.writeBigUInt64LE(1760000000000000n, 12);
  frame.writeUInt32LE(104, 20); frame.writeUInt16LE(3, 24); frame.writeUInt16LE(2, 26);
  [-16384, 0, 16384].forEach((value, i) => frame.writeInt16LE(value, 28 + i * 2));
  frame.writeUInt32LE(crc32(frame.subarray(0, 44)), 44);
  const decoded = decodeFrame(payload, true);
  assert.equal(decoded.source, 'nu40'); assert.deepEqual(decoded.channelIds, ['CH8', 'CH9', 'CH10']);
  assert.deepEqual(decoded.samples, [-.999424, 0, .999424]);
  assert.equal(decoded.timestamp, new Date(1760000000000).toISOString());
});

test("timestamped frame decoder returns record, time and eight channels", () => {
  const payload = Buffer.alloc(64), frame = payload.subarray(16); payload.writeBigUInt64BE(BigInt(42), 0); payload.writeBigUInt64BE(BigInt(1_760_000_000_123_000_000), 8);
  frame.writeUInt32LE(0x38534441, 0); frame.writeUInt16LE(1, 4); frame.writeUInt16LE(28, 6); frame.writeUInt32LE(7, 8); frame.writeUInt32LE(1000, 20); frame.writeUInt16LE(8, 24); frame.writeUInt16LE(1, 26);
  for (let channel = 0; channel < 8; channel++) frame.writeUInt16LE(32768 + channel, 28 + channel * 2); frame.writeUInt32LE(crc32(frame.subarray(0, 44)), 44);
  const decoded = decodeFrame(payload, true); assert.equal(decoded.recordId, BigInt(42)); assert.equal(decoded.scanRate, 1000); assert.equal(decoded.samples.length, 8); assert.equal(decoded.samples[0], 0); assert.equal(decoded.timestamp, "2025-10-09T08:53:20.123Z");
});

test("live ADS clock removes transport bursts without changing archived timestamps",()=>{
  const clock=new LiveSampleClock(),base=BigInt(1_760_000_000_000_000_000);
  const make=(sourceUs,receivedNs,archived=false)=>({source:'ads8688',sourceUs:BigInt(sourceUs),receivedNs:base+BigInt(receivedNs),timestamp:new Date(Number((base+BigInt(receivedNs))/1000000n)).toISOString(),archived});
  const rows=[clock.normalize(make(1_000_000,0)),clock.normalize(make(1_001_000,0)),clock.normalize(make(1_002_000,20_000_000))];
  assert.deepEqual(rows.map(row=>Date.parse(row.timestamp)-Date.parse(rows[0].timestamp)),[0,1,2]);
  const archived=make(500_000,99_000_000,true);assert.equal(clock.normalize(archived).timestamp,archived.timestamp);
});

test("recovery reports only unavailable raw boundaries", () => {
  const plan = { raw: true, logs: false, from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T00:00:10.000Z" };
  assert.deepEqual(recoveryGaps(plan, "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:09.000Z"), [
    { stream: "raw", from: plan.from, to: "2026-01-01T00:00:01.000Z", reason: "보드 링버퍼 시작 이전 구간" },
    { stream: "raw", from: "2026-01-01T00:00:09.000Z", to: plan.to, reason: "보드 링버퍼에서 확인되지 않은 끝 구간" },
  ]);
});

test("backlog replay runs only for an explicit raw recovery", () => {
  assert.equal(recoveryCursor(null, BigInt(10)), null);
  assert.equal(recoveryCursor({ raw: false }, BigInt(10)), null);
  assert.equal(recoveryCursor({ raw: true }, BigInt(10)), BigInt(9));
  assert.equal(recoveryCursor({ raw: true }, null), null);
});


test("wire decoder accepts actual variable sample rates and rejects zero", () => {
  for (const rate of [10, 250, 1800, 0]) {
    const payload=Buffer.alloc(64),frame=payload.subarray(16);payload.writeBigUInt64BE(BigInt(1),0);payload.writeBigUInt64BE(BigInt(1760000000000000000),8);
    frame.writeUInt32LE(0x38534441,0);frame.writeUInt16LE(1,4);frame.writeUInt16LE(28,6);frame.writeUInt32LE(rate,20);frame.writeUInt16LE(8,24);frame.writeUInt16LE(1,26);frame.writeUInt32LE(crc32(frame.subarray(0,44)),44);
    if(rate)assert.equal(decodeFrame(payload,true).scanRate,rate);else assert.throws(()=>decodeFrame(payload,true),/scan rate/);
  }
});
class CapturingWriter extends BatchWriter {
  constructor(batchMs=1000){super("test",{},null,batchMs);this.batches=[];}
  closeBatch(){if(this.frames.length)this.batches.push(this.frames);this.frames=[];}
}
const rateFrame=(id,rate)=>({recordId:BigInt(id),timestamp:new Date(1760000000000+id*1000/rate).toISOString(),scanRate:rate,samples:Array(8).fill(id),archived:false});
test("interleaved sources batch independently without artificial sequence gaps", () => {
  const writer = new CapturingWriter();
  for (let i = 0; i < 6; i++) {
    writer.add({...rateFrame(i * 2, 3), source: 'ads8688', sequence: i});
    writer.add({...rateFrame(i * 2 + 1, 2), source: 'nu40', sequence: i, samples: [0, 1, 2]});
  }
  assert.deepEqual(writer.batches.map(batch => [batch[0].source, batch.length]),
    [['nu40', 2], ['ads8688', 3], ['nu40', 2], ['ads8688', 3], ['nu40', 2]]);
  assert.ok(writer.batches.every(batch => batch.every(frame => frame.source === batch[0].source)));
});
test("collector uses actual SPS for batch size and splits rate changes and record gaps",()=>{
  for(const rate of [250,1800]){const writer=new CapturingWriter();for(let i=0;i<rate+3;i++)writer.add(rateFrame(i,rate));writer.closeBatch();assert.deepEqual(writer.batches.map(b=>b.length),[rate,3]);assert.ok(writer.batches.every(b=>b.every(f=>f.scanRate===rate)));}
  const writer=new CapturingWriter();writer.add(rateFrame(1,250));writer.add(rateFrame(2,250));writer.add(rateFrame(3,1800));writer.add(rateFrame(8,1800));writer.closeBatch();assert.deepEqual(writer.batches.map(b=>b.map(f=>Number(f.recordId))),[[1,2],[3],[8]]);
});
test("dashboard persistence batches target one second independently of SPS",()=>{assert.equal(batchFrameCount(1500),1500);assert.equal(batchFrameCount(104),104);assert.equal(batchFrameCount(3),3);});
test("collector keeps high-rate batches inside the backend raw capacity",()=>{
  const writer=new CapturingWriter();for(let i=0;i<5000;i++)writer.add(rateFrame(i,10000));writer.closeBatch();assert.deepEqual(writer.batches.map(b=>b.length),[4096,904]);
});

test("discovery v2 exposes heterogeneous channel capabilities", () => {
  const nonce=BigInt(7),hostname=Buffer.from("sk"),model=Buffer.from("dual-adc"),capability=Buffer.from(JSON.stringify({channelCount:2,channels:[["CH0","ADS8688 CH0","ADS8688","AIN0",1000,"V","ads8688.scan",true],["ADS1263-AIN0_AIN1","ADS1263 AIN0–AIN1","ADS1263","AIN0-AIN1",400,"code","ads1263.adc1",false]],sampleRateGroups:[["ads8688.scan","ADS8688 공통",["CH0"],1000,true,10,2000,1]]})),packet=Buffer.alloc(38+hostname.length+model.length+capability.length);
  packet.write("A8DR");packet.writeUInt16BE(2,4);packet.writeBigUInt64BE(nonce,8);Buffer.alloc(16,1).copy(packet,16);packet.writeUInt16BE(8765,32);packet[34]=hostname.length;packet[35]=model.length;packet.writeUInt16BE(capability.length,36);hostname.copy(packet,38);model.copy(packet,38+hostname.length);capability.copy(packet,38+hostname.length+model.length);
  const result=decodeDiscoveryResponse(packet,"192.168.0.240",nonce);assert.equal(result.channelCapabilities.channelCount,2);assert.equal(result.channelCapabilities.channels[1].id,"ADS1263-AIN0_AIN1");
});

test("collector discovery falls back to v1-only deployed boards",async t=>{
  const socket=dgram.createSocket("udp4");await new Promise(resolve=>socket.bind(0,"127.0.0.1",resolve));
  const keys=["BOARD_HOST","BOARD_DISCOVERY_PORT","BOARD_DISCOVERY_ADDRESS"],saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{socket.close();for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});
  delete process.env.BOARD_HOST;process.env.BOARD_DISCOVERY_PORT=String(socket.address().port);process.env.BOARD_DISCOVERY_ADDRESS="127.0.0.1";
  const versions=[];socket.on("message",(query,remote)=>{
    const version=query.readUInt16BE(4);versions.push(version);if(version!==1)return;
    const reply=Buffer.alloc(36);reply.write("A8DR");reply.writeUInt16BE(1,4);query.copy(reply,8,8,16);Buffer.alloc(16,1).copy(reply,16);reply.writeUInt16BE(8765,32);socket.send(reply,remote.port,remote.address);
  });
  const board=await discover();assert.equal(board.port,8765);assert.equal(board.uuid,"01010101-0101-0101-0101-010101010101");assert.deepEqual(versions.sort(),[1,2]);
});

test("collector discovery returns every answering board for parallel collection",async t=>{
  const socket=dgram.createSocket("udp4");await new Promise(resolve=>socket.bind(0,"127.0.0.1",resolve));
  const keys=["BOARD_HOST","BOARD_DISCOVERY_PORT","BOARD_DISCOVERY_ADDRESS"],saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{socket.close();for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});
  delete process.env.BOARD_HOST;process.env.BOARD_DISCOVERY_PORT=String(socket.address().port);process.env.BOARD_DISCOVERY_ADDRESS="127.0.0.1";
  socket.on("message",(query,remote)=>{
    if(query.readUInt16BE(4)!==1)return;
    for(const id of [1,2]){const reply=Buffer.alloc(36);reply.write("A8DR");reply.writeUInt16BE(1,4);query.copy(reply,8,8,16);Buffer.alloc(16,id).copy(reply,16);reply.writeUInt16BE(8765,32);socket.send(reply,remote.port,remote.address);}
  });
  const boards=await discoverBoards();assert.deepEqual(boards.map(board=>board.uuid).sort(),["01010101-0101-0101-0101-010101010101","02020202-0202-0202-0202-020202020202"]);
});

test("fixed BOARD_HOST accepts a comma-separated board list",async t=>{
  const saved=process.env.BOARD_HOST;t.after(()=>{if(saved===undefined)delete process.env.BOARD_HOST;else process.env.BOARD_HOST=saved;});
  process.env.BOARD_HOST="192.168.0.240, 192.168.0.62";
  assert.deepEqual((await discoverBoards()).map(board=>board.ip),["192.168.0.240","192.168.0.62"]);
});

test("anomaly diagnoses are posted once per state change for registered channels",()=>{
  const status=(states)=>({warn_ratio:2,alarm_ratio:4,short_tau_s:1,long_tau_s:60,channels:states.map(([id,state],i)=>({id,state,rms_short_v:0.1,rms_long_v:0.05,ratio:2.5,changed_unix_ms:1760000000000+i,events:1}))});
  const reported=new Map(),registered=[{channel:"CH0"},{channel:"ch1"}];
  assert.deepEqual(anomalyEvents(status([["CH0","warmup"],["CH1","normal"]]),reported,registered).diagnoses,[]);
  assert.deepEqual(anomalyEvents(status([["CH0","normal"],["CH1","normal"]]),reported,registered).diagnoses,[]);
  const raised=anomalyEvents(status([["CH0","alarm"],["CH1","normal"],["CH2","warning"]]),reported,registered).diagnoses;
  assert.deepEqual(raised.map(d=>[d.channel,d.severity]),[["CH0","critical"]]);
  assert.equal(raised[0].timestamp,new Date(1760000000000).toISOString());assert.match(raised[0].description,/비율 2\.50/);
  assert.deepEqual(anomalyEvents(status([["CH0","alarm"],["CH1","normal"]]),reported,registered).diagnoses,[]);
  assert.deepEqual(anomalyEvents(status([["CH0","normal"],["CH1","warning"]]),reported,registered).diagnoses.map(d=>[d.channel,d.severity]),[["CH0","normal"],["CH1","warning"]]);
  assert.deepEqual(anomalyEvents(status([["CH5","alarm"]]),new Map(),registered).diagnoses,[]);
  assert.deepEqual(anomalyEvents(undefined,reported,registered).diagnoses,[]);
});

test("NU40 RMS schema produces continuously refreshed g diagnoses",()=>{
  const reported=new Map(),sensors=[{channel:"CH8",name:"NU40 X"}];
  const status={method:"rms_sta_lta",unit:"g",warn_ratio:2,alarm_ratio:3,short_tau_s:.25,long_tau_s:10,evaluated_unix_ms:1760000000123,
    channels:[{id:"CH8",state:"normal",rms_short:.0123,rms_long:.0456,ratio:.27,changed_unix_ms:1760000000000,events:0}]};
  const first=anomalyEvents(status,reported,sensors).diagnoses[0];
  assert.equal(first.channel,"CH8");assert.equal(first.severity,"normal");assert.match(first.description,/0\.0123 g/);
  status.channels[0].rms_short=.02;status.evaluated_unix_ms++;
  assert.equal(anomalyEvents(status,reported,sensors).diagnoses.length,1);
});

test("an anomaly that cleared while the collector was away is reported as normal",()=>{
  const status={warn_ratio:2,alarm_ratio:4,short_tau_s:1,long_tau_s:60,channels:[{id:"CH0",state:"normal",rms_short_v:0.01,rms_long_v:0.01,ratio:1,changed_unix_ms:0,events:1},{id:"CH1",state:"normal",rms_short_v:0.01,rms_long_v:0.01,ratio:1,changed_unix_ms:0,events:0}]};
  const sensors=[{channel:"CH0",diagnosis:{model:"edge-rms-sta-lta",severity:"warning"}},{channel:"CH1",diagnosis:{model:"other",severity:"critical"}}];
  assert.deepEqual(anomalyEvents(status,new Map(),sensors).diagnoses.map(d=>[d.channel,d.severity]),[["CH0","normal"]]);
});

test("recovery batches never project past the plan end when the real rate beats the advertised SPS",()=>{
  // 104 Hz advertised, frames actually 1000/107 ms apart; the plan ends at the last frame.
  const start=1760000000000,frames=Array.from({length:300},(_,i)=>({recordId:BigInt(i+1),timestamp:new Date(start+Math.round(i*1000/107)).toISOString(),scanRate:104,samples:Array(8).fill(0),archived:true}));
  const plan={raw:true,from:new Date(start).toISOString(),to:frames.at(-1).timestamp};
  class RecoveryWriter extends BatchWriter{constructor(){super("test",{},plan);this.batches=[];}closeBatch(){if(this.frames.length)this.batches.push(this.frames);this.frames=[];}}
  const writer=new RecoveryWriter();for(const frame of frames)writer.add(frame);writer.closeBatch();
  assert.equal(writer.batches.flat().length,300);
  for(const batch of writer.batches)assert.ok(Date.parse(batch[0].timestamp)+(batch.length-1)*1000/104<=Date.parse(plan.to)+1);
});

test("every anomaly state change becomes a device log, including unregistered channels",()=>{
  const status=(states)=>({method:"rms_sta_lta",warn_ratio:2,alarm_ratio:4,short_tau_s:1,long_tau_s:60,channels:states.map(([id,state])=>({id,state,rms_short_v:0.2,rms_long_v:0.04,ratio:5,changed_unix_ms:1760000000123,events:1}))});
  const reported=new Map(),sensors=[{id:"sensor-0",name:"motor",channel:"CH0"}];
  anomalyEvents(status([["CH0","normal"],["CH2","normal"]]),reported,sensors);
  const {diagnoses,logs}=anomalyEvents(status([["CH0","alarm"],["CH2","warning"]]),reported,sensors);
  assert.deepEqual(diagnoses.map(d=>d.channel),["CH0"]);
  assert.deepEqual(logs.map(({log})=>[log.code,log.level,log.sensorId]),[["AD_RMS_ALARM","error","sensor-0"],["AD_RMS_WARNING","warning",null]]);
  assert.equal(logs[0].batchId,"ad-CH0-1760000000123-alarm");assert.match(logs[0].log.message,/CH0 \(motor\) 진동 RMS 급증/);
  assert.equal(logs[0].log.metadata.previous,"normal");assert.equal(logs[0].log.timestamp,new Date(1760000000123).toISOString());
  assert.deepEqual(anomalyEvents(status([["CH0","alarm"],["CH2","warning"]]),reported,sensors).logs,[]);
});
