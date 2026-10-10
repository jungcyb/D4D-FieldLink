/** Sampling rate belongs to each immutable received batch, not the dashboard refresh timer. */
export function sampleTimeMs(index:number,sps:number):number{
  if(!Number.isFinite(index)||index<0||!Number.isFinite(sps)||sps<=0)throw new RangeError("유효한 샘플 인덱스와 실제 SPS가 필요합니다.");
  return index*1000/sps;
}
export function sampleDurationMs(count:number,sps:number):number{
  if(!Number.isInteger(count)||count<0)throw new RangeError("샘플 수는 0 이상 정수여야 합니다.");
  return sampleTimeMs(Math.max(0,count-1),sps);
}
export function formatSampleRate(sps:number|null|undefined):string{
  return sps==null?"샘플레이트 확인 대기":`${sps.toLocaleString("ko-KR")} SPS`;
}
