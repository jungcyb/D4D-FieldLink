import type {DaqSampling,ChannelSampleRate} from "./daq-types.ts";
import type {Daq,Sensor} from "./types.ts";
export const channelKey=(channel:string)=>channel.trim().replace(/^CH-?(\d+)$/i,(_,index)=>`CH${Number(index)}`);
export function channelRate(daq:Pick<Daq,"sampling"|"scanRateHz">,channel:string):number|null{
  const found=daq.sampling?.channels.find(row=>channelKey(row.channel)===channelKey(channel));
  return found?found.sps:daq.sampling?.commonRateHz??daq.scanRateHz??null;
}
export function channelRows(sampling:DaqSampling|undefined,sensors:Pick<Sensor,"channel"|"sps"|"name"|"connected">[]):(ChannelSampleRate&{name:string;connected:boolean|null})[]{
  const result=new Map<string,ChannelSampleRate&{name:string;connected:boolean|null}>();
  for(const row of sampling?.channels||[])result.set(channelKey(row.channel),{...row,name:"센서 미등록",connected:null});
  for(const sensor of sensors){const key=channelKey(sensor.channel),reported=result.get(key);result.set(key,{channel:sensor.channel,sps:reported?reported.sps:sensor.sps,name:sensor.name,connected:sensor.connected??null});}
  return [...result.values()].sort((a,b)=>a.channel.localeCompare(b.channel,"ko",{numeric:true}));
}
