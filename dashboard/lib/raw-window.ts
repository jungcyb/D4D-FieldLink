import type {Reading} from "./types.ts";

export interface RawSelection {
  raw:number[]; sps:number|null; timestamp:string|null; batchCount:number;
  expectedCount:number; limited:boolean;
  boundary:"gap"|"overlap"|"rate_change"|"history"|null;
}
/** Join only contiguous, equal-rate received batches. Never generate missing samples. */
export function selectRawWindow(readings:Reading[],seconds:number,maxSamples=65536):RawSelection{
  if(!Number.isFinite(seconds)||seconds<=0||!Number.isInteger(maxSamples)||maxSamples<1)throw new RangeError("유효한 조회 구간과 샘플 한도가 필요합니다.");
  const rows=readings.filter(row=>row.raw.length>0&&Number.isFinite(row.sps)&&row.sps>0&&Number.isFinite(Date.parse(row.timestamp))).toSorted((a,b)=>a.timestamp.localeCompare(b.timestamp));
  const last=rows.at(-1);
  if(!last)return{raw:[],sps:null,timestamp:null,batchCount:0,expectedCount:0,limited:false,boundary:"history"};
  const expectedCount=Math.max(1,Math.ceil(last.sps*seconds)),wanted=Math.min(expectedCount,maxSamples),selected:{row:Reading;offset:number}[]=[];
  let count=0,nextStart:number|null=null,boundary:RawSelection["boundary"]=null;
  // Wire timestamps have millisecond precision; tolerate that rounding only.
  const toleranceMs=2;
  for(let i=rows.length-1;i>=0&&count<wanted;i--){
    const row=rows[i],start=Date.parse(row.timestamp),end=start+row.raw.length/row.sps*1000;
    if(row.sps!==last.sps){boundary="rate_change";break;}
    if(nextStart!==null&&Math.abs(end-nextStart)>toleranceMs){boundary=end<nextStart?"gap":"overlap";break;}
    const take=Math.min(row.raw.length,wanted-count),offset=row.raw.length-take;
    selected.unshift({row,offset});count+=take;nextStart=start;
  }
  if(count<wanted&&!boundary)boundary="history";
  const first=selected[0];
  return{raw:selected.flatMap(({row,offset})=>row.raw.slice(offset)),sps:last.sps,timestamp:new Date(Date.parse(first.row.timestamp)+first.offset/last.sps*1000).toISOString(),batchCount:selected.length,expectedCount,limited:expectedCount>maxSamples,boundary};
}
