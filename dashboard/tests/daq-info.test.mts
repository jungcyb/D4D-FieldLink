import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,basename,resolve} from "node:path";
import {FileRepository} from "../lib/server/repository.ts";
import {MaintenanceService} from "../lib/server/service.ts";
import {parseSampling} from "../lib/server/daq-info.ts";
import {channelRate,channelRows} from "../lib/daq-sampling.ts";
import {normalizeAcquisitionStatus} from "../lib/server/daq-control.ts";
import {ApiError} from "../lib/server/validation.ts";
const uuid="11111111-2222-4333-8444-555555555555",identity={uuid,label:"DAQ",ip:"127.0.0.1",port:9000};
const sampling=()=>({commonRateHz:1000,totalRateHz:250.5,channels:[{channel:"CH0",sps:250},{channel:"CH1",sps:.5}]});
function setup(t:TestContext){const dir=mkdtempSync(join(tmpdir(),"fieldlink-inventory-test-"));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir()))&&basename(dir).startsWith("fieldlink-inventory-test-"));rmSync(dir,{recursive:true,force:true});});const repo=new FileRepository(dir,"external"),svc=new MaintenanceService(repo);return{repo,svc};}
test("board inventory registers sensors once, preserves operator metadata and independent rates",t=>{
  const {repo,svc}=setup(t);const sensors=[{edgeId:"vibration",channel:"CH0",name:"진동",type:"vibration",unit:"g",sps:250},{edgeId:"temperature",channel:"CH1",name:"온도",type:"temperature",unit:"°C",sps:.5}];
  svc.upsertBoard({...identity,sampling:sampling(),sensors,inventoryComplete:true});const before=svc.snapshot(),first=before.sensors[0];assert.equal(before.sensors.length,2);assert.equal(before.daqs[0].sampling!.totalRateHz,250.5);assert.deepEqual(before.sensors.map(s=>s.sps),[250,.5]);
  svc.saveSensor({...first,name:"운영자 센서명",position:"사용자 지정 위치",unit:"mm/s"},first.id);svc.calibrateSensor(first.id,{scale:2,offset:5,inputUnit:"V"});svc.setPhoto(first.id,"preserved.png");
  svc.upsertBoard({...identity,sensors});const after=svc.snapshot();assert.equal(after.sensors.length,2);const kept=after.sensors.find(s=>s.id===first.id)!;assert.equal(kept.name,"운영자 센서명");assert.equal(kept.position,"사용자 지정 위치");assert.equal(kept.unit,"mm/s");assert.equal(kept.photo,"preserved.png");assert.equal(kept.calibration.scale,2);assert.equal(new FileRepository(repo.directory,"external").read().sensors.length,2);
});
test("a single frame can announce new sensors and ingest differing channel rates atomically",t=>{
  const {svc,repo}=setup(t);svc.upsertBoard(identity);const at=new Date().toISOString();
  const frame={daqUuid:uuid,frameId:"first",sampling:sampling(),sensors:[{channel:"CH0",edgeId:"vib",sps:250},{channel:"CH1",edgeId:"temp",sps:.5}],readings:[{channel:"CH0",timestamp:at,value:1,sps:250,raw:[1,2]},{channel:"CH1",timestamp:at,value:2,sps:.5,raw:[2,3]}]};
  assert.equal(svc.ingest(frame).accepted,2);assert.equal(svc.ingest(frame).duplicate,true);assert.equal(repo.read().sensors.length,2);assert.deepEqual(svc.snapshot().sensors.map(s=>s.sps),[250,.5]);
  const before=readFileSync(repo.filename,"utf8");assert.throws(()=>svc.ingest({...frame,frameId:"bad",sensors:[...frame.sensors,{channel:"CH2"}],readings:[{...frame.readings[0],raw:[NaN]}]}),ApiError);assert.equal(readFileSync(repo.filename,"utf8"),before);
});
test("complete inventory marks disconnected sensors without deleting their data",t=>{
  const {svc,repo}=setup(t);svc.upsertBoard({...identity,sensors:[{channel:"CH0",edgeId:"one"},{channel:"CH1",edgeId:"two"}]});
  svc.ingest({daqUuid:uuid,readings:[{channel:"CH1",timestamp:new Date().toISOString(),sps:250,value:2,raw:[2]}]});
  svc.upsertBoard({...identity,sensors:[{channel:"CH0"}],inventoryComplete:true});const snapshot=svc.snapshot();assert.equal(snapshot.sensors.find(s=>s.channel==="CH1")!.online,false);assert.equal(repo.read().readings.length,1);
  assert.throws(()=>svc.upsertBoard({...identity,sensors:[{channel:"CH1",edgeId:"replacement"}]}),ApiError);
});
test("full totals are validated, partial totals stay unknown, and unknown per-channel rates stay null",()=>{
  assert.equal(parseSampling(sampling()).totalRateHz,250.5);
  assert.equal(parseSampling({channels:[{channel:"CH0",sps:250}],complete:false}).totalRateHz,null);
  assert.equal(parseSampling({channels:[{channel:"CH0",sps:null}]}).totalRateHz,null);
  for(const bad of [{...sampling(),totalRateHz:999},{channels:[{channel:"CH0",sps:1},{channel:"CH-0",sps:2}]},{channels:[{channel:"CH0",sps:NaN}]}])assert.throws(()=>parseSampling(bad),ApiError);
  const rate=parseSampling({channels:[{channel:"CH0",sps:null}],commonRateHz:1000});assert.equal(channelRate({sampling:rate},"CH0"),null);
});
test("legacy status uses declared channel count while rich status carries fractional channel rates",()=>{
  const legacy=normalizeAcquisitionStatus({uuid,acquiring:true,scan_rate_hz:250,channel_count:3},{capabilities:["sample_rate"]},uuid);assert.equal(legacy.sampling.totalRateHz,750);assert.equal(legacy.sampling.channels.length,3);assert.equal(legacy.capabilities.channelRate,false);
  const rich=normalizeAcquisitionStatus({uuid,acquiring:true,sampling:sampling()},{capabilities:["sample_rate","channel_sample_rate"]},uuid);assert.equal(rich.sampling.totalRateHz,250.5);assert.equal(rich.sampling.channels[1].sps,.5);assert.equal(rich.capabilities.channelRate,true);
  const rows=channelRows(rich.sampling,[{channel:"CH-1",sps:9,name:"온도",connected:true}]);assert.equal(rows.length,2);assert.equal(rows.find(row=>row.name==="온도")!.sps,.5);
});
test("new registrations use the target channel rate instead of another channel's rate",t=>{
  const {svc}=setup(t);svc.upsertBoard({...identity,sampling:sampling()});const sensor=svc.saveSensor({daqUuid:uuid,channel:"CH1",name:"온도",type:"temperature",unit:"°C",position:"출구"});assert.equal(sensor.sps,.5);
});


test("HELLO inventory is supported, STATUS inventory takes precedence, and incomplete metadata can be enriched",t=>{
  const {svc}=setup(t);svc.upsertBoard({...identity,sensors:[{channel:"CH0"}]});const id=svc.snapshot().sensors[0].id;
  const hello={capabilities:["channel_sample_rate"],sampling:sampling(),sensors:[{channel:"CH0",name:"진동",type:"vibration",unit:"g",sps:250}],inventoryComplete:true};
  const normalized=normalizeAcquisitionStatus({uuid,acquiring:true,scan_rate_hz:1000},hello,uuid);assert.equal(normalized.sensors!.length,1);assert.equal(normalized.sampling.channels[1].sps,.5);
  svc.upsertBoard({...identity,sampling:normalized.sampling,sensors:normalized.sensors,inventoryComplete:normalized.inventoryComplete});assert.equal(svc.snapshot().sensors[0].id,id);assert.equal(svc.snapshot().sensors[0].name,"진동");assert.equal(svc.snapshot().sensors[0].type,"vibration");
  assert.equal(normalizeAcquisitionStatus({uuid,acquiring:true,scan_rate_hz:1000,sensors:[]},hello,uuid).sensors!.length,0);
});
test("raw replay does not override explicit sensor disconnection and conflicting rates reject the whole inventory",t=>{
  const {svc,repo}=setup(t);svc.upsertBoard({...identity,sensors:[{channel:"CH0",connected:false}]});svc.ingest({daqUuid:uuid,readings:[{channel:"CH0",timestamp:new Date(Date.now()-10000).toISOString(),value:0,sps:250,raw:[0]}]});assert.equal(svc.snapshot().sensors[0].online,false);
  const before=readFileSync(repo.filename,"utf8");assert.throws(()=>svc.upsertBoard({...identity,sampling:sampling(),sensors:[{channel:"CH0",sps:1000}]}),ApiError);assert.equal(readFileSync(repo.filename,"utf8"),before);
});

test("sensor-only reported rates override uniform fallback without fabricating a total",()=>{
  const result=normalizeAcquisitionStatus({uuid,acquiring:true,scan_rate_hz:1000,sensors:[{channel:"CH0",sps:250},{channel:"CH1",sps:.5}]},{capabilities:[]},uuid);assert.equal(result.sampling.totalRateHz,null);assert.equal(result.sampling.complete,false);assert.deepEqual(result.sampling.channels.map(c=>c.sps),[250,.5]);assert.equal(result.channelRatesReported,true);
});
