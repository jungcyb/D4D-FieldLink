"use client";
import {createContext,useCallback,useContext,useMemo,useState} from "react";
import type {Snapshot} from "@/lib/types";
import FloatingChat from "./floating-chat";
import {newChatId} from "@/lib/chat-session";
export interface ChatHint {daqUuid?:string;sensorId?:string}
export interface ChatSetup extends ChatHint {id:string}
const Context=createContext<{snapshot:Snapshot|null;publishSnapshot:(data:Snapshot)=>void;openChat:(hint?:ChatHint)=>void}|null>(null);
export function useFieldChat(){const context=useContext(Context);if(!context)throw new Error("FieldChatProvider가 필요합니다.");return context;}
export default function FieldChatProvider({children}:{children:React.ReactNode}){
  const [data,setData]=useState<Snapshot|null>(null),[setup,setSetup]=useState<ChatSetup|null>(null),[open,setOpen]=useState(false);
  const publishSnapshot=useCallback((snapshot:Snapshot)=>setData(snapshot),[]),openChat=useCallback((hint:ChatHint={})=>setSetup({...hint,id:newChatId()}),[]);
  const context=useMemo(()=>({snapshot:data,publishSnapshot,openChat}),[data,publishSnapshot,openChat]);
  return <Context.Provider value={context}>{children}{data&&<FloatingChat key={data.mode} data={data} setup={setup} open={open} setOpen={setOpen} openSetup={openChat} closeSetup={()=>setSetup(null)}/>}</Context.Provider>;
}
