import Link from "next/link";
import type {RagRetrieval} from "@/lib/rag-types";
import {sourceFields} from "@/lib/rag-source-fields";
import Icon from "./icons";

const kinds={sensor:"센서",batch:"배치",log:"로그",dependency:"설비 관계",incident:"장애 사건"};
export default function ChatRetrievalTable({retrieval}:{retrieval:RagRetrieval}){
  return <details className="chat-retrieval">
    <summary className="chat-retrieval-toggle"><strong><Icon name="grid" size={15}/>질의에 전달한 검색 자료</strong><span>{retrieval.included}개</span><Icon name="chevron" size={15}/></summary>
    <p className="chat-retrieval-summary">후보 {retrieval.candidates}개 중 {retrieval.omitted}개 제외 · 이전 대화 {retrieval.historyMessages}개 메시지{retrieval.tokenCount==="estimate"&&" · 토큰 수는 추정"}</p>
    <div className="chat-retrieval-scroll" tabIndex={0} aria-label="검색 자료 상세 스크롤">
      {retrieval.sources.map((source,index)=><details className="chat-source" key={source.label} open={index===0}>
        <summary className="chat-source-toggle"><span>자료 {index+1}</span><span className={`chat-source-kind ${source.kind}`}>{kinds[source.kind]}</span><code>[{source.label}]</code><Icon name="chevron" size={13}/></summary>
        <table className="chat-source-table"><caption>{source.title}</caption><thead><tr><th scope="col">항목</th><th scope="col">값</th></tr></thead><tbody>{sourceFields(source).map((field,row)=><tr key={`${field.label}-${row}`}><th scope="row">{field.label}</th><td>{field.value}</td></tr>)}</tbody></table>
        {source.sensorId&&<Link className="chat-source-link" href={`/equipment?sensor=${encodeURIComponent(source.sensorId)}`}>센서 데이터 보기</Link>}
      </details>)}
      {!retrieval.sources.length&&<p className="chat-retrieval-empty">이번 질의에 전달한 개별 검색 자료가 없습니다.</p>}
    </div>
    <p className="chat-retrieval-note">검색 자료의 항목을 표시합니다. 답변에서 인용한 근거는 별도로 확인할 수 있습니다.</p>
  </details>;
}
