import {randomUUID} from "node:crypto";
import {posix} from "node:path";
import type {Store} from "../types.ts";
import type {TrainingJob,CandidateReport,TrainingJobSummary} from "../training-types.ts";
import {FileRepository} from "./repository.ts";
import {state,systemLog} from "./operations.ts";
import {sensorBinding,bindingHash} from "./training-binding.ts";
import {check,object,text,numeric,uuid} from "./validation.ts";
const now=()=>new Date().toISOString();
const jobs=(store:Store)=>store.anomalyTraining??=([] as TrainingJob[]);
function binding(store:Store,id:string){const sensor=store.sensors.find(s=>s.id===id);check(sensor,"센서를 찾을 수 없습니다.",404);const daq=store.daqs.find(d=>d.uuid===sensor.daqUuid);check(daq,"DAQ를 찾을 수 없습니다.",404);return sensorBinding(sensor,daq);}
function find(store:Store,id:string){const job=jobs(store).find(j=>j.id===id);check(job,"학습 요청을 찾을 수 없습니다.",404);return job;}
function candidate(input:unknown):CandidateReport{
  const row=object(input),raw=object(row.splits),splits={} as CandidateReport["splits"],sessions=new Set<string>(),files=new Set<string>();
  for(const name of ["train","calibration","test"] as const){
    const split=object(raw[name]),windows=numeric(split.windows,`${name} 윈도우 수`,20,50000);check(Number.isInteger(windows),"윈도우 수는 정수여야 합니다.");
    check(Array.isArray(split.sessions)&&split.sessions.length>0&&split.sessions.length<=50000,`${name} 세션 목록이 필요합니다.`);
    check(Array.isArray(split.files)&&split.files.length===windows,`${name} 윈도우 파일 목록과 수가 일치해야 합니다.`);
    const group=split.sessions.map(s=>text(s,"세션 ID",200)),paths=split.files.map(f=>posix.normalize(text(f,"NPZ 식별자",500).replaceAll("\\","/")));
    check(new Set(group).size===group.length,"분할 내부 세션 목록이 중복됩니다.");
    for(const session of group){check(!sessions.has(session),"train/calibration/test 사이 세션을 분리해야 합니다.");sessions.add(session);}
    for(const file of paths){check(file.endsWith(".npz")&&!files.has(file),"NPZ 파일이 중복되거나 형식이 잘못됐습니다.");files.add(file);}
    splits[name]={windows,sessions:group,files:paths};
  }
  return{modelVersion:text(row.modelVersion,"모델 버전",200),profileId:text(row.profileId,"프로필 ID",300),configurationHash:text(row.configurationHash,"ML 설정 해시",128),threshold:numeric(row.threshold,"임계값",-Number.MAX_VALUE,Number.MAX_VALUE),normalTestFalseAlarmRate:numeric(row.normalTestFalseAlarmRate,"정상 test 오경보율",0,1),datasetDigest:text(row.datasetDigest,"데이터 해시",128),splits};
}
export function trainingSummary(job:TrainingJob):TrainingJobSummary{
  const c=job.candidate;return{...job,candidate:c?{...c,splits:{train:{windows:c.splits.train.windows,sessionCount:c.splits.train.sessions.length},calibration:{windows:c.splits.calibration.windows,sessionCount:c.splits.calibration.sessions.length},test:{windows:c.splits.test.windows,sessionCount:c.splits.test.sessions.length}}}:null};
}
export class AnomalyTrainingService{
  repo:FileRepository; constructor(repo:FileRepository){this.repo=repo;}
  history(sensorId:string){const store=this.repo.read();const currentBindingHash=bindingHash(binding(store,sensorId));return{currentBindingHash,jobs:jobs(store).filter(j=>j.sensorId===sensorId).toReversed().map(trainingSummary),approvals:state(store).normalRanges.filter(a=>a.sensorId===sensorId).toReversed(),executionOwner:"daq" as const};}
  request(sensorId:string,input:unknown){const row=object(input),approvalId=text(row.approvalId,"정상 기간 승인 ID");return this.repo.mutate(store=>{
    const config=binding(store,sensorId),hash=bindingHash(config),approval=state(store).normalRanges.find(a=>a.id===approvalId&&a.sensorId===sensorId);
    check(approval,"사용자가 승인한 정상 기간이 필요합니다.",409);check(approval.bindingHash===hash,"센서 설정이 변경됐거나 이전 형식의 승인입니다. 정상 기간을 다시 승인하세요.",409);
    const existing=jobs(store).find(j=>j.approvalId===approvalId&&j.status!=="failed");if(existing)return existing;
    check(!jobs(store).some(j=>j.sensorId===sensorId&&["queued","training","activation_requested"].includes(j.status)),"진행 중인 학습·활성화 요청을 먼저 완료하세요.",409);
    check(jobs(store).length<200,"학습 요청 보관 한도에 도달했습니다.",409);
    const job:TrainingJob={id:randomUUID(),sensorId,daqUuid:config.daqUuid,approvalId,from:approval.from,to:approval.to,binding:config,bindingHash:hash,status:"queued",createdAt:now(),updatedAt:now(),candidate:null,error:null,activationRequestId:null,requestedAction:null,previousActiveId:null,demo:store.mode==="demo"};jobs(store).push(job);
    systemLog(store,"ANOMALY_TRAINING_REQUESTED","승인된 정상 기간의 보드 학습을 요청했습니다.",job.daqUuid,"info",{jobId:job.id,approvalId,sensorId,from:job.from,to:job.to,demo:job.demo});return job;
  });}
  queue(daqUuid:string){const store=this.repo.read();check(store.daqs.some(d=>d.uuid===daqUuid),"DAQ를 찾을 수 없습니다.",404);return jobs(store).filter(j=>j.daqUuid===daqUuid&&["queued","training","activation_requested"].includes(j.status)).map(j=>({...trainingSummary(j),schemaVersion:"fieldlink.edge-training.v1",action:j.status==="activation_requested"?j.requestedAction:"train",dataLabel:"normal",rawSource:"daq_ring",minimumWindowsPerSplit:20,splitPolicy:"disjoint_sessions_and_files",serverDataUrl:`/api/edge/training-jobs/${j.id}/data?daqUuid=${j.daqUuid}`}));}
  data(id:string,daqUuid:string){const store=this.repo.read(),job=find(store,id);check(job.daqUuid===daqUuid,"다른 DAQ의 학습 데이터입니다.",403);return job;}
  activate(id:string,input:unknown){const row=object(input);check(row.confirmActivation===true,"후보 검토 후 명시적인 활성화 승인이 필요합니다.");return this.repo.mutate(store=>{
    const job=find(store,id);check(job.candidate&&["candidate","superseded"].includes(job.status),"검증된 학습 후보만 활성화할 수 있습니다.",409);
    check(bindingHash(binding(store,job.sensorId))===job.bindingHash,"학습 후 센서 설정이 변경되어 재학습이 필요합니다.",409);
    check(!jobs(store).some(j=>j.sensorId===job.sensorId&&["queued","training","activation_requested"].includes(j.status)),"진행 중인 요청이 있습니다.",409);
    job.previousActiveId=jobs(store).find(j=>j.sensorId===job.sensorId&&j.status==="active")?.id??null;
    job.requestedAction=job.status==="superseded"?"rollback":"activate";job.status="activation_requested";job.activationRequestId=randomUUID();job.updatedAt=now();job.error=null;
    systemLog(store,"ANOMALY_ACTIVATION_REQUESTED","사용자가 모델 적용을 승인했습니다. 보드 응답 대기 중입니다.",job.daqUuid,"info",{jobId:id,activationRequestId:job.activationRequestId,action:job.requestedAction});return job;
  });}
  report(id:string,input:unknown){const row=object(input),daqUuid=uuid(row.daqUuid);return this.repo.mutate(store=>{
    const job=find(store,id);check(job.daqUuid===daqUuid,"다른 DAQ의 학습 요청입니다.",403);check(row.bindingHash===job.bindingHash,"학습 센서 바인딩이 일치하지 않습니다.",409);
    if(row.status==="training"){check(["queued","training"].includes(job.status),"학습 시작을 보고할 수 없는 상태입니다.",409);job.status="training";}
    else if(row.status==="failed"){
      check(["queued","training","activation_requested"].includes(job.status),"실패를 보고할 수 없는 상태입니다.",409);
      if(job.status==="activation_requested")check(row.activationRequestId===job.activationRequestId,"활성화 요청 ID가 일치하지 않습니다.",409);
      job.error=text(row.error,"실패 사유",1000);job.status=job.candidate?"candidate":"failed";
    }else if(row.status==="candidate"){
      const parsed=candidate(row.candidate);check(["queued","training","candidate"].includes(job.status),"후보 결과를 보고할 수 없는 상태입니다.",409);
      if(job.candidate)check(JSON.stringify(job.candidate)===JSON.stringify(parsed),"기존 후보 결과를 변경할 수 없습니다.",409);job.candidate=parsed;job.status="candidate";job.error=null;
    }else if(row.status==="active"){
      check(job.candidate&&["activation_requested","active"].includes(job.status),"사용자가 활성화를 승인하지 않았습니다.",409);
      check(row.activationRequestId===job.activationRequestId&&row.modelVersion===job.candidate.modelVersion&&row.configurationHash===job.candidate.configurationHash,"활성화 요청·모델·설정이 일치하지 않습니다.",409);
      check(bindingHash(binding(store,job.sensorId))===job.bindingHash,"센서 설정이 변경되어 활성화를 완료할 수 없습니다.",409);
      for(const previous of jobs(store))if(previous.sensorId===job.sensorId&&previous.id!==job.id&&previous.status==="active")previous.status="superseded";
      job.status="active";job.error=null;
    }else check(false,"지원하지 않는 학습 상태입니다.");
    job.updatedAt=now();systemLog(store,"ANOMALY_TRAINING_UPDATED",`보드 모델 상태: ${job.status}`,job.daqUuid,job.error?"warning":"info",{jobId:id,status:job.status,error:job.error});return job;
  });}
}
