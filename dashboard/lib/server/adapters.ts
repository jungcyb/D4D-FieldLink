import dgram from "node:dgram";
import { randomBytes } from "node:crypto";
import type { BoardResponse, DaqChannel, SampleRateGroup } from "../types.ts";
import { DEMO_BOARDS } from "./seed.ts";
import { ApiError } from "./validation.ts";

/** Board responses are normalized here. UUID is always supplied by the board. */
export interface DiscoveryAdapter { discover(): Promise<BoardResponse[]> }
export class DemoDiscoveryAdapter implements DiscoveryAdapter {
  async discover(): Promise<BoardResponse[]> { return DEMO_BOARDS; }
}
export class UnconfiguredDiscoveryAdapter implements DiscoveryAdapter {
  async discover(): Promise<BoardResponse[]> {
    throw new ApiError(503, "UDP 탐색 프로토콜이 아직 설정되지 않았습니다. DAQ 수신 API를 먼저 사용할 수 있습니다.", "ADAPTER_NOT_CONFIGURED");
  }
}

const uuid = (bytes: Buffer) => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

export interface NormalizedCapabilities { channelCount: number; channels: DaqChannel[]; sampleRateGroups: SampleRateGroup[] }
export function normalizeCapabilities(value: unknown): NormalizedCapabilities | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.channels) || !Array.isArray(data.sampleRateGroups) || data.channelCount !== data.channels.length || data.channels.length > 64) return null;
  const channels: DaqChannel[] = [];
  for (const raw of data.channels) {
    const item = Array.isArray(raw) && raw.length === 8 ? {id:raw[0],label:raw[1],adc:raw[2],adcChannel:raw[3],sampleRateHz:raw[4],inputUnit:raw[5],rateGroupId:raw[6],streamAvailable:raw[7]} : raw;
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    if (![c.id,c.label,c.adc,c.adcChannel,c.inputUnit,c.rateGroupId].every(v => typeof v === "string" && v.length > 0 && v.length <= 80) || typeof c.sampleRateHz !== "number" || !Number.isFinite(c.sampleRateHz) || c.sampleRateHz <= 0 || typeof c.streamAvailable !== "boolean") return null;
    channels.push(c as unknown as DaqChannel);
  }
  if (new Set(channels.map(channel => channel.id)).size !== channels.length) return null;
  const ids = new Set(channels.map(channel => channel.id)), sampleRateGroups: SampleRateGroup[] = [];
  for (const raw of data.sampleRateGroups) {
    const item = Array.isArray(raw) && raw.length === 8 ? {id:raw[0],label:raw[1],channelIds:raw[2],currentHz:raw[3],writable:raw[4],...(raw[5] == null ? {} : {minHz:raw[5]}),...(raw[6] == null ? {} : {maxHz:raw[6]}),...(raw[7] == null ? {} : {stepHz:raw[7]})} : raw;
    if (!item || typeof item !== "object") return null;
    const group = item as Record<string, unknown>;
    if (typeof group.id !== "string" || !group.id || typeof group.label !== "string" || !Array.isArray(group.channelIds) || !group.channelIds.length || !group.channelIds.every(id => typeof id === "string" && ids.has(id)) || typeof group.currentHz !== "number" || !Number.isFinite(group.currentHz) || group.currentHz <= 0 || typeof group.writable !== "boolean") return null;
    if (group.writable && (typeof group.minHz !== "number" || typeof group.maxHz !== "number" || typeof group.stepHz !== "number" || group.minHz <= 0 || group.maxHz < group.minHz || group.stepHz <= 0)) return null;
    sampleRateGroups.push(group as unknown as SampleRateGroup);
  }
  return { channelCount: channels.length, channels, sampleRateGroups };
}

export function decodeDiscoveryResponse(packet: Buffer, sourceIp: string, nonce: bigint): BoardResponse | null {
  if (packet.length < 36 || packet.toString("ascii", 0, 4) !== "A8DR" || ![1, 2].includes(packet.readUInt16BE(4)) || packet.readUInt16BE(6) !== 0 || packet.readBigUInt64BE(8) !== nonce) return null;
  const version = packet.readUInt16BE(4), hostnameBytes = packet[34], modelBytes = packet[35], headerBytes = version === 2 ? 38 : 36;
  if (packet.length < headerBytes) return null;
  const capabilityBytes = version === 2 ? packet.readUInt16BE(36) : 0;
  if (packet.length !== headerBytes + hostnameBytes + modelBytes + capabilityBytes) return null;
  const identity = uuid(packet.subarray(16, 32));
  const hostname = packet.toString("utf8", headerBytes, headerBytes + hostnameBytes).trim();
  let decoded = {};
  if (capabilityBytes) {
    try {
      const parsed = normalizeCapabilities(JSON.parse(packet.toString("utf8", headerBytes + hostnameBytes + modelBytes)));
      if (!parsed) return null;
      decoded = parsed;
    }
    catch { return null; }
  }
  return { uuid: identity, label: hostname || `AM6442-${identity.slice(0, 8)}`, ip: sourceIp, port: packet.readUInt16BE(32), ...decoded };
}

export class Ads8688DiscoveryAdapter implements DiscoveryAdapter {
  async discover(): Promise<BoardResponse[]> {
    const address = process.env.DAQ_DISCOVERY_ADDRESS || "255.255.255.255";
    const port = Number(process.env.DAQ_DISCOVERY_PORT || 8764);
    const timeout = Number(process.env.DAQ_DISCOVERY_TIMEOUT_MS || 1000);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeout) || timeout < 50 || timeout > 10000) throw new ApiError(500, "DAQ 탐색 환경변수를 확인해 주세요.", "INVALID_DISCOVERY_CONFIG");
    const nonce = randomBytes(8).readBigUInt64BE();
    const request = Buffer.alloc(16); request.write("A8DQ", 0, "ascii"); request.writeUInt16BE(2, 4); request.writeBigUInt64BE(nonce, 8);
    const found = new Map<string, BoardResponse>();
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      const finish = () => { socket.close(); resolve([...found.values()]); };
      socket.on("error", error => { socket.close(); reject(new ApiError(503, `UDP 탐색에 실패했습니다: ${error.message}`, "DISCOVERY_FAILED")); });
      socket.on("message", (packet, remote) => { const board = decodeDiscoveryResponse(packet, remote.address, nonce); if (board) found.set(board.uuid, board); });
      socket.bind(0, "0.0.0.0", () => { socket.setBroadcast(true); socket.send(request, port, address, error => { if (error) { socket.close(); reject(new ApiError(503, `UDP 탐색 전송에 실패했습니다: ${error.message}`, "DISCOVERY_FAILED")); return; } setTimeout(finish, timeout); }); });
    });
  }
}

/** Persistent TCP framing/reconnect belongs to integration/collector.mjs, not a Route Handler. */
