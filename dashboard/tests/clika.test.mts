import {test} from "node:test";
import type {TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {FileRepository} from "../lib/server/repository.ts";
import {MaintenanceService} from "../lib/server/service.ts";
import {RagService,ragConfig} from "../lib/server/rag.ts";
import {clikaBaseUrl,clikaFetch,clikaStatus} from "../lib/server/clika.ts";
import {retrieve} from "../lib/server/retrieval.ts";
import {restoreSession,emptySession} from "../lib/chat-session.ts";
import type {RagHistoryMessage} from "../lib/rag-types.ts";
import {ApiError} from "../lib/server/validation.ts";

const uuid="11111111-2222-4333-8444-555555555555";
function setup(t:TestContext){
  const keys=["RAG_BACKEND","RAG_API_URL","CLIKA_BASE_URL","CLIKA_FALLBACK_BASE_URL","CLIKA_MODEL","CLIKA_API_TOKEN","CLIKA_FAILOVER_TIMEOUT_MS","CLIKA_CHAT_TIMEOUT_MS","CLIKA_CHAT_MAX_TOKENS","CLIKA_CHAT_MAX_INPUT_CHARS","CLIKA_ALLOWED_HOSTS","CLIKA_CHAT_CONTEXT_TOKENS","CLIKA_RAG_TOP_K"];
  const old=keys.map(key=>process.env[key]);t.after(()=>keys.forEach((key,i)=>{if(old[i]===undefined)delete process.env[key];else process.env[key]=old[i];}));keys.forEach(key=>delete process.env[key]);
  process.env.RAG_BACKEND="clika";process.env.CLIKA_BASE_URL="http://127.0.0.1:8000/v1";
  const directory=mkdtempSync(join(tmpdir(),"fieldlink-clika-test-"));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const repo=new FileRepository(directory,"external"),svc=new MaintenanceService(repo),rag=new RagService(repo);
  svc.upsertBoard({uuid,label:"DAQ-CLIKA",ip:"192.168.1.50",port:9000});
  const equipment=svc.saveEquipment({name:"발전기",category:"발전기",location:"발전실"});svc.bindBoard(uuid,{equipmentId:equipment.id});
  const sensor=svc.saveSensor({daqUuid:uuid,channel:"CH1",name:"진동",type:"vibration",position:"구동측 베어링",unit:"g",sps:1000});
  svc.ingest({daqUuid:uuid,readings:[{channel:"CH1",timestamp:new Date().toISOString(),value:1.2,sps:1000,raw:[-1,1]}],diagnoses:[{channel:"CH1",severity:"warning",title:"진동 증가",description:"입력 진단",rulHours:48,model:"edge-v1"}]});return{repo,svc,rag,sensor};
}
function tokens(body:{system:string;messages:{content:string}[]}){return Math.ceil(Array.from(body.system+body.messages.map(row=>row.content).join("\n")).length/2)+48;}
const reply=(content="진동 점검이 필요합니다.")=>Response.json({model:"local-model",choices:[{finish_reason:"stop",message:{content}}]});
function withCounts(fetcher:typeof fetch):typeof fetch{return(async(url,options)=>String(url).endsWith("/messages/count_tokens")?Response.json({input_tokens:tokens(JSON.parse(String(options?.body)))}):fetcher(url,options)) as typeof fetch;}

test("CLIKA uses retrieved sources, actual token budget, model discovery and prior conversation",async t=>{
  const {rag,sensor}=setup(t);process.env.CLIKA_API_TOKEN="local-secret";const calls:string[]=[];
  const fetcher=(async(url,options)=>{
    calls.push(String(url));assert.equal((options?.headers as Record<string,string>).Authorization,"Bearer local-secret");
    if(String(url).endsWith("/models"))return Response.json({data:[{id:"local-model"}]});
    const body=JSON.parse(String(options?.body));if(String(url).endsWith("/count_tokens"))return Response.json({input_tokens:tokens(body)});
    assert.equal(body.model,"local-model");assert.equal(body.stream,false);assert.equal(body.max_tokens,1024);assert.equal("retrieval" in body,false);
    assert.deepEqual(body.messages.map((m:{role:string})=>m.role),["system","user","assistant","user"]);
    assert.match(body.messages[1].content,/이전 질문/);assert.match(body.messages[2].content,/이전 답변/);
    const current=body.messages.at(-1).content as string;assert.match(current,/구동측 베어링/);assert.match(current,/예상 수명 \(RUL\) 48시간/);assert.match(current,/RMS 1/);assert.ok(!current.includes('"schemaVersion"'));assert.ok(!current.includes(sensor.id));return reply("[S1] 진동을 점검하세요. [B1] RMS는 1입니다.");
  }) as typeof fetch;
  const result=await rag.query({daqUuid:uuid,sensorIds:[sensor.id],question:"진동 센서와 배치 RMS는?",history:[{role:"user",content:"이전 질문",daqUuid:uuid},{role:"assistant",content:"이전 답변",daqUuid:uuid}]},fetcher);
  assert.ok(calls.some(url=>url.endsWith("/count_tokens")));assert.equal(calls.filter(url=>url.endsWith("/chat/completions")).length,1);
  assert.equal(result.retrieval!.inputBudget,2944);assert.ok(result.retrieval!.inputTokens<=2944);assert.equal(result.retrieval!.tokenCount,"server");assert.equal(result.model,"local-model");assert.equal(result.citations.length,2);assert.equal(result.citations[0].sensorId,sensor.id);
});

test("explicit model skips discovery; uncited text and untransmitted labels produce no citations",async t=>{
  const {rag}=setup(t);process.env.CLIKA_MODEL="explicit-model";process.env.CLIKA_RAG_TOP_K="1";let calls=0;
  const result=await rag.query({daqUuid:uuid,question:"진동 센서의 위치?"},withCounts((async(url,options)=>{calls++;assert.ok(String(url).endsWith("/chat/completions"));assert.equal(JSON.parse(String(options?.body)).model,"explicit-model");return reply("존재하지 않는 근거 [B999] [S999] [B1]");}) as typeof fetch));
  assert.equal(calls,1);assert.deepEqual(result.citations,[]);assert.equal(result.retrieval!.sources[0].kind,"sensor");
});

test("missing and ambiguous models require selection; status detects sole model",async t=>{
  const {rag}=setup(t);for(const ids of [[],["a","b"]])await assert.rejects(rag.query({daqUuid:uuid,question:"상태?"},(async()=>Response.json({data:ids.map(id=>({id}))})) as typeof fetch),(e:unknown)=>e instanceof ApiError&&e.code==="CLIKA_MODEL_REQUIRED");
  const status=await clikaStatus((async()=>Response.json({data:[{id:"sole-model"}]})) as typeof fetch);assert.equal(status.online,true);assert.equal(status.model,"sole-model");
});

test("provider selection, local-only destination and inference settings are preserved",t=>{
  setup(t);assert.equal(ragConfig().provider,"clika");assert.equal(ragConfig().timeoutMs,120000);delete process.env.RAG_BACKEND;process.env.RAG_API_URL="http://127.0.0.1:8100/query";assert.equal(ragConfig().provider,"rag");delete process.env.RAG_API_URL;assert.equal(ragConfig().provider,"clika");process.env.CLIKA_BASE_URL="http://localhost:8000";assert.equal(clikaBaseUrl(),"http://localhost:8000/v1");process.env.CLIKA_BASE_URL="http://198.168.0.131:8000/v1";process.env.CLIKA_ALLOWED_HOSTS="198.168.0.131";assert.equal(clikaBaseUrl(),process.env.CLIKA_BASE_URL);process.env.CLIKA_BASE_URL="https://public.example/v1";assert.throws(()=>clikaBaseUrl(),/폐쇄망/);process.env.CLIKA_CHAT_TIMEOUT_MS="NaN";assert.throws(()=>ragConfig(),/CLIKA_CHAT_TIMEOUT_MS/);
});

test("network failure falls back to the on-device CLIKA server",async t=>{
  const {rag}=setup(t);process.env.CLIKA_BASE_URL="http://198.168.0.131:8000/v1";process.env.CLIKA_FALLBACK_BASE_URL="http://127.0.0.1:8000/v1";process.env.CLIKA_ALLOWED_HOSTS="198.168.0.131";process.env.CLIKA_MODEL="local";const calls:string[]=[];
  const result=await rag.query({daqUuid:uuid,question:"상태?"},(async(url,options)=>{const value=String(url);calls.push(value);if(value.includes("198.168.0.131"))throw new Error("network unreachable");if(value.endsWith("/count_tokens"))return Response.json({input_tokens:tokens(JSON.parse(String(options?.body)))});return reply();}) as typeof fetch);
  assert.equal(result.model,"local-model");assert.ok(calls.some(url=>url.startsWith("http://198.168.0.131")));assert.ok(calls.some(url=>url.startsWith("http://127.0.0.1")));
});

test("selected CLIKA server keeps the full generation timeout",async t=>{
  setup(t);process.env.CLIKA_BASE_URL="http://192.168.0.131:8000/v1";process.env.CLIKA_FALLBACK_BASE_URL="http://127.0.0.1:8000/v1";const signal=new AbortController().signal,signals:(AbortSignal|null|undefined)[]=[];
  const fetcher=clikaFetch((async(_url,options)=>{signals.push(options?.signal);return Response.json({});}) as typeof fetch);
  await fetcher("http://192.168.0.131:8000/v1/models",{signal});await fetcher("http://192.168.0.131:8000/v1/chat/completions",{signal});assert.notEqual(signals[0],signal);assert.equal(signals[1],signal);
});

test("long history is trimmed without modifying browser history; long question asks for splitting",async t=>{
  const {rag}=setup(t);process.env.CLIKA_MODEL="local";const history:RagHistoryMessage[]=Array.from({length:12},(_,i)=>({role:i%2?"assistant":"user",content:"이전 장비 진단 내용 ".repeat(100),daqUuid:uuid}));
  const result=await rag.query({daqUuid:uuid,question:"현재 진동?",history},withCounts((async(_url,options)=>{const body=JSON.parse(String(options?.body));assert.ok(body.messages.length<=6);assert.ok(body.messages.slice(1,-1).every((row:{content:string})=>row.content.length<450));return reply();}) as typeof fetch));assert.equal(history.length,12);assert.ok(result.retrieval!.historyMessages<=4);assert.ok(result.retrieval!.inputTokens<=result.retrieval!.inputBudget);
  process.env.CLIKA_CHAT_MAX_INPUT_CHARS="4000";await assert.rejects(rag.query({daqUuid:uuid,question:"가".repeat(4000)},withCounts((async()=>{assert.fail("overlong question must not reach inference");}) as typeof fetch)),(e:unknown)=>e instanceof ApiError&&e.code==="CLIKA_INPUT_LIMIT");
});

test("large 32-sensor scope retrieves matching temperature batches instead of entire JSON",async t=>{
  const {rag,repo}=setup(t);process.env.CLIKA_MODEL="local";process.env.CLIKA_CHAT_CONTEXT_TOKENS="2048";process.env.CLIKA_CHAT_MAX_TOKENS="512";
  repo.mutate(store=>{const sensor=store.sensors[0],reading=store.readings[0],diagnosis=store.diagnoses[0];store.sensors=Array.from({length:32},(_,i)=>({...sensor,id:`sensor-${i}`,channel:`CH-${i}`,name:i===31?"출구 온도":"다른 진동 "+i,type:i===31?"temperature":"vibration",position:i===31?"출구 배관":"모터",unit:i===31?"°C":"g"}));store.readings=store.sensors.flatMap(s=>Array.from({length:10},(_,j)=>({...reading,id:`reading-${s.id}-${j}`,sensorId:s.id,timestamp:new Date(Date.now()-j*1000).toISOString(),value:s.type==="temperature"?42:1.2})));store.diagnoses=store.sensors.map(s=>({...diagnosis,id:`diagnosis-${s.id}`,sensorId:s.id,description:"이력 설명 ".repeat(300)}));});
  assert.ok(JSON.stringify(rag.context({daqUuid:uuid,batchesPerSensor:10})).length>40000);
  const result=await rag.query({daqUuid:uuid,batchesPerSensor:10,question:"출구 온도 센서의 최근 배치 RMS는?"},withCounts((async(_url,options)=>{const body=JSON.parse(String(options?.body)),current=body.messages.at(-1).content as string;assert.match(current,/출구 온도/);assert.ok(!current.includes("다른 진동"));assert.ok(String(options?.body).length<10000);return reply("출구 온도 배치를 확인했습니다.");}) as typeof fetch));
  assert.ok(result.retrieval!.candidates>=352);assert.ok(result.retrieval!.included<=8);assert.ok(result.retrieval!.omitted>300);assert.ok(result.retrieval!.inputTokens+result.retrieval!.outputTokens+128<=2048);assert.ok(result.retrieval!.sources.every(s=>s.sensorId==="sensor-31"));
});

test("lexical retrieval prioritizes requested logs and excludes out-of-scope sensors",t=>{
  const {rag,sensor}=setup(t),envelope=rag.context({daqUuid:uuid,sensorIds:[sensor.id]});envelope.context.related.logs=[{id:"log-1",timestamp:new Date().toISOString(),code:"DAQ_DISCONNECTED",level:"warning",source:"server",message:"연결 단절"}];
  assert.equal(retrieve(envelope,"단절 로그를 알려줘")[0].source.kind,"log");assert.ok(retrieve(envelope,"그 센서의 위치는?",[{role:"user",content:"진동 센서는?",daqUuid:uuid}])[0].content.includes("구동측 베어링"));
});

test("absent token route uses explicit conservative fallback; invalid count is an error",async t=>{
  const {rag}=setup(t);process.env.CLIKA_MODEL="local";
  const result=await rag.query({daqUuid:uuid,question:"진동?"},(async(url)=>String(url).endsWith("/count_tokens")?new Response("",{status:404}):reply()) as typeof fetch);assert.equal(result.retrieval!.tokenCount,"estimate");assert.ok(result.retrieval!.inputTokens<=result.retrieval!.inputBudget);
  const unreachable=await rag.query({daqUuid:uuid,question:"진동?"},(async(url)=>{if(String(url).endsWith("/count_tokens"))throw new Error("unreachable");return reply();}) as typeof fetch);assert.equal(unreachable.retrieval!.tokenCount,"estimate");
  await assert.rejects(rag.query({daqUuid:uuid,question:"상태?"},(async()=>Response.json({input_tokens:"invalid"})) as typeof fetch),(e:unknown)=>e instanceof ApiError&&e.code==="CLIKA_TOKEN_COUNT_FAILED");
  await assert.rejects(rag.query({daqUuid:uuid,question:"상태?"},(async()=>new Response("",{status:401})) as typeof fetch),/토큰 계산 실패/);
});

test("unreachable, malformed, truncated, oversized and cancelled model responses are surfaced",async t=>{
  const {rag}=setup(t);process.env.CLIKA_MODEL="local";const query={daqUuid:uuid,question:"상태?"};
  await assert.rejects(rag.query(query,withCounts((async()=>{throw new Error("ECONNREFUSED");}) as typeof fetch)),/CLIKA 서버에 연결할 수 없습니다/);
  await assert.rejects(rag.query(query,withCounts((async()=>Response.json({choices:[]})) as typeof fetch)),(e:unknown)=>e instanceof ApiError&&e.code==="CLIKA_INVALID_RESPONSE");
  await assert.rejects(rag.query(query,withCounts((async()=>Response.json({choices:[{finish_reason:"length",message:{content:"잘린 답변"}}]})) as typeof fetch)),(e:unknown)=>e instanceof ApiError&&e.code==="CLIKA_OUTPUT_TRUNCATED");
  await assert.rejects(rag.query(query,withCounts((async()=>new Response("x".repeat(256*1024+1))) as typeof fetch)),(e:unknown)=>e instanceof ApiError&&e.code==="RAG_RESPONSE_LIMIT");
  const abort=new AbortController();abort.abort();await assert.rejects(rag.query(query,(async()=>{throw new Error("aborted");}) as typeof fetch,abort.signal),(e:unknown)=>e instanceof ApiError&&e.status===499);
});

test("retrieval metadata survives session restore; corrupted sources are discarded",async t=>{
  const {rag,sensor}=setup(t);process.env.CLIKA_MODEL="local";const result=await rag.query({daqUuid:uuid,question:"진동?"},withCounts((async()=>reply()) as typeof fetch));
  const session={...emptySession(),turns:[{id:"turn",question:"진동?",selection:result.selection,daqLabel:"DAQ",sensorNames:[sensor.name],createdAt:new Date().toISOString(),status:"completed",error:null,result}]};
  assert.equal(restoreSession(JSON.stringify(session)).turns[0].result!.retrieval!.method,"bm25");const corrupted=JSON.parse(JSON.stringify(session));corrupted.turns[0].result.retrieval.sources=[{title:{bad:true}}];assert.equal(restoreSession(JSON.stringify(corrupted)).turns.length,0);
});

test("native HTTP adapter round-trips model, token counting and chat contracts",async t=>{
  const {rag}=setup(t);const server=createServer(async(request,response)=>{
    response.setHeader("Content-Type","application/json");if(request.url==="/v1/models"){response.end(JSON.stringify({data:[{id:"http-local-model"}]}));return;}
    let input="";for await(const chunk of request)input+=chunk;const body=JSON.parse(input);
    if(request.url==="/v1/messages/count_tokens"){response.end(JSON.stringify({input_tokens:tokens(body)}));return;}
    assert.equal(request.url,"/v1/chat/completions");assert.equal(body.model,"http-local-model");assert.match(body.messages.at(-1).content,/검색 자료/);response.end(JSON.stringify({model:"http-local-model",choices:[{finish_reason:"stop",message:{content:"[S1] HTTP 검색 질의 확인"}}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert.ok(address&&typeof address!=="string");process.env.CLIKA_BASE_URL=`http://127.0.0.1:${address.port}/v1`;
  const result=await rag.query({daqUuid:uuid,question:"현재 상태?"});assert.equal(result.model,"http-local-model");assert.ok(result.retrieval!.inputTokens<=result.retrieval!.inputBudget);assert.equal(result.citations[0].title,"진동");
});
