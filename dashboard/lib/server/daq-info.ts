import {randomUUID} from "node:crypto";
import type {DaqSampling,EdgeDaqInfo,EdgeSensorInfo} from "../daq-types.ts";
import type {Daq,Store} from "../types.ts";
import {channelKey,channelRate} from "../daq-sampling.ts";
import {check,object,text,numeric,choice,timestamp} from "./validation.ts";
const now=()=>new Date().toISOString();
const optionalRate=(value:unknown,label:string)=>value==null?null:numeric(value,label,0,1000000);
export function parseSampling(input:unknown):DaqSampling{
  const row=object(input);check(row.complete===undefined||typeof row.complete==="boolean","sampling.complete는 boolean이어야 합니다.");
  const complete=row.complete!==false;check(Array.isArray(row.channels)&&row.channels.length<=100,"sampling.channels는 최대 100개 배열이어야 합니다.");
  const channels=row.channels.map(item=>{const channel=object(item);return{channel:text(channel.channel,"채널",40),sps:optionalRate(channel.sps,"채널 SPS")};});
  check(new Set(channels.map(row=>channelKey(row.channel))).size===channels.length,"중복 채널 샘플레이트가 있습니다.");
  const commonRateHz=optionalRate(row.commonRateHz,"공통 SPS"),sum=channels.reduce((total,row)=>total+(row.sps??0),0),canSum=complete&&channels.every(row=>row.sps!=null);
  const supplied=row.totalRateHz==null?null:numeric(row.totalRateHz,"전체 samples/s",0,100000000);
  check(supplied==null||!canSum||Math.abs(supplied-sum)<=Math.max(1e-6,sum*1e-9),"전체 샘플레이트와 채널별 합계가 일치하지 않습니다.");
  return{commonRateHz,totalRateHz:supplied??(canSum?sum:null),channels,complete,mode:"per-channel",totalSource:supplied!=null?"board":canSum?"sum":"unknown",updatedAt:row.timestamp==null?now():timestamp(row.timestamp)};
}
export function parseDaqInfo(data:Record<string,unknown>):EdgeDaqInfo{
  const result:EdgeDaqInfo={};
  if(data.sampling!==undefined)result.sampling=parseSampling(data.sampling);
  if(data.inventoryComplete!==undefined){check(typeof data.inventoryComplete==="boolean","inventoryComplete는 boolean이어야 합니다.");result.inventoryComplete=data.inventoryComplete;}
  if(data.sensors!==undefined){
    check(Array.isArray(data.sensors)&&data.sensors.length<=100,"sensors는 최대 100개 배열이어야 합니다.");
    result.sensors=data.sensors.map(input=>{const row=object(input),sensor:EdgeSensorInfo={channel:text(row.channel,"센서 채널",40)};
      if(row.edgeId!==undefined)sensor.edgeId=text(row.edgeId,"보드 센서 ID",200);
      if(row.name!==undefined)sensor.name=text(row.name,"센서명");
      if(row.type!==undefined)sensor.type=choice(row.type,["analog","vibration","temperature","current"] as const,"센서 종류");
      if(row.unit!==undefined)sensor.unit=text(row.unit,"단위",20);
      if(row.position!==undefined)sensor.position=text(row.position,"부착 위치");
      if(row.sps!==undefined)sensor.sps=optionalRate(row.sps,"센서 SPS");
      if(row.connected!==undefined){check(typeof row.connected==="boolean","센서 connected는 boolean이어야 합니다.");sensor.connected=row.connected;}
      return sensor;
    });
    check(new Set(result.sensors.map(s=>channelKey(s.channel))).size===result.sensors.length,"중복 센서 채널이 있습니다.");
    const ids=result.sensors.flatMap(s=>s.edgeId?[s.edgeId]:[]);check(new Set(ids).size===ids.length,"중복 보드 센서 ID가 있습니다.");
  }
  if(result.sampling&&result.sensors)for(const sensor of result.sensors){const rate=result.sampling.channels.find(row=>channelKey(row.channel)===channelKey(sensor.channel));check(sensor.sps===undefined||!rate||sensor.sps===rate.sps,"센서 SPS와 해당 채널의 sampling SPS가 일치하지 않습니다.");}
  return result;
}
export function applyDaqInfo(store:Store,daq:Daq,info:EdgeDaqInfo){
  if(info.sampling&&(!daq.sampling||info.sampling.updatedAt>=daq.sampling.updatedAt)){
    // A partial list must never become a claimed full-device total.
    daq.sampling=info.sampling;
    if(info.sampling.commonRateHz!=null)daq.scanRateHz=info.sampling.commonRateHz;
    for(const sensor of store.sensors.filter(s=>s.daqUuid===daq.uuid)){
      const reported=info.sampling.channels.find(c=>channelKey(c.channel)===channelKey(sensor.channel));
      if(reported)sensor.sps=reported.sps;
      else if(info.sampling.mode==="uniform")sensor.sps=info.sampling.commonRateHz;
    }
  }
  if(info.sensors){
    if(info.inventoryComplete)for(const sensor of store.sensors.filter(s=>s.daqUuid===daq.uuid))sensor.connected=false;
    for(const row of info.sensors){
      let sensor=store.sensors.find(s=>s.daqUuid===daq.uuid&&channelKey(s.channel)===channelKey(row.channel));
      if(row.edgeId)check(!store.sensors.some(s=>s.daqUuid===daq.uuid&&s.edgeId===row.edgeId&&s.id!==sensor?.id),"이 보드 센서 ID가 다른 채널에 등록돼 있습니다.",409);
      if(sensor){
        if(sensor.registrationSource==="edge"){
          if(row.name)sensor.name=row.name;
          if(row.type)sensor.type=row.type;
          if(row.position)sensor.position=row.position;
          if(row.unit&&!sensor.calibration.updatedAt){sensor.unit=row.unit;sensor.calibration.inputUnit=row.unit;}
        }
        if(row.edgeId&&sensor.edgeId&&row.edgeId!==sensor.edgeId){const hasHistory=store.readings.some(r=>r.sensorId===sensor!.id)||store.diagnoses.some(d=>d.sensorId===sensor!.id);check(!hasHistory,"이력이 있는 채널의 센서 ID를 변경할 수 없습니다.",409);}
        if(row.edgeId)sensor.edgeId=row.edgeId;
        if(row.sps!==undefined)sensor.sps=row.sps;
        sensor.connected=row.connected??true;
      }else{
        sensor={id:randomUUID(),registrationSource:"edge",daqUuid:daq.uuid,channel:row.channel,edgeId:row.edgeId,name:row.name||row.channel,type:row.type||"analog",position:row.position||"부착 위치 미등록",unit:row.unit||"V",sps:row.sps!==undefined?row.sps:channelRate(daq,row.channel),connected:row.connected??true,calibration:{scale:1,offset:0,inputUnit:row.unit||"V",updatedAt:null},photo:null,createdAt:now()};store.sensors.push(sensor);
      }
    }
  }
}
