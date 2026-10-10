import {test} from "node:test";
import assert from "node:assert/strict";
import type {RagSource} from "../lib/rag-types.ts";
import {sourceFields} from "../lib/rag-source-fields.ts";
import {restoreSession,emptySession} from "../lib/chat-session.ts";

const source:RagSource={id:"sensor-1",label:"S1",kind:"sensor",title:"냉각수 출구 온도",source:"현장 데이터",sensorId:"sensor-1",batchId:null,excerpt:"센서 냉각수 출구 온도; 채널 CH-1; 종류 온도; 부착 열교환기 출구 배관; 상태 주의; 연결 응답 있음; 최신 72.959 °C; 수집 2026-10-10T07:01:40.095Z; 경과 0초; 진단 냉각 효율 저하 징후; 설명 냉각수 점검; 필터 상태 확인; RUL 5일; 오류 탐지 확률 20%"};
test("legacy excerpts restore known fields without truncating values or splitting description semicolons",()=>{
  const rows=sourceFields(source);assert.equal(rows.find(row=>row.label==="센서")!.value,"냉각수 출구 온도");assert.equal(rows.find(row=>row.label==="최신 값")!.value,"72.959 °C");assert.equal(rows.find(row=>row.label==="설명")!.value,"냉각수 점검; 필터 상태 확인");assert.equal(rows.find(row=>row.label==="예상 수명 (RUL)")!.value,"5일");assert.equal(rows.find(row=>row.label==="오류 탐지 확률")!.value,"20%");
});
test("structured fields preserve literal delimiters and unknown legacy shapes retain their content",()=>{
  const fields=[{label:"센서",value:"냉각수; 출구 온도"},{label:"설명",value:"본문; RUL 이것은 필드가 아닌 설명"}];assert.deepEqual(sourceFields({...source,fields}),fields);assert.deepEqual(sourceFields({...source,excerpt:"알 수 없는 형식; 전체 내용"}),[{label:"내용",value:"알 수 없는 형식; 전체 내용"}]);
});
test("new and old session sources restore while malformed field values are discarded",()=>{
  const selection={daqUuid:"11111111-2222-4333-8444-555555555555",sensorIds:["sensor-1"],batchesPerSensor:1,includeRawPreview:false};
  const result={answer:"답변",model:"local",citations:[],requestId:"request",contextCapturedAt:new Date().toISOString(),respondedAt:new Date().toISOString(),selection,contextStats:{sensors:1,batches:0,bytes:100},retrieval:{method:"bm25",candidates:1,included:1,omitted:0,sources:[source],inputTokens:100,inputBudget:2944,contextTokens:4096,outputTokens:1024,historyMessages:0,tokenCount:"server"}};
  const session={...emptySession(),turns:[{id:"turn",question:"상태?",selection,daqLabel:"DAQ",sensorNames:[source.title],createdAt:new Date().toISOString(),status:"completed",error:null,result}]};
  assert.equal(restoreSession(JSON.stringify(session)).turns.length,1);result.retrieval.sources=[{...source,fields:[{label:"센서",value:"냉각수 출구 온도"}]}];assert.equal(restoreSession(JSON.stringify(session)).turns.length,1);const broken=JSON.parse(JSON.stringify(session));broken.turns[0].result.retrieval.sources[0].fields[0].value={bad:true};assert.equal(restoreSession(JSON.stringify(broken)).turns.length,0);
});
