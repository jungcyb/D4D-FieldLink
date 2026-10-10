import {predictionFields} from "../prediction.ts";
import {formatSampleRate} from "../sampling.ts";
import type {RagEnvelope,RagSource,RagSourceKind,RagSourceField,RagHistoryMessage} from "../rag-types.ts";

export interface RetrievalChunk {source:RagSource;content:string;searchText:string;score:number;order:number}
const severityName=(value:string)=>({normal:"정상",warning:"주의",critical:"위험",unknown:"미확인"}[value]||value);
const typeName=(value:string)=>({vibration:"진동",temperature:"온도",current:"전류",analog:"아날로그"}[value]||value);
const compact=(value:unknown,max=220)=>String(value??"없음").replace(/\s+/g," ").slice(0,max);
const number=(value:number|null|undefined)=>value==null?"없음":Number(value.toPrecision(6));

/** Unicode words + Korean bigrams keep compounds such as '진동센서' searchable. */
export function searchTokens(input:string):string[]{
  const words=input.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
  return words.flatMap(word=>/^[가-힣]+$/.test(word)&&word.length>2?[word,...Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2))]:[word]);
}

/** Query-time index of the authorized, freshly read scope. Nothing leaves the host. */
export function retrieve(envelope:RagEnvelope,question:string,history:RagHistoryMessage[]=[]):RetrievalChunk[]{
  const context=envelope.context,chunks:RetrievalChunk[]=[],sensorNames=new Map(context.sensors.map(s=>[s.id,s.name]));
  const add=(kind:RagSourceKind,label:string,id:string,title:string,content:string,sensorId:string|null=null,batchId:string|null=null,extra="",fields:RagSourceField[]=[])=>{
    chunks.push({source:{kind,label,id,title,source:"현장 저장 데이터",excerpt:content.slice(0,600),sensorId,batchId,fields},content:`[${label}] ${content}`,searchText:`${title} ${content} ${extra}`,score:0,order:chunks.length});
  };
  context.sensors.forEach((sensor,i)=>{
    const status=context.status.sensors.find(s=>s.sensorId===sensor.id),diagnosis=status?.diagnosis;
    const content=`센서 ${compact(sensor.name,100)}; 채널 ${sensor.channel}; 종류 ${typeName(sensor.type)}; 채널 샘플레이트 ${formatSampleRate(sensor.sps)}; 부착 ${compact(sensor.position,120)}; 상태 ${severityName(status?.severity||"unknown")}; 연결 ${status?.online?"응답 있음":"응답 없음"}; 최신 ${number(status?.latestValue)} ${sensor.unit}; 수집 ${status?.latestTimestamp||"없음"}; 경과 ${status?.dataAgeMs==null?"없음":Math.round(status.dataAgeMs/1000)+"초"}; 진단 ${compact(diagnosis?.title,120)}; 설명 ${compact(diagnosis?.description)}; ${predictionFields(diagnosis).map(field=>`${field.label} ${field.value}`).join("; ")}`;
    const fields:RagSourceField[]=[
      {label:"센서",value:compact(sensor.name,100)},
      {label:"채널",value:sensor.channel},
      {label:"종류",value:typeName(sensor.type)},
      {label:"채널 샘플레이트",value:formatSampleRate(sensor.sps)},
      {label:"부착 위치",value:compact(sensor.position,120)},
      {label:"상태",value:severityName(status?.severity||"unknown")},
      {label:"연결",value:status?.online?"응답 있음":"응답 없음"},
      {label:"최신 값",value:`${number(status?.latestValue)} ${sensor.unit}`},
      {label:"수집 시각",value:status?.latestTimestamp||"없음"},
      {label:"데이터 경과",value:status?.dataAgeMs==null?"없음":Math.round(status.dataAgeMs/1000)+"초"},
      {label:"진단",value:compact(diagnosis?.title,120)},
      {label:"설명",value:compact(diagnosis?.description)},
      ...predictionFields(diagnosis),
    ];
    add("sensor",`S${i+1}`,`sensor-${sensor.id}`,sensor.name,content,sensor.id,null,`${sensor.id} ${sensor.type} ${status?.severity||"unknown"}`,fields);
  });
  context.batches.forEach((batch,i)=>{
    const sensor=context.sensors.find(s=>s.id===batch.sensorId),summary=batch.rawSummary;
    const content=`${compact(sensorNames.get(batch.sensorId),100)} ${batch.channel} 배치; 수집 ${batch.timestamp}~${batch.endTimestamp}; 대표 ${number(batch.value)} ${batch.unit}; ${batch.sampleCount}샘플 ${batch.sps}SPS; 최소 ${number(summary?.min)}; 최대 ${number(summary?.max)}; 평균 ${number(summary?.mean)}; RMS ${number(summary?.rms)}`;
    add("batch",`B${i+1}`,`batch-${batch.id}`,`${sensorNames.get(batch.sensorId)||batch.channel} 수신 배치`,content,batch.sensorId,batch.id,`${sensor?.position||""} ${sensor?typeName(sensor.type):""} ${batch.id} raw 원시 추이 변화 통계`,[
      {label:"센서",value:compact(sensorNames.get(batch.sensorId),100)},
      {label:"채널",value:batch.channel},
      {label:"수집 시작",value:batch.timestamp},{label:"수집 종료",value:batch.endTimestamp},
      {label:"대표값",value:`${number(batch.value)} ${batch.unit}`},
      {label:"샘플 수",value:String(batch.sampleCount)},{label:"샘플링 속도",value:`${batch.sps} SPS`},
      {label:"최소",value:String(number(summary?.min))},{label:"최대",value:String(number(summary?.max))},
      {label:"평균",value:String(number(summary?.mean))},{label:"RMS",value:String(number(summary?.rms))},
    ]);
  });
  context.related.logs.forEach((log,i)=>add("log",`L${i+1}`,log.id,`${log.code} 로그`,`로그 ${log.timestamp}; ${log.level}; ${log.code}; ${compact(log.message,350)}`,null,null,"로그 log 연결 단절 재연결",[
    {label:"시각",value:log.timestamp},{label:"수준",value:log.level},{label:"코드",value:log.code},{label:"메시지",value:compact(log.message,350)},
  ]));
  const names=new Map(context.related.equipment.map(e=>[e.id,e.name]));
  context.related.dependencies.forEach((edge,i)=>{
    const from=context.related.equipment.find(e=>e.id===edge.from);
    add("dependency",`D${i+1}`,edge.id,"설비 의존관계",`${compact(names.get(edge.from),100)} → ${compact(names.get(edge.to),100)}; ${edge.kind}; ${edge.required?"필수 공급":"보조 공급"}; 선행 설비 상태 ${severityName(from?.severity||"unknown")}; ${compact(edge.description)}`,null,null,"상위 하위 공급 영향 원인 연관 연결 발전기",[
      {label:"선행 설비",value:compact(names.get(edge.from),100)},{label:"후행 설비",value:compact(names.get(edge.to),100)},
      {label:"관계 종류",value:edge.kind},{label:"공급",value:edge.required?"필수 공급":"보조 공급"},
      {label:"선행 설비 상태",value:severityName(from?.severity||"unknown")},{label:"설명",value:compact(edge.description)},
    ]);
  });
  context.related.incidents.forEach((incident,i)=>add("incident",`I${i+1}`,incident.id,"장애 사건",`사건 ${compact(incident.title,200)}; ${incident.status}; 원인 후보 ${incident.rootEquipmentIds.map(id=>compact(names.get(id),80)).join(",")}; 연관 설비 ${incident.affectedEquipmentIds.map(id=>compact(names.get(id),80)).join(",")}`,null,null,"장애 고장 사건 원인 영향",[
    {label:"사건",value:compact(incident.title,200)},{label:"상태",value:incident.status},
    {label:"원인 후보",value:incident.rootEquipmentIds.map(id=>compact(names.get(id),80)).join(",")},
    {label:"연관 설비",value:incident.affectedEquipmentIds.map(id=>compact(names.get(id),80)).join(",")},
  ]));

  const previous=history.filter(row=>row.role==="user"&&(!row.daqUuid||row.daqUuid===envelope.selection.daqUuid)).at(-1)?.content||"";
  const query=/그\s*(센서|장비|배치)|해당|방금|아까|이전/.test(question)?`${question} ${previous.slice(0,500)}`:question;
  const normalized=query.toLowerCase(),queryTokens=[...new Set(searchTokens(query))],documents=chunks.map(chunk=>searchTokens(chunk.searchText));
  const average=documents.reduce((sum,doc)=>sum+doc.length,0)/Math.max(1,documents.length),df=new Map<string,number>();
  for(const doc of documents)for(const token of new Set(doc))df.set(token,(df.get(token)||0)+1);
  const focus=new Set(context.sensors.filter(sensor=>[sensor.name,sensor.channel,sensor.id,sensor.position,typeName(sensor.type),sensor.type].some(term=>term.length>=2&&normalized.includes(term.toLowerCase()))).map(sensor=>sensor.id));
  const batchQuestion=/배치|raw|원시|추이|변화|rms|평균|피크|최대|최소/i.test(query),logQuestion=/로그|log|단절|재연결|접속/i.test(query),dependencyQuestion=/상위|하위|공급|영향|원인|연관|연결된/.test(query);
  chunks.forEach((chunk,index)=>{
    const doc=documents[index],tf=new Map<string,number>();for(const token of doc)tf.set(token,(tf.get(token)||0)+1);
    for(const token of queryTokens){const count=tf.get(token)||0;if(!count)continue;const idf=Math.log(1+(documents.length-(df.get(token)||0)+0.5)/((df.get(token)||0)+0.5));chunk.score+=idf*(count*2.2)/(count+1.2*(0.25+0.75*doc.length/Math.max(1,average)));}
    if(chunk.source.sensorId&&focus.has(chunk.source.sensorId))chunk.score+=20;
    if(chunk.source.kind==="sensor"){
      chunk.score+=3;
      if(!focus.size){const severity=context.status.sensors.find(s=>s.sensorId===chunk.source.sensorId)?.severity;chunk.score+=severity==="critical"?12:severity==="warning"?6:0;}
    }
    if(chunk.source.kind==="batch"&&batchQuestion)chunk.score+=10;
    if(chunk.source.kind==="log"&&logQuestion)chunk.score+=18;
    if(["dependency","incident"].includes(chunk.source.kind)&&dependencyQuestion)chunk.score+=18;
    if(focus.size&&chunk.source.sensorId&&!focus.has(chunk.source.sensorId))chunk.score*=0.15;
  });
  return chunks.sort((a,b)=>b.score-a.score||a.order-b.order);
}

/** Mandatory fresh scope summary remains even when no individual chunk fits. */
export function retrievalHeader(envelope:RagEnvelope):string{
  const context=envelope.context,counts={normal:0,warning:0,critical:0,unknown:0};
  context.status.sensors.forEach(s=>counts[s.severity]++);
  const impact=context.status.dependencyImpact;
  return `자료시각 ${context.capturedAt}; ${context.mode==="demo"?"모의 데이터":"실수신 데이터"}; DAQ ${compact(context.daq.label,100)}; 전체 샘플레이트 ${context.daq.sampling?.totalRateHz==null?"미수신":context.daq.sampling.totalRateHz+" samples/s"}; 장비 ${compact(context.equipment?.name,100)}; 설치 ${compact(context.placement.equipmentLocation,100)}; DAQ ${context.status.daqOnline?"응답 있음":"응답 없음"}; 장비 진단 ${severityName(context.status.equipmentSeverity)}; 선택 센서 ${context.sensors.length}개(정상 ${counts.normal},주의 ${counts.warning},위험 ${counts.critical},미확인 ${counts.unknown}); 검색 대상 최근 ${envelope.selection.batchesPerSensor}배치/센서; 상위 영향 ${impact?compact(JSON.stringify(impact),220):"없음"}. 검색에서 제외된 자료가 있으므로 이 결과만으로 모든 센서·기간을 확인했다고 말하지 마세요. 사진 원본은 제공하지 않습니다.`;
}
