import net from "node:net";
import type { Daq, DaqChannel, SampleRateGroup } from "../types.ts";
import { ApiError, check, object } from "./validation.ts";
import { normalizeCapabilities } from "./adapters.ts";
export interface AcquisitionStatus { uuid: string; acquiring: boolean; scan_rate_hz: number; frames_total: number; sequence_gaps_total: number; channel_capabilities?: { channelCount: number; channels: DaqChannel[]; sampleRateGroups: SampleRateGroup[] } }
export type AcquisitionCommand = { action: "start" | "stop" } | { action: "rate"; groupId: string; rate: number };
export function parseCommand(input: unknown): AcquisitionCommand {
  const data = object(input);
  check(["start", "stop", "rate"].includes(String(data.action)), "수집 시작·정지·샘플레이트 변경 중 선택하세요.");
  if (data.action === "rate") {
    check(typeof data.groupId === "string" && data.groupId.length > 0 && data.groupId.length <= 80, "샘플레이트 그룹을 선택하세요.");
    check(typeof data.rate === "number" && Number.isFinite(data.rate) && data.rate > 0 && data.rate <= 1000000, "샘플레이트 값이 올바르지 않습니다.");
    return { action: "rate", groupId: data.groupId, rate: data.rate };
  }
  return { action: data.action as "start" | "stop" };
}
const busy = new Set<string>();
/** A short, non-streaming connection. HELLO UUID is verified before any MCU command. */
export async function controlDaq(daq: Daq, command?: AcquisitionCommand): Promise<AcquisitionStatus> {
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
      check(Array.isArray(hello.capabilities) && hello.capabilities.includes(command.action === "rate" ? "sample_rate" : "acquisition_control"), "보드가 이 제어 기능을 지원하지 않습니다.", 409);
      let payload = Buffer.alloc(0), messageType: number = command.action === "start" ? 3 : 4;
      if (command.action === "rate") {
        const capabilities = normalizeCapabilities(hello.channel_capabilities);
        check(capabilities, "보드가 채널별 샘플레이트 정보를 제공하지 않습니다.", 409);
        const group = capabilities.sampleRateGroups.find(item => item.id === command.groupId);
        check(group?.writable, "선택한 채널 집합의 샘플레이트는 변경할 수 없습니다.", 409);
        check(command.rate >= (group.minHz || command.rate) && command.rate <= (group.maxHz || command.rate) && (group.stepHz == null || Number.isInteger((command.rate - (group.minHz || 0)) / group.stepHz)), `${group.label} 허용 범위를 확인하세요.`, 409);
        payload = Buffer.from(JSON.stringify({ groupId: command.groupId, rateHz: command.rate }));
        messageType = 12;
      }
      await request(messageType, payload);
    }
    const status = object(await request(2));
    check(status.uuid === daq.uuid && typeof status.acquiring === "boolean" && typeof status.scan_rate_hz === "number" && Number.isFinite(status.scan_rate_hz), "보드 수집 상태를 확인할 수 없습니다.", 502);
    if (status.channel_capabilities != null) check(normalizeCapabilities(status.channel_capabilities), "보드의 채널 상태 형식이 올바르지 않습니다.", 502);
    if (command) check(command.action === "rate" ? normalizeCapabilities(status.channel_capabilities)?.sampleRateGroups.find(group => group.id === command.groupId)?.currentHz === command.rate : status.acquiring === (command.action === "start"), "명령 후 보드 상태가 일치하지 않습니다. 현재 상태를 다시 확인하세요.", 502);
    return status as unknown as AcquisitionStatus;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, `${error instanceof Error ? error.message : "DAQ 통신 실패"}${command ? " · 명령 적용 여부가 불확실합니다. 재시도 전에 상태를 확인하세요." : ""}`, "DAQ_UNAVAILABLE");
  } finally { clearTimeout(timeout); socket.destroy(); if (command) busy.delete(daq.uuid); }
}
