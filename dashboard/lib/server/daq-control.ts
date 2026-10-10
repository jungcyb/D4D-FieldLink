import net from "node:net";
import type { Daq } from "../types.ts";
import { ApiError, check, object, text, numeric } from "./validation.ts";
import type {DaqSampling,EdgeSensorInfo} from "../daq-types.ts";
import {parseSampling,parseDaqInfo} from "./daq-info.ts";
import {channelKey} from "../daq-sampling.ts";
export interface AcquisitionStatus { uuid: string; acquiring: boolean; scan_rate_hz: number|null; frames_total: number; sequence_gaps_total: number; sampling:DaqSampling; sensors?:EdgeSensorInfo[]; inventoryComplete?:boolean; channelRatesReported:boolean; capabilities:{control:boolean;commonRate:boolean;channelRate:boolean} }
export function normalizeAcquisitionStatus(input:unknown,hello:Record<string,unknown>,expectedUuid:string):AcquisitionStatus{
  const status=object(input);check(status.uuid===expectedUuid&&typeof status.acquiring==="boolean","보드 수집 상태를 확인할 수 없습니다.",502);
  const reported=status.sampling!==undefined||hello.sampling!==undefined;
  let sampling:DaqSampling;
  if(reported)sampling=parseSampling(status.sampling??hello.sampling);
  else {
    const rate=numeric(status.scan_rate_hz,"보드 scan rate",0.01,1000000),count=numeric(status.channel_count??hello.channel_count??8,"채널 수",1,100);check(Number.isInteger(count),"채널 수는 정수여야 합니다.");
    sampling={commonRateHz:rate,totalRateHz:rate*count,channels:Array.from({length:count},(_,i)=>({channel:`CH${i}`,sps:rate})),complete:true,mode:"uniform",totalSource:"sum",updatedAt:new Date().toISOString()};
  }
  const capabilities=Array.isArray(hello.capabilities)?hello.capabilities:[],info=parseDaqInfo({...(reported?{sampling:status.sampling??hello.sampling}:{}),sensors:status.sensors??hello.sensors,inventoryComplete:status.inventoryComplete??hello.inventoryComplete});
  const sensorRates=info.sensors?.filter(sensor=>sensor.sps!==undefined);
  if(!reported&&sensorRates?.length)sampling={...sampling,channels:sensorRates.map(sensor=>({channel:sensor.channel,sps:sensor.sps??null})),complete:false,mode:"per-channel",totalRateHz:null,totalSource:"unknown"};
  return{uuid:expectedUuid,acquiring:status.acquiring,scan_rate_hz:sampling.commonRateHz,frames_total:typeof status.frames_total==="number"?status.frames_total:0,sequence_gaps_total:typeof status.sequence_gaps_total==="number"?status.sequence_gaps_total:0,...info,sampling,channelRatesReported:reported||!!sensorRates?.length,capabilities:{control:capabilities.includes("acquisition_control"),commonRate:capabilities.includes("sample_rate"),channelRate:capabilities.includes("channel_sample_rate")}};
}
export type AcquisitionCommand = { action: "start" | "stop" } | { action: "rate"; rate: number } | {action:"channel_rate";channel:string;sps:number};
export function parseCommand(input: unknown): AcquisitionCommand {
  const data = object(input);
  check(["start", "stop", "rate", "channel_rate"].includes(String(data.action)), "수집 시작·정지·샘플레이트 변경 중 선택하세요.");
  if(data.action==="channel_rate")return{action:"channel_rate",channel:text(data.channel,"채널",40),sps:numeric(data.sps,"채널 SPS",0.01,1000000)};
  if (data.action === "rate") {
    check(typeof data.rate === "number" && Number.isInteger(data.rate) && data.rate >= 10 && data.rate <= 2000, "샘플레이트는 채널당 10~2,000 SPS의 정수여야 합니다.");
    return { action: "rate", rate: data.rate };
  }
  return { action: data.action as "start" | "stop" };
}
const busy = new Set<string>();
/** A short, non-streaming connection. HELLO UUID is verified before any MCU command. */
export async function controlDaq(daq: Daq, command?: AcquisitionCommand): Promise<AcquisitionStatus> {
  if(command)parseCommand(command);
  check(daq.source === "external", "실제 보드에서만 수집을 제어할 수 있습니다.", 409);
  if (command) { check(!busy.has(daq.uuid), "이 DAQ는 다른 명령을 처리 중입니다. 상태를 확인한 뒤 다시 시도하세요.", 409); busy.add(daq.uuid); }
  const socket = net.createConnection({ host: daq.ip, port: daq.port });
  let buffer = Buffer.alloc(0), id = 0;
  let pending: { id: number; type: number; resolve: (data: unknown) => void; reject: (error: Error) => void } | null = null;
  const fail = (error: Error) => { pending?.reject(error); pending = null; };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("보드 연결이 종료됐습니다.")));
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 12) {
      const size = buffer.readUInt32BE(0);
      if (size > 65536 || buffer.readUInt16BE(4) !== 1) {socket.destroy(new Error("보드 응답 형식 오류")); return;}
      if (buffer.length < size + 12) return;
      const type = buffer.readUInt16BE(6), requestId = buffer.readUInt32BE(8), payload = buffer.subarray(12, size + 12);
      buffer = buffer.subarray(size + 12);
      if (!pending || requestId !== pending.id) continue;
      try {
        const data = JSON.parse(payload.toString("utf8"));
        if (type === 0xffff) throw new Error(String(data.error || "보드가 명령을 거절했습니다."));
        if (type !== (pending.type | 0x8000)) throw new Error("명령과 보드 응답이 일치하지 않습니다.");
        pending.resolve(data); pending = null;
      } catch (error) { fail(error instanceof Error ? error : new Error("잘못된 보드 응답")); }
    }
  });
  const timeout = setTimeout(() => socket.destroy(new Error("보드 응답 시간 초과")), 5000);
  function request(type: number, payload = Buffer.alloc(0)): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (socket.destroyed) return reject(new Error("보드 연결 종료"));
      const packet = Buffer.alloc(12 + payload.length); packet.writeUInt32BE(payload.length); packet.writeUInt16BE(1, 4); packet.writeUInt16BE(type, 6); packet.writeUInt32BE(++id, 8); payload.copy(packet, 12);
      pending = { id, type, resolve, reject }; socket.write(packet);
    });
  }
  try {
    const hello = object(await request(1));
    check(hello.uuid === daq.uuid, "접속 주소의 보드 UUID가 다릅니다. 명령을 전송하지 않았습니다.", 409);
    if (command) {
      check(Array.isArray(hello.capabilities) && hello.capabilities.includes(command.action === "channel_rate" ? "channel_sample_rate" : command.action === "rate" ? "sample_rate" : "acquisition_control"), "보드가 이 제어 기능을 지원하지 않습니다.", 409);
      if(command.action==="channel_rate"){
        const before=normalizeAcquisitionStatus(await request(2),hello,daq.uuid),channel=before.sampling.channels.find(row=>channelKey(row.channel)===channelKey(command.channel));check(channel,"보드가 보고하지 않은 채널입니다.",409);
        await request(12,Buffer.from(JSON.stringify({channel:channel.channel,sps:command.sps})));
      }else{
        const payload=command.action==="rate"?Buffer.alloc(4):Buffer.alloc(0);if(command.action==="rate")payload.writeUInt32BE(command.rate);
        await request(command.action==="start"?3:command.action==="stop"?4:5,payload);
      }
    }
    const status = normalizeAcquisitionStatus(await request(2),hello,daq.uuid);
    if (command) check(command.action === "channel_rate" ? status.sampling.channels.find(row=>channelKey(row.channel)===channelKey(command.channel))?.sps === command.sps : command.action === "rate" ? status.scan_rate_hz === command.rate : status.acquiring === (command.action === "start"), "명령 후 보드 상태가 일치하지 않습니다. 현재 상태를 다시 확인하세요.", 502);
    return status as unknown as AcquisitionStatus;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, `${error instanceof Error ? error.message : "DAQ 통신 실패"}${command ? " · 명령 적용 여부가 불확실합니다. 재시도 전에 상태를 확인하세요." : ""}`, "DAQ_UNAVAILABLE");
  } finally { clearTimeout(timeout); socket.destroy(); if (command) busy.delete(daq.uuid); }
}
