import type {Mode} from "./types.ts";
import type {RagHistoryMessage,RagResult,RagSelection,RagRetrieval} from "./rag-types.ts";
export interface ChatTurn {id:string;question:string;selection:RagSelection;daqLabel:string;sensorNames:string[];createdAt:string;status:"pending"|"completed"|"failed"|"cancelled"|"interrupted";result:RagResult|null;error:string|null}
export interface ChatSession {version:1;selection:RagSelection|null;draft:string;turns:ChatTurn[]}
export function newChatId():string{const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return `chat_${Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("")}`;}
export const sessionKey=(mode:Mode)=>`fieldlink.rag.chat.v1:${mode}`;
export const emptySession=():ChatSession=>({version:1,selection:null,draft:"",turns:[]});
const validSelection=(v:unknown):v is RagSelection=>{if(!v||typeof v!=="object")return false;const s=v as RagSelection;return typeof s.daqUuid==="string"&&Array.isArray(s.sensorIds)&&s.sensorIds.length>0&&s.sensorIds.length<=32&&s.sensorIds.every(id=>typeof id==="string")&&Number.isInteger(s.batchesPerSensor)&&s.batchesPerSensor>=1&&s.batchesPerSensor<=10&&typeof s.includeRawPreview==="boolean";};
function validRetrieval(value:RagRetrieval|undefined):boolean{
  if(value===undefined)return true;if(!value||typeof value!=="object")return false;
  return value.method==="bm25"&&[value.candidates,value.included,value.omitted,value.inputTokens,value.inputBudget,value.contextTokens,value.outputTokens,value.historyMessages].every(n=>typeof n==="number"&&Number.isInteger(n)&&n>=0)&&value.inputTokens<=value.inputBudget&&value.included+value.omitted===value.candidates&&["server","estimate"].includes(value.tokenCount)&&Array.isArray(value.sources)&&value.sources.length<=16&&value.sources.length===value.included&&value.sources.every(s=>s&&typeof s.id==="string"&&typeof s.title==="string"&&typeof s.label==="string"&&["sensor","batch","log","dependency","incident"].includes(s.kind)&&[s.source,s.excerpt,s.sensorId,s.batchId].every(v=>v===null||typeof v==="string")&&(s.fields===undefined||Array.isArray(s.fields)&&s.fields.length<=32&&s.fields.every(f=>f&&typeof f.label==="string"&&f.label.length<=100&&typeof f.value==="string"&&f.value.length<=4000)));
}
function validResult(result:RagResult|null):boolean{
  if(result===null)return true;if(!result||typeof result!=="object")return false;
  return validRetrieval(result.retrieval)&&typeof result.answer==="string"&&result.answer.length<=24000&&(result.model===null||typeof result.model==="string")&&typeof result.contextCapturedAt==="string"&&Number.isFinite(Date.parse(result.contextCapturedAt))&&typeof result.requestId==="string"&&!!result.contextStats&&[result.contextStats.sensors,result.contextStats.batches,result.contextStats.bytes].every(v=>typeof v==="number"&&Number.isFinite(v)&&v>=0)&&Array.isArray(result.citations)&&result.citations.length<=24&&result.citations.every(c=>c&&typeof c.id==="string"&&typeof c.title==="string"&&[c.source,c.excerpt,c.sensorId,c.batchId].every(v=>v===null||typeof v==="string"));
}
function validTurn(v:unknown):v is ChatTurn{if(!v||typeof v!=="object")return false;const t=v as ChatTurn;return typeof t.id==="string"&&typeof t.question==="string"&&t.question.length<=4000&&validSelection(t.selection)&&typeof t.daqLabel==="string"&&Array.isArray(t.sensorNames)&&t.sensorNames.every(n=>typeof n==="string")&&typeof t.createdAt==="string"&&["pending","completed","failed","cancelled","interrupted"].includes(t.status)&&validResult(t.result)&&(t.status!=="completed"||t.result!==null)&&(t.error===null||typeof t.error==="string");}
export function boundSession(session:ChatSession):ChatSession{
  const bounded={...session,draft:session.draft.slice(0,4000),turns:session.turns.slice(-40)};
  while(bounded.turns.length&&new TextEncoder().encode(JSON.stringify(bounded)).byteLength>512*1024)bounded.turns.shift();
  return bounded;
}
export function restoreSession(raw:string|null):ChatSession{
  try{if(!raw||raw.length>1024*1024)return emptySession();const value=JSON.parse(raw);if(value.version!==1||!Array.isArray(value.turns)||value.turns.length>40||!value.turns.every(validTurn)||value.selection!==null&&!validSelection(value.selection)||typeof value.draft!=="string")return emptySession();return boundSession({...value,turns:value.turns.map((turn:ChatTurn)=>turn.status==="pending"?{...turn,status:"interrupted",error:"새로고침으로 응답 대기가 중단되었습니다. 다시 질문해 주세요."}:turn)});}catch{return emptySession();}
}
export function conversationHistory(turns:ChatTurn[]):RagHistoryMessage[]{
  const completed=turns.filter(t=>t.status==="completed"&&t.result).slice(-6),pairs:RagHistoryMessage[][]=[];let chars=0;
  for(const turn of completed.reverse()){const length=turn.question.length+turn.result!.answer.length;if(chars+length>32000)break;chars+=length;const scope={daqUuid:turn.selection.daqUuid,sensorIds:turn.selection.sensorIds};pairs.unshift([{role:"user",content:turn.question,...scope},{role:"assistant",content:turn.result!.answer,...scope}]);}
  return pairs.flat();
}
