import type {DaqSampling,ChannelSampleRate} from "./daq-types.ts";
import type {Daq,Sensor,DaqChannel,SampleRateGroup} from "./types.ts";
export const channelKey=(channel:string)=>channel.trim().replace(/^CH-?(\d+)$/i,(_,index)=>`CH${Number(index)}`);
export function channelRate(daq:Pick<Daq,"sampling"|"scanRateHz"|"channels">,channel:string):number|null{
  const found=daq.sampling?.channels.find(row=>channelKey(row.channel)===channelKey(channel));
  return found?found.sps:daq.channels?.find(row=>channelKey(row.id)===channelKey(channel))?.sampleRateHz??daq.sampling?.commonRateHz??daq.scanRateHz??null;
}
export function channelRows(sampling:DaqSampling|undefined,sensors:Pick<Sensor,"channel"|"sps"|"name"|"connected">[]):(ChannelSampleRate&{name:string;connected:boolean|null})[]{
  const result=new Map<string,ChannelSampleRate&{name:string;connected:boolean|null}>();
  for(const row of sampling?.channels||[])result.set(channelKey(row.channel),{...row,name:"센서 미등록",connected:null});
  for(const sensor of sensors){const key=channelKey(sensor.channel),reported=result.get(key);result.set(key,{channel:sensor.channel,sps:reported?reported.sps:sensor.sps,name:sensor.name,connected:sensor.connected??null});}
  return [...result.values()].sort((a,b)=>a.channel.localeCompare(b.channel,"ko",{numeric:true}));
}

/** Hardware groups define which channels must change together. */
export function rateInGroup(group:SampleRateGroup,rate:number):boolean{
  if(!group.writable||!Number.isFinite(rate)||rate<=0||group.minHz==null||group.maxHz==null||rate<group.minHz||rate>group.maxHz)return false;
  if(group.stepHz==null)return true;
  const steps=(rate-group.minHz)/group.stepHz;return Number.isFinite(steps)&&Math.abs(steps-Math.round(steps))<=1e-9;
}
export function samplingFromCapabilities(capabilities:{channels:DaqChannel[]}):DaqSampling{
  const channels=capabilities.channels.map(row=>({channel:row.id,sps:row.sampleRateHz})),first=channels[0]?.sps??null;
  return{channels,commonRateHz:channels.length>0&&channels.every(row=>row.sps===first)?first:null,totalRateHz:channels.reduce((total,row)=>total+row.sps,0),complete:true,mode:"per-channel",totalSource:"sum",updatedAt:new Date().toISOString()};
}
