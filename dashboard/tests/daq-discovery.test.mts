import {test} from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import {Ads8688DiscoveryAdapter,normalizeCapabilities} from "../lib/server/adapters.ts";
const capability={channelCount:1,channels:[{id:"CH0",label:"CH0",adc:"ADS8688",adcChannel:"AIN0",sampleRateHz:1000,inputUnit:"V",rateGroupId:"scan",streamAvailable:true}],sampleRateGroups:[{id:"scan",label:"scan",channelIds:["CH0"],currentHz:1000,writable:true,minHz:10,maxHz:2000,stepHz:1}]};
test("UDP discovery supports v1-only boards and never loses v2 metadata to v1 reply",async t=>{
  const socket=dgram.createSocket("udp4");await new Promise<void>(resolve=>socket.bind(0,"127.0.0.1",resolve));
  const previous={address:process.env.DAQ_DISCOVERY_ADDRESS,port:process.env.DAQ_DISCOVERY_PORT,timeout:process.env.DAQ_DISCOVERY_TIMEOUT_MS};
  t.after(()=>{socket.close();for(const [key,value] of Object.entries({DAQ_DISCOVERY_ADDRESS:previous.address,DAQ_DISCOVERY_PORT:previous.port,DAQ_DISCOVERY_TIMEOUT_MS:previous.timeout})){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  process.env.DAQ_DISCOVERY_ADDRESS="127.0.0.1";process.env.DAQ_DISCOVERY_PORT=String(socket.address().port);process.env.DAQ_DISCOVERY_TIMEOUT_MS="100";
  let rich=false;const versions:number[]=[];
  socket.on("message",(query,remote)=>{
    const version=query.readUInt16BE(4);versions.push(version);if(version===2&&!rich)return;
    const extra=version===2?Buffer.from(JSON.stringify(capability)):Buffer.alloc(0),header=version===2?38:36,packet=Buffer.alloc(header+extra.length);
    packet.write("A8DR");packet.writeUInt16BE(version,4);query.copy(packet,8,8,16);Buffer.from("11111111222243338444555555555555","hex").copy(packet,16);packet.writeUInt16BE(8765,32);if(version===2)packet.writeUInt16BE(extra.length,36);extra.copy(packet,header);
    socket.send(packet,remote.port,remote.address);
  });
  const adapter=new Ads8688DiscoveryAdapter(),legacy=await adapter.discover();assert.equal(legacy.length,1);assert.equal(legacy[0].channels,undefined);assert.deepEqual(versions.sort(),[1,2]);
  rich=true;const upgraded=await adapter.discover();assert.equal(upgraded.length,1);assert.equal(upgraded[0].channels?.[0].id,"CH0");
});
test("invalid group bounds and ambiguous channel membership are rejected",()=>{
  assert.ok(normalizeCapabilities(capability));
  for(const patch of [{minHz:NaN},{maxHz:Infinity},{stepHz:0},{channelIds:["CH0","CH0"]}])assert.equal(normalizeCapabilities({...capability,sampleRateGroups:[{...capability.sampleRateGroups[0],...patch}]}),null);
  assert.equal(normalizeCapabilities({...capability,channels:[{...capability.channels[0],rateGroupId:"missing"}]}),null);
});
