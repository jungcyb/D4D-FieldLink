import type {RagEnvelope,RagHistoryMessage,RagRetrieval} from "../rag-types.ts";
import {check,object,text,ApiError} from "./validation.ts";
import {packClikaPrompt} from "./clika-prompt.ts";

/** Server-owned inference destination. Never accept a URL from chat input. */
export function clikaBaseUrl():string {
  let url:URL;
  try { url=new URL(process.env.CLIKA_BASE_URL||"http://127.0.0.1:8000/v1"); }
  catch { throw new ApiError(503,"CLIKA_BASE_URL 주소 형식이 올바르지 않습니다.","CLIKA_NOT_CONFIGURED"); }
  const host=url.hostname.replace(/^\[|\]$/g,"").toLowerCase(),octets=host.split(".").map(Number);
  const privateIPv4=octets.length===4&&octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(octets[0]===127||octets[0]===10||octets[0]===192&&octets[1]===168||octets[0]===172&&octets[1]>=16&&octets[1]<=31);
  const aliases=(process.env.CLIKA_ALLOWED_HOSTS||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
  check(["http:","https:"].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash&&(host==="localhost"||host==="::1"||privateIPv4||/^(fc|fd)[0-9a-f:]+$/.test(host)||host.endsWith(".internal")||host.endsWith(".local")||aliases.includes(host)),"CLIKA_BASE_URL은 폐쇄망의 로컬·사설 추론 주소여야 합니다.",400,"CLIKA_EXTERNAL_URL_BLOCKED");
  // Both the serving root and the usual OpenAI-compatible /v1 base are accepted.
  const base=url.toString().replace(/\/+$/,"");
  return url.pathname==="/"?`${base}/v1`:base;
}

function setting(key:string,fallback:number,min:number,max:number){
  const value=Number(process.env[key]||fallback);
  check(Number.isInteger(value)&&value>=min&&value<=max,`${key}는 ${min}~${max} 정수여야 합니다.`,503,"CLIKA_NOT_CONFIGURED");
  return value;
}
export const clikaTimeoutMs=()=>setting("CLIKA_CHAT_TIMEOUT_MS",120000,1000,300000);
const headers=():Record<string,string>=>process.env.CLIKA_API_TOKEN?{Authorization:`Bearer ${process.env.CLIKA_API_TOKEN}`}:{ };

async function modelList(fetcher:typeof fetch,signal?:AbortSignal):Promise<string[]>{
  const timeout=AbortSignal.timeout(5000),combined=signal?AbortSignal.any([timeout,signal]):timeout;
  const response=await fetcher(`${clikaBaseUrl()}/models`,{headers:headers(),signal:combined,redirect:"error"});
  check(response.ok,`CLIKA 모델 조회 실패 (${response.status}). /v1/models 경로와 인증 설정을 확인하세요.`,502,"CLIKA_MODEL_QUERY_FAILED");
  const reader=response.body?.getReader();check(reader,"CLIKA 모델 목록이 비어 있습니다.",502,"CLIKA_INVALID_RESPONSE");
  let total=0;const chunks:Uint8Array[]=[];
  while(true){const row=await reader.read();if(row.done)break;total+=row.value.length;if(total>65536){await reader.cancel();throw new ApiError(502,"CLIKA 모델 목록 응답이 너무 큽니다.","CLIKA_INVALID_RESPONSE");}chunks.push(row.value);}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let payload:Record<string,unknown>;
  try {payload=object(JSON.parse(new TextDecoder().decode(bytes)));}
  catch {throw new ApiError(502,"CLIKA 모델 목록이 올바른 JSON이 아닙니다.","CLIKA_INVALID_RESPONSE");}
  check(Array.isArray(payload.data),"CLIKA /v1/models 응답에 data 배열이 없습니다.",502,"CLIKA_INVALID_RESPONSE");
  return [...new Set(payload.data.map(row=>typeof row==="object"&&row!==null?Reflect.get(row,"id"):null).filter((id):id is string=>typeof id==="string"&&id.trim().length>0&&id.length<=200))];
}

export async function clikaStatus(fetcher:typeof fetch=fetch){
  try{const models=await modelList(fetcher),configured=process.env.CLIKA_MODEL?.trim();return{online:true,model:configured||(models.length===1?models[0]:null),models,message:models.length===1||configured?"CLIKA 로컬 추론 서버 응답 확인":"CLIKA_MODEL에 사용할 모델 ID를 지정해 주세요."};}
  catch(error){return{online:false,model:process.env.CLIKA_MODEL||null,models:[],message:error instanceof ApiError?error.message:"CLIKA 로컬 추론 서버에 연결할 수 없습니다."};}
}

async function resolveModel(fetcher:typeof fetch,signal:AbortSignal){
  const configured=process.env.CLIKA_MODEL?.trim();if(configured)return text(configured,"CLIKA_MODEL",200);
  let models:string[];
  try{models=await modelList(fetcher,signal);}
  catch(error){if(signal.aborted)throw error;if(error instanceof ApiError)throw error;throw new ApiError(502,"CLIKA 모델 목록에 연결할 수 없습니다. localhost:8000 서버 실행 상태를 확인하세요.","CLIKA_MODEL_QUERY_FAILED");}
  check(models.length===1,models.length?"CLIKA 모델이 여러 개입니다. /api/clika/status에서 ID를 확인하고 CLIKA_MODEL을 지정하세요.":"CLIKA 서버에 로드된 모델이 없습니다.",503,"CLIKA_MODEL_REQUIRED");
  return models[0];
}

export async function clikaChatRequest(envelope:RagEnvelope,question:string,history:RagHistoryMessage[],fetcher:typeof fetch,signal:AbortSignal){
  const model=await resolveModel(fetcher,signal),maxTokens=setting("CLIKA_CHAT_MAX_TOKENS",1024,64,8192);
  const packed=await packClikaPrompt(envelope,question,history,{model,base:clikaBaseUrl(),token:process.env.CLIKA_API_TOKEN,contextTokens:setting("CLIKA_CHAT_CONTEXT_TOKENS",4096,512,131072),outputTokens:maxTokens,safetyTokens:128,maxChars:setting("CLIKA_CHAT_MAX_INPUT_CHARS",40000,4000,200000),topK:setting("CLIKA_RAG_TOP_K",8,1,16)},fetcher,signal);
  return {model,messages:packed.messages,stream:false,temperature:0.2,max_tokens:maxTokens,retrieval:packed.retrieval};
}

export function clikaChatAnswer(input:unknown,envelope:RagEnvelope,retrieval?:RagRetrieval){
  try{
    const payload=object(input);check(Array.isArray(payload.choices)&&payload.choices.length>0,"CLIKA 응답에 choices가 없습니다.");
    const choice=object(payload.choices[0]);
    check(choice.finish_reason!=="length","CLIKA 답변이 출력 한도에 도달했습니다. 질문 범위를 줄이거나 CLIKA_CHAT_MAX_TOKENS를 늘려 주세요.",502,"CLIKA_OUTPUT_TRUNCATED");
    const message=object(choice.message),answer=text(message.content,"CLIKA 답변",24000);
    const citations=retrieval?retrieval.sources.filter(source=>new RegExp(`\\b${source.label}\\b`).test(answer)).map(source=>({id:source.id,title:source.title,source:source.source,excerpt:source.excerpt,sensorId:source.sensorId,batchId:source.batchId})):envelope.context.batches.filter(batch=>answer.includes(batch.id)).slice(0,24).map(batch=>({id:`batch-${batch.id}`,title:`${batch.channel} 수신 배치`,source:"질의에 전달한 현장 데이터",excerpt:`${batch.timestamp} · ${batch.sampleCount} samples · ${batch.sps} SPS`,sensorId:batch.sensorId,batchId:batch.id}));
    return{answer,citations,model:payload.model==null?null:text(payload.model,"CLIKA 모델명",200)};
  }catch(error){if(error instanceof ApiError&&error.code==="CLIKA_OUTPUT_TRUNCATED")throw error;throw new ApiError(502,"CLIKA 채팅 응답에 유효한 choices[0].message.content가 없습니다.","CLIKA_INVALID_RESPONSE");}
}
