import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { crc32 } from "node:zlib";
import { discover, discoverBoards, decodeDiscoveryResponse, decodeFrame, rawCodeToVolts, recoveryCursor, recoveryGaps, BatchWriter } from "./collector.mjs";

test("ADS8688 straight-binary conversion preserves polarity", () => {
  assert.equal(rawCodeToVolts(0), -10.24); assert.equal(rawCodeToVolts(32768), 0); assert.ok(rawCodeToVolts(65535) > 10.239);
});

test("timestamped frame decoder returns record, time and eight channels", () => {
  const payload = Buffer.alloc(64), frame = payload.subarray(16); payload.writeBigUInt64BE(BigInt(42), 0); payload.writeBigUInt64BE(BigInt(1_760_000_000_123_000_000), 8);
  frame.writeUInt32LE(0x38534441, 0); frame.writeUInt16LE(1, 4); frame.writeUInt16LE(28, 6); frame.writeUInt32LE(7, 8); frame.writeUInt32LE(1000, 20); frame.writeUInt16LE(8, 24); frame.writeUInt16LE(1, 26);
  for (let channel = 0; channel < 8; channel++) frame.writeUInt16LE(32768 + channel, 28 + channel * 2); frame.writeUInt32LE(crc32(frame.subarray(0, 44)), 44);
  const decoded = decodeFrame(payload, true); assert.equal(decoded.recordId, BigInt(42)); assert.equal(decoded.scanRate, 1000); assert.equal(decoded.samples.length, 8); assert.equal(decoded.samples[0], 0); assert.equal(decoded.timestamp, "2025-10-09T08:53:20.123Z");
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
  constructor(){super("test",{});this.batches=[];}
  closeBatch(){if(this.frames.length)this.batches.push(this.frames);this.frames=[];}
}
const rateFrame=(id,rate)=>({recordId:BigInt(id),timestamp:new Date(1760000000000+id*1000/rate).toISOString(),scanRate:rate,samples:Array(8).fill(id),archived:false});
test("collector uses actual SPS for batch size and splits rate changes and record gaps",()=>{
  for(const rate of [250,1800]){const writer=new CapturingWriter();for(let i=0;i<rate+3;i++)writer.add(rateFrame(i,rate));writer.closeBatch();assert.deepEqual(writer.batches.map(b=>b.length),[rate,3]);assert.ok(writer.batches.every(b=>b.every(f=>f.scanRate===rate)));}
  const writer=new CapturingWriter();writer.add(rateFrame(1,250));writer.add(rateFrame(2,250));writer.add(rateFrame(3,1800));writer.add(rateFrame(8,1800));writer.closeBatch();assert.deepEqual(writer.batches.map(b=>b.map(f=>Number(f.recordId))),[[1,2],[3],[8]]);
});
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
