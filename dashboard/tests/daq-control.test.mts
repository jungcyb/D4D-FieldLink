import {test, type TestContext} from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {controlDaq,parseCommand} from "../lib/server/daq-control.ts";
const uuid="12345678-1234-1234-1234-123456789012";
async function board(t:TestContext,options:{mismatch?:boolean; reject?:boolean; drop?:boolean}={}){
  const received:number[]=[];let acquiring=true,rate=1000;
  const channelCapabilities=()=>({channelCount:1,channels:[{id:"CH0",label:"ADS8688 CH0",adc:"ADS8688",adcChannel:"AIN0",sampleRateHz:rate,inputUnit:"V",rateGroupId:"ads8688.scan",streamAvailable:true}],sampleRateGroups:[{id:"ads8688.scan",label:"ADS8688 공통",channelIds:["CH0"],currentHz:rate,writable:true,minHz:10,maxHz:2000,stepHz:1}]});
  const sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));let buffer=Buffer.alloc(0);socket.on("data",chunk=>{
    buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=12){const size=buffer.readUInt32BE(0);if(buffer.length<12+size)return;const type=buffer.readUInt16BE(6),id=buffer.readUInt32BE(8),body=buffer.subarray(12,12+size);buffer=buffer.subarray(12+size);received.push(type);
      if(options.drop&&type===3){socket.destroy();return;}
      const reject=options.reject&&type>=3;
      if(!reject){if(type===3)acquiring=true;if(type===4)acquiring=false;if(type===12)rate=JSON.parse(body.toString()).rateHz;}
      const data=type===1?{uuid:options.mismatch?"wrong":uuid,capabilities:["sample_rate","acquisition_control"],channel_capabilities:channelCapabilities()}:reject?{error:"MCU rejected"}:{uuid,acquiring,scan_rate_hz:rate,frames_total:10,sequence_gaps_total:0,channel_capabilities:channelCapabilities()};
      const payload=Buffer.from(JSON.stringify(data)),packet=Buffer.alloc(12+payload.length);packet.writeUInt32BE(payload.length);packet.writeUInt16BE(1,4);packet.writeUInt16BE(reject?0xffff:type|0x8000,6);packet.writeUInt32BE(id,8);payload.copy(packet,12);
      // Exercise TCP fragmentation, including a split header.
      socket.write(packet.subarray(0,7));socket.write(packet.subarray(7));
    }
  });});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const daq={uuid,label:"test",ip:"127.0.0.1",port:(server.address() as net.AddressInfo).port,source:"external" as const,equipmentId:null,lastSeen:"",createdAt:""};
  return{daq,received};
}
test("read-only status sends no acquisition command",async t=>{const {daq,received}=await board(t);assert.equal((await controlDaq(daq)).scan_rate_hz,1000);assert.deepEqual(received,[1,2]);});
test("start, stop and rate require ACK plus read-back status",async t=>{const{daq,received}=await board(t);assert.equal((await controlDaq(daq,{action:"stop"})).acquiring,false);assert.equal((await controlDaq(daq,{action:"start"})).acquiring,true);assert.equal((await controlDaq(daq,{action:"rate",groupId:"ads8688.scan",rate:1500})).scan_rate_hz,1500);assert.deepEqual(received,[1,4,2,1,3,2,1,12,2]);});
test("UUID mismatch blocks hardware command",async t=>{const{daq,received}=await board(t,{mismatch:true});await assert.rejects(controlDaq(daq,{action:"stop"}),/UUID/);assert.deepEqual(received,[1]);});
test("MCU rejection and disconnect are not reported as success",async t=>{const rejected=await board(t,{reject:true});await assert.rejects(controlDaq(rejected.daq,{action:"stop"}),/MCU rejected/);const dropped=await board(t,{drop:true});await assert.rejects(controlDaq(dropped.daq,{action:"start"}),/불확실/);});
test("rate commands require a finite value and group",()=>{for(const rate of [0,"1000",NaN])assert.throws(()=>parseCommand({action:"rate",groupId:"ads8688.scan",rate}));assert.throws(()=>parseCommand({action:"rate",rate:1000}));assert.throws(()=>parseCommand({action:"reboot"}));assert.deepEqual(parseCommand({action:"rate",groupId:"ads8688.scan",rate:10}),{action:"rate",groupId:"ads8688.scan",rate:10});});
