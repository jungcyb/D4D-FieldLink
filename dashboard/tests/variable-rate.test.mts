import {test} from "node:test";
import type {TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,basename} from "node:path";
import {FileRepository} from "../lib/server/repository.ts";
import {MaintenanceService} from "../lib/server/service.ts";
import {RagService} from "../lib/server/rag.ts";
import {sampleTimeMs,sampleDurationMs,formatSampleRate} from "../lib/sampling.ts";
const daqUuid="11111111-2222-4333-8444-555555555555";
function setup(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),"fieldlink-rate-test-"));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir()))&&basename(dir).startsWith("fieldlink-rate-test-"));rmSync(dir,{recursive:true,force:true});});
  const repo=new FileRepository(dir,"external"),svc=new MaintenanceService(repo);svc.upsertBoard({uuid:daqUuid,label:"DAQ",ip:"127.0.0.1",port:9000});
  const sensor=svc.saveSensor({daqUuid,channel:"CH0",name:"아날로그",type:"analog",position:"입력",unit:"V"});return{svc,repo,sensor};
}
test("registration has no fabricated 1000 SPS; known board rate is inherited and edits preserve received rate",t=>{
  const {svc,repo,sensor}=setup(t);assert.equal(sensor.sps,null);assert.equal(formatSampleRate(sensor.sps),"샘플레이트 확인 대기");
  repo.mutate(s=>{s.daqs[0].scanRateHz=250;});
  const next=svc.saveSensor({daqUuid,channel:"CH1",name:"두번째",type:"analog",position:"입력",unit:"V"});assert.equal(next.sps,250);
  svc.ingest({daqUuid,readings:[{channel:"CH0",timestamp:new Date().toISOString(),value:2,sps:1800,raw:[1,2,3]}]});
  assert.equal(svc.saveSensor({...sensor,name:"이름 변경",sps:1000},sensor.id).sps,1800);
});
test("rate changes preserve historical rate, time axis and RAG end times including sub-Hz data",t=>{
  const {svc,repo,sensor}=setup(t),start=Date.now()-30000;
  for(const [i,sps] of [0.5,250,1800].entries())svc.ingest({daqUuid,frameId:`r-${i}`,readings:[{channel:"CH0",timestamp:new Date(start+i*10000).toISOString(),value:1,sps,raw:[1,2,3]}]});
  const readings=svc.telemetry(sensor.id);assert.deepEqual(readings.map(r=>r.sps),[.5,250,1800]);assert.equal(svc.rawWindow(sensor.id).sps,1800);assert.equal(svc.snapshot().sensors[0].sps,1800);
  const batches=new RagService(repo).context({daqUuid,sensorIds:[sensor.id],batchesPerSensor:3}).context.batches;
  for(const batch of batches)assert.ok(Math.abs(Date.parse(batch.endTimestamp)-Date.parse(batch.timestamp)-sampleDurationMs(batch.sampleCount,batch.sps))<1);
  svc.ingest({daqUuid,readings:[{channel:"CH0",timestamp:new Date(start-1000).toISOString(),value:0,sps:1000,raw:[0]}]});assert.equal(svc.snapshot().sensors[0].sps,1800);
});
test("raw plotting/CSV share actual SPS time conversion and reject an unknown or invalid rate",()=>{
  assert.equal(sampleTimeMs(125,250),500);assert.equal(sampleTimeMs(900,1800),500);assert.equal(sampleTimeMs(1,.5),2000);assert.equal(sampleDurationMs(250,250),996);
  assert.equal(sampleDurationMs(0,100),0);for(const rate of [0,-1,NaN,Infinity])assert.throws(()=>sampleTimeMs(1,rate),RangeError);
});
