import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {controlDaq,parseCommand} from "../lib/server/daq-control.ts";
const uuid="11111111-2222-4333-8444-555555555555";
async function board(t:TestContext,{supported=true,stale=false}:{supported?:boolean;stale?:boolean}={}){
  const received:number[]=[],channels=[{channel:"CH0",sps:1000},{channel:"CH1",sps:250}],sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));let buffer=Buffer.alloc(0);socket.on("data",chunk=>{
    buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=12){const size=buffer.readUInt32BE();if(buffer.length<12+size)return;const type=buffer.readUInt16BE(6),id=buffer.readUInt32BE(8),payload=buffer.subarray(12,12+size);buffer=buffer.subarray(12+size);received.push(type);
      if(type===12&&!stale){const command=JSON.parse(payload.toString());const row=channels.find(c=>c.channel===command.channel);if(row)row.sps=command.sps;}
      const body=type===1?{uuid,capabilities:["sample_rate","acquisition_control",...(supported?["channel_sample_rate"]:[])]}:{uuid,acquiring:true,sampling:{commonRateHz:1000,channels}};
      const json=Buffer.from(JSON.stringify(body)),packet=Buffer.alloc(12+json.length);packet.writeUInt32BE(json.length);packet.writeUInt16BE(1,4);packet.writeUInt16BE(type|0x8000,6);packet.writeUInt32BE(id,8);json.copy(packet,12);socket.write(packet);
    }
  });});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return{received,channels,daq:{uuid,label:"test",ip:"127.0.0.1",port:(server.address() as net.AddressInfo).port,source:"external" as const,equipmentId:null,lastSeen:"",createdAt:""}};
}
test("channel rate change requires capability, ACK and matching read-back; other channels stay intact",async t=>{
  const {daq,received,channels}=await board(t);const status=await controlDaq(daq,{action:"channel_rate",channel:"CH-1",sps:.5});assert.equal(status.sampling.totalRateHz,1000.5);assert.equal(channels[0].sps,1000);assert.equal(channels[1].sps,.5);assert.deepEqual(received,[1,2,12,2]);
});
test("unsupported or unknown channel sends no channel command",async t=>{
  const unsupported=await board(t,{supported:false});await assert.rejects(controlDaq(unsupported.daq,{action:"channel_rate",channel:"CH1",sps:500}),/지원하지/);assert.deepEqual(unsupported.received,[1]);
  const supported=await board(t);await assert.rejects(controlDaq(supported.daq,{action:"channel_rate",channel:"CH99",sps:500}),/보고하지/);assert.deepEqual(supported.received,[1,2]);
});
test("an ACK with stale channel rate is not reported as success",async t=>{const {daq}=await board(t,{stale:true});await assert.rejects(controlDaq(daq,{action:"channel_rate",channel:"CH1",sps:500}),/일치하지/);});
test("fractional channel rate is accepted and invalid rates or channel IDs are rejected",()=>{
  assert.deepEqual(parseCommand({action:"channel_rate",channel:"CH1",sps:.5}),{action:"channel_rate",channel:"CH1",sps:.5});
  for(const sps of [-1,0,NaN,Infinity,"250"])assert.throws(()=>parseCommand({action:"channel_rate",channel:"CH1",sps}));assert.throws(()=>parseCommand({action:"channel_rate",channel:"",sps:250}));
});
