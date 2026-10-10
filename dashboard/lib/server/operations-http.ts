import {OperationsService,state,systemLog} from "./operations.ts";
import {controlDaq,parseCommand} from "./daq-control.ts";
import {LocationService,clikaStatus} from "./locations.ts";
import {RagService,ragConfig} from "./rag.ts";
import {MaintenanceService} from "./service.ts";
import {check,object,uuid,timestamp,ApiError} from "./validation.ts";
interface Options {request:Request;url:URL;path:string[];svc:MaintenanceService;readJson:()=>Promise<unknown>;bytes:(max:number)=>Promise<Uint8Array>;authorize:()=>void}
const result=(data:unknown,status=200)=>Response.json({data},{status,headers:{"Cache-Control":"no-store"}});
export async function operationsHttp({request,url,path,svc,readJson,bytes,authorize}:Options):Promise<Response|null>{
  const [resource,id,action,detail]=path,method=request.method,ops=new OperationsService(svc.repository),locations=new LocationService(svc.repository);
  if(resource==="daqs"&&action==="acquisition"&&path.length===3&&(method==="GET"||method==="POST")) {
    const key=uuid(id),board=svc.repository.read().daqs.find(d=>d.uuid===key);
    check(board,"DAQ를 찾을 수 없습니다.",404);
    const command=method==="POST"?parseCommand(await readJson()):undefined;
    try {
      const status=await controlDaq(board,command);
      if(command) svc.repository.mutate(store=>{
        for(const sensor of store.sensors.filter(s=>s.daqUuid===key))sensor.sps=status.scan_rate_hz;
        systemLog(store,"DAQ_ACQUISITION_CHANGED",command.action==="rate"?`샘플레이트 변경: 채널당 ${status.scan_rate_hz} SPS`:status.acquiring?"보드 데이터 수집 시작":"보드 데이터 수집 정지",key,"info",{action:command.action,acquiring:status.acquiring,sps:status.scan_rate_hz});
      });
      return result(status);
    } catch(error) {
      if(command) svc.repository.mutate(store=>systemLog(store,"DAQ_CONTROL_UNCONFIRMED","DAQ 제어 미확인 · 현재 수집 상태를 확인하세요.",key,"warning",{action:command.action,message:error instanceof Error?error.message:"통신 실패"}));
      throw error;
    }
  }
  if(resource==="rag"&&path.length===2){
    if(method==="GET"&&id==="config")return result(ragConfig());
    if(method==="GET"&&id==="context"){const raw=url.searchParams.get("includeRawPreview")||"false";check(raw==="true"||raw==="false","includeRawPreview는 true/false여야 합니다.");const ids=url.searchParams.get("sensorIds");return result(new RagService(svc.repository).context({daqUuid:url.searchParams.get("daqUuid"),...(ids!==null?{sensorIds:ids.split(",").filter(Boolean)}:{}),batchesPerSensor:Number(url.searchParams.get("batchesPerSensor")||5),includeRawPreview:raw==="true"}));}
    if(method==="POST"&&id==="query")return result(await new RagService(svc.repository).query(await readJson(),fetch,request.signal));
  }
  if(method==="GET"&&resource==="clika"&&id==="status"&&path.length===2)return result(await clikaStatus());
  if(method==="GET"&&resource==="operations"&&path.length===1)return result(ops.snapshot(svc.snapshot()));
  if(method==="GET"&&resource==="logs"&&path.length===1){svc.advanceDemo();ops.reconcile();return result(ops.logs(url));}
  if(method==="GET"&&resource==="edge"&&id==="recovery"&&path.length===2){authorize();const key=uuid(url.searchParams.get("daqUuid"));const snapshot=ops.snapshot(svc.snapshot());return result(snapshot.recoveries.filter(p=>p.daqUuid===key&&["pending","receiving"].includes(p.status)));}
  if(method==="POST"&&resource==="edge"&&id==="heartbeat"&&path.length===2){authorize();return result(ops.heartbeat(uuid(object(await readJson()).daqUuid)));}
  if(method==="POST"&&resource==="edge"&&id==="logs"&&path.length===2){authorize();ops.reconcile();const accepted=ops.ingestLogs(await readJson());ops.reconcile();return result(accepted,202);}
  if(method==="PATCH"&&resource==="daqs"&&action==="recovery-policy"&&path.length===3)return result(ops.savePolicy(uuid(id),await readJson()));
  if(method==="POST"&&resource==="recoveries"&&path.length===1)return result(ops.createPlan(uuid(object(await readJson()).daqUuid)),201);
  if(method==="POST"&&resource==="recoveries"&&action==="cancel"&&path.length===3)return result(ops.cancelPlan(id));
  if(method==="POST"&&resource==="recoveries"&&action==="batches"&&path.length===3){authorize();return result(ops.receiveBatch(id,await readJson()),202);}
  if(method==="POST"&&resource==="recoveries"&&action==="complete"&&path.length===3){authorize();return result(ops.completePlan(id,await readJson()));}
  if(method==="GET"&&resource==="recoveries"&&action==="batches"&&path.length===4){const sequence=Number(detail);check(Number.isInteger(sequence)&&sequence>=0,"배치 순서를 확인해 주세요.");const archive=ops.archive(id,sequence);return new Response(archive.bytes,{headers:{"Content-Type":"application/gzip","Content-Disposition":`attachment; filename="${archive.filename}"`,"Cache-Control":"no-store"}});}
  if(method==="GET"&&resource==="recoveries"&&action==="manifest"&&path.length===3){const plan=state(svc.repository.read()).recoveries.find(p=>p.id===id);check(plan,"복구 요청을 찾을 수 없습니다.",404);return result(plan);}
  if(method==="GET"&&resource==="exports"&&id==="range"&&path.length===2){const key=uuid(url.searchParams.get("daqUuid")),from=timestamp(url.searchParams.get("from")),to=timestamp(url.searchParams.get("to")),raw=url.searchParams.get("raw")||"true",logs=url.searchParams.get("logs")||"true";check([raw,logs].every(value=>value==="true"||value==="false"),"raw와 logs는 true/false여야 합니다.");const archive=ops.exportRange(key,from,to,raw==="true",logs==="true");return new Response(archive.bytes,{headers:{"Content-Type":"application/gzip","Content-Disposition":`attachment; filename="${archive.filename}"`,"Cache-Control":"no-store","X-Export-Raw-Batches":String(archive.manifest.counts.rawBatches),"X-Export-Logs":String(archive.manifest.counts.logs)}});}
  if(method==="POST"&&resource==="dependencies"&&path.length===1)return result(ops.saveDependency(await readJson()),201);
  if(method==="DELETE"&&resource==="dependencies"&&path.length===2)return result(ops.removeDependency(id));
  if(method==="POST"&&resource==="incidents"&&id==="merge"&&path.length===2)return result(ops.mergeIncidents(await readJson()),201);
  if(method==="POST"&&resource==="incidents"&&action==="acknowledge"&&path.length===3)return result(ops.acknowledgeIncident(id));
  if(method==="POST"&&resource==="daqs"&&action==="location-inputs"&&path.length===3){const contentType=request.headers.get("content-type")||"";check(contentType.startsWith("multipart/form-data"),"multipart 자료 업로드가 필요합니다.",415);let form:FormData;try{form=await new Request(url,{method:"POST",headers:{"Content-Type":contentType},body:new Uint8Array(await bytes(21*1048576))}).formData();}catch{throw new ApiError(400,"자료 업로드 요청 형식이 올바르지 않습니다.");}const files=form.getAll("files");check(files.every(file=>file instanceof File),"files 필드로 파일을 업로드하세요.");const inputs=await Promise.all((files as File[]).map(async f=>({filename:f.name,mime:f.type,bytes:Buffer.from(await f.arrayBuffer())})));return result(locations.upload(uuid(id),inputs),201);}
  if(method==="GET"&&resource==="location-inputs"&&path.length===2){const item=locations.attachment(id);return new Response(item.bytes,{headers:{"Content-Type":item.input.mime,"Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(item.input.filename)}`,"X-Content-Type-Options":"nosniff","Cache-Control":"private, max-age=3600"}});}
  if(method==="POST"&&resource==="daqs"&&action==="location-analysis"&&path.length===3)return result(await locations.analyze(uuid(id),await readJson()),201);
  if(method==="POST"&&resource==="location-analyses"&&action==="approve"&&path.length===3)return result(locations.approve(id,await readJson()));
  return null;
}
