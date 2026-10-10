import {test} from "node:test";
import type {TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join,resolve,basename} from "node:path";
import {tmpdir} from "node:os";
import {FileRepository} from "../lib/server/repository.ts";
import {MaintenanceService} from "../lib/server/service.ts";
import {OperationsService} from "../lib/server/operations.ts";
import {RagService} from "../lib/server/rag.ts";
import {retrieve} from "../lib/server/retrieval.ts";
import {formatLifetime,predictionFields} from "../lib/prediction.ts";
import {ApiError} from "../lib/server/validation.ts";
const daqUuid="11111111-2222-4333-8444-555555555555";
function setup(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),"fieldlink-v03-test-"));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir()))&&basename(dir).startsWith("fieldlink-v03-test-"));rmSync(dir,{recursive:true,force:true});});
  const repo=new FileRepository(dir,"external"),svc=new MaintenanceService(repo);svc.upsertBoard({uuid:daqUuid,label:"DAQ",ip:"127.0.0.1",port:9000});
  const equipment=svc.saveEquipment({name:"펌프",category:"pump",location:"시험실"});svc.bindBoard(daqUuid,{equipmentId:equipment.id});
  const sensor=svc.saveSensor({daqUuid,channel:"CH0",name:"진동",type:"vibration",position:"베어링",unit:"g",sps:1000});
  const temperature=svc.saveSensor({daqUuid,channel:"CH1",name:"온도",type:"temperature",position:"출구",unit:"°C",sps:1});
  const prediction=(anomaly=true,rul:number|null=120)=>({profile_id:"pump/vibration/v1",anomaly_detection:{status:"ok",profile_id:"pump/vibration/v1",model_version:"if-001",anomaly_score:anomaly ? 0.62 : 0.4,threshold:.59,is_anomaly:anomaly},rul:rul===null?{status:"unavailable",estimated_rul_hours:null,reason:"no_approved_run_to_failure_model"}:{status:"available",estimated_rul_hours:rul,uncertainty_status:"not_calibrated"},fault_classification:{status:"ok",predicted_class:"bearing_fault",probabilities:{normal:.1,bearing_fault:.9},probabilities_calibrated:false}});
  const frame=()=>({daqUuid,frameId:"prediction-1",schema_version:"edge_prediction_v0.3",equipment_id:equipment.id,sensor_map:{vibration:sensor.id,temperature:temperature.id},sensors:{vibration:prediction(),temperature:prediction(false,null)},equipment_rul:{status:"unavailable",reason:"no_equipment_level_fusion_model"},maintenance_priority:{status:"not_computed",owner:"backend_policy"}});
  return {repo,svc,equipment,sensor,temperature,prediction,frame};
}
test("v0.3 persists sensor RUL and independent scores without inventing equipment RUL or probability",t=>{
  const {svc,repo,frame,sensor,temperature}=setup(t);assert.deepEqual(svc.ingest(frame()),{accepted:0,diagnoses:2,duplicate:false});
  const snapshot=new MaintenanceService(new FileRepository(repo.directory,"external")).snapshot(),v=snapshot.sensors.find(s=>s.id===sensor.id)!.diagnosis!,temp=snapshot.sensors.find(s=>s.id===temperature.id)!.diagnosis!;
  assert.equal(v.rulHours,120);assert.equal(formatLifetime(v),"120시간");assert.equal(v.confidence,null);assert.equal(v.severity,"warning");assert.equal(v.edgePrediction!.fault_classification.status,"ok");
  assert.equal(temp.rulHours,null);assert.equal(formatLifetime(temp),"추정 불가");assert.equal(temp.severity,"normal");assert.equal(snapshot.equipment[0].rulHours,null);assert.equal(snapshot.equipment[0].edgePrediction!.equipment_rul.status,"unavailable");assert.equal(snapshot.tasks.length,0);
  assert.deepEqual(svc.ingest(frame()),{accepted:0,diagnoses:0,duplicate:true});
  const fields=predictionFields(v);assert.match(fields.find(f=>f.label==="이상 탐지")!.value,/0.62.*0.59.*미보정/);assert.match(fields.find(f=>f.label==="분류 점수 보정")!.value,/미래 고장 확률이 아님/);
});
test("invalid prediction identity, mapping and partial model output are rejected atomically",t=>{
  const {svc,repo,frame}=setup(t);const before=readFileSync(repo.filename,"utf8");
  for(const mutate of [
    (f:ReturnType<typeof frame>)=>{f.equipment_id="wrong";},
    (f:ReturnType<typeof frame>)=>{f.sensor_map.vibration="unregistered";},
    (f:ReturnType<typeof frame>)=>{f.sensor_map.temperature=f.sensor_map.vibration;},
    (f:ReturnType<typeof frame>)=>{f.sensors.vibration.anomaly_detection.profile_id="other";},
    (f:ReturnType<typeof frame>)=>{f.sensors.vibration.rul.estimated_rul_hours=-1;},
    (f:ReturnType<typeof frame>)=>{f.sensors.temperature.rul.estimated_rul_hours=0;},
    (f:ReturnType<typeof frame>)=>{f.sensors.vibration.fault_classification.probabilities.normal=NaN;},
    (f:ReturnType<typeof frame>)=>{f.sensors.vibration.anomaly_detection.is_anomaly=1 as unknown as boolean;},
  ]){const f=frame();mutate(f);assert.throws(()=>svc.ingest(f),ApiError);assert.equal(readFileSync(repo.filename,"utf8"),before);}
});
test("model error remains unknown and RUL zero is retained; replay cannot replace newer metadata",t=>{
  const {svc,frame,repo,sensor}=setup(t);const f=frame();f.sensors.vibration= {...f.sensors.vibration,rul:{status:"available",estimated_rul_hours:0,uncertainty_status:"not_calibrated"}};
  const recent=new Date(Date.now()-1000).toISOString(),older=new Date(Date.now()-2000).toISOString(),replay=new Date(Date.now()-3000).toISOString();
  svc.ingest({...f,timestamp:older});assert.equal(formatLifetime(svc.snapshot().sensors.find(s=>s.id===sensor.id)!.diagnosis),"0시간");
  const error={profile_id:"pump/vibration/v1",anomaly_detection:{status:"error",reason:"rate_mismatch"},rul:{status:"unavailable",estimated_rul_hours:null,reason:"no_model"},fault_classification:{status:"unavailable",reason:"no_model"}};
  svc.ingest({...f,frameId:"new",timestamp:recent,sensors:{vibration:error}});
  const snapshot=svc.snapshot();assert.equal(snapshot.sensors.find(s=>s.id===sensor.id)!.diagnosis!.severity,"unknown");assert.equal(snapshot.equipment[0].severity,"unknown");assert.equal(new OperationsService(repo).snapshot(snapshot).incidents.length,0);
  svc.ingest({...f,frameId:"replay",timestamp:replay});assert.equal(repo.read().equipment[0].edgePrediction!.timestamp,recent);
});
test("RAG includes v0.3 status plus engineering-unit batch statistics after calibration",t=>{
  const {svc,repo,sensor,frame}=setup(t);svc.calibrateSensor(sensor.id,{scale:2,offset:10,inputUnit:"V"});
  svc.ingest({daqUuid,readings:[{channel:"CH0",timestamp:new Date().toISOString(),value:2,sps:1000,raw:[1,2,3]}]});svc.ingest(frame());
  const envelope=new RagService(repo).context({daqUuid,sensorIds:[sensor.id],includeRawPreview:true});
  assert.equal(envelope.context.status.sensors[0].latestValue,14);assert.equal(envelope.context.batches[0].value,14);assert.equal(envelope.context.batches[0].rawSummary!.min,12);assert.equal(envelope.context.batches[0].rawSummary!.max,16);assert.equal(repo.read().readings[0].value,2);
  const source=retrieve(envelope,"진동 예상 수명").find(c=>c.source.kind==="sensor")!;assert.match(source.content,/120시간/);assert.match(source.content,/미보정/);assert.ok(!source.content.includes("오류 탐지 확률"));assert.equal(source.source.fields!.find(f=>f.label==="RUL 상태")!.value,"추정 제공 · 불확실성 not_calibrated");
});
