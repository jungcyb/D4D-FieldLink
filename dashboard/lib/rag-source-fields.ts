import type {RagSource,RagSourceField} from "./rag-types.ts";

/** Old session replies have an excerpt only. Recognize known keys, not every semicolon. */
export function sourceFields(source:RagSource):RagSourceField[]{
  if(source.fields?.length)return source.fields;
  if(!source.excerpt)return [];
  const expression=/(?:^|;\s*)(오류 탐지 확률|선행 설비 상태|원인 후보|연관 설비|센서|채널|종류|부착|상태|연결|최신|수집|경과|진단|설명|RUL|대표|최소|최대|평균|RMS|사건)\s+/g;
  const matches=[...source.excerpt.matchAll(expression)];
  if(!matches.length)return [{label:"내용",value:source.excerpt}];
  const rows:RagSourceField[]=[];
  const prefix=source.excerpt.slice(0,matches[0].index).trim().replace(/;$/,"");if(prefix)rows.push({label:"자료",value:prefix});
  const labels:Record<string,string>={부착:"부착 위치",최신:"최신 값",수집:"수집 시각",경과:"데이터 경과",RUL:"예상 수명 (RUL)",대표:"대표값"};
  matches.forEach((match,index)=>{const start=match.index!+match[0].length,end=matches[index+1]?.index??source.excerpt!.length;rows.push({label:labels[match[1]]||match[1],value:source.excerpt!.slice(start,end).trim()});});
  return rows;
}
