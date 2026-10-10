import dgram from "node:dgram";
import { randomBytes } from "node:crypto";
import type { BoardResponse } from "../types.ts";
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

export function decodeDiscoveryResponse(packet: Buffer, sourceIp: string, nonce: bigint): BoardResponse | null {
  if (packet.length < 36 || packet.toString("ascii", 0, 4) !== "A8DR" || packet.readUInt16BE(4) !== 1 || packet.readUInt16BE(6) !== 0 || packet.readBigUInt64BE(8) !== nonce) return null;
  const hostnameBytes = packet[34], modelBytes = packet[35];
  if (packet.length !== 36 + hostnameBytes + modelBytes) return null;
  const identity = uuid(packet.subarray(16, 32));
  const hostname = packet.toString("utf8", 36, 36 + hostnameBytes).trim();
  return { uuid: identity, label: hostname || `AM6442-${identity.slice(0, 8)}`, ip: sourceIp, port: packet.readUInt16BE(32) };
}

export class Ads8688DiscoveryAdapter implements DiscoveryAdapter {
  async discover(): Promise<BoardResponse[]> {
    const address = process.env.DAQ_DISCOVERY_ADDRESS || "255.255.255.255";
    const port = Number(process.env.DAQ_DISCOVERY_PORT || 8764);
    const timeout = Number(process.env.DAQ_DISCOVERY_TIMEOUT_MS || 1000);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeout) || timeout < 50 || timeout > 10000) throw new ApiError(500, "DAQ 탐색 환경변수를 확인해 주세요.", "INVALID_DISCOVERY_CONFIG");
    const nonce = randomBytes(8).readBigUInt64BE();
    const request = Buffer.alloc(16); request.write("A8DQ", 0, "ascii"); request.writeUInt16BE(1, 4); request.writeBigUInt64BE(nonce, 8);
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
