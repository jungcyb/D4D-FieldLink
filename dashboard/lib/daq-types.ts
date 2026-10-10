import type {SensorType} from "./types.ts";
export interface ChannelSampleRate {channel:string;sps:number|null}
export interface DaqSampling {commonRateHz:number|null;totalRateHz:number|null;channels:ChannelSampleRate[];complete:boolean;mode:"uniform"|"per-channel";totalSource:"board"|"sum"|"unknown";updatedAt:string}
export interface EdgeSensorInfo {channel:string;edgeId?:string;name?:string;type?:SensorType;unit?:string;position?:string;sps?:number|null;connected?:boolean}
export interface EdgeDaqInfo {sampling?:DaqSampling;sensors?:EdgeSensorInfo[];inventoryComplete?:boolean}
