import { signalValue } from "../../lib/signal.ts";
import { check } from "../../lib/server/validation.ts";
/** Stateless synthetic transport test. Never writes equipment/sensor/telemetry records. */
export function syntheticResponse(url: URL): Response {
  const sps=Number(url.searchParams.get("sps")||10000), samples=Number(url.searchParams.get("samples")||10000), channels=Number(url.searchParams.get("channels")||1), offset=Number(url.searchParams.get("offset")||0), format=url.searchParams.get("format")||"binary";
  check(Number.isInteger(sps)&&sps>=1&&sps<=1000000,"SPS는 1~1,000,000 범위여야 합니다.");
  check(Number.isInteger(samples)&&samples>=1&&Number.isInteger(channels)&&channels>=1&&channels<=8&&samples*channels<=2000000,"최대 8채널, 총 2,000,000샘플까지 생성할 수 있습니다.");
  check(Number.isSafeInteger(offset)&&offset>=0&&offset<=1e12,"샘플 offset이 올바르지 않습니다.");
  check(format==="binary"||format==="json","format은 binary 또는 json이어야 합니다.");
  const started=performance.now(), buffer=new ArrayBuffer(samples*channels*4), values=new Float32Array(buffer);
  for(let c=0;c<channels;c++)for(let i=0;i<samples;i++)values[c*samples+i]=signalValue(i+offset,sps,c);
  const body=format==="binary"?buffer:JSON.stringify({sps,samples,channels:Array.from({length:channels},(_,c)=>Array.from(values.subarray(c*samples,(c+1)*samples)))});
  return new Response(body,{headers:{"Content-Type":format==="binary"?"application/octet-stream":"application/json","Cache-Control":"no-store","X-Generation-Ms":(performance.now()-started).toFixed(2),"X-Sample-Count":String(samples*channels),"X-SPS":String(sps),"X-Float-Format":"float32-native-endian-channel-major","X-Synthetic-Data":"true"}});
}
