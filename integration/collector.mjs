#!/usr/bin/env node

import dgram from "node:dgram";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const TYPES = { HELLO: 1, STATUS: 2, ARCHIVE_INFO: 8, READ_BACKLOG: 9, READ_BACKLOG_V2: 10, STREAM_START_V2: 11, STREAM_START: 6, LIVE_DATA: 0x100, ARCHIVE_DATA: 0x101, ARCHIVE_DATA_V2: 0x102, LIVE_DATA_V2: 0x103, RESPONSE: 0x8000, ERROR: 0xffff };
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dashboardUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:3000";
const stateDirectory = process.env.COLLECTOR_STATE_DIR || join(ROOT, "integration", "state");
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const log = (message, details = "") => console.log(`${new Date().toISOString()} ${message}${details ? ` ${details}` : ""}`);
const activeClients = new Set();

export function rawCodeToVolts(code) { return -10.24 + code * 20.48 / 65536; }
export function decodeFrame(payload, timestamped = false) {
  const prefix = timestamped ? 16 : 8;
  if (payload.length !== prefix + 48) throw new Error("invalid ADS8688 data payload");
  const recordId = payload.readBigUInt64BE(0);
  const receivedNs = timestamped ? payload.readBigUInt64BE(8) : BigInt(Date.now()) * BigInt(1_000_000);
  const frame = payload.subarray(prefix);
  if (frame.readUInt32LE(0) !== 0x38534441 || frame.readUInt16LE(4) !== 1 || frame.readUInt16LE(6) !== 28 || frame.readUInt16LE(24) !== 8 || frame.readUInt16LE(26) !== 1 || frame.readUInt32LE(44) !== crc32(frame.subarray(0, 44))) throw new Error("invalid ADS8688 frame");
  const scanRate=frame.readUInt32LE(20);if(scanRate<1||scanRate>1000000)throw new Error("invalid scan rate");
  return { recordId, timestamp: new Date(Number(receivedNs / BigInt(1_000_000))).toISOString(), sequence: frame.readUInt32LE(8), scanRate, samples: Array.from({ length: 8 }, (_, channel) => rawCodeToVolts(frame.readUInt16LE(28 + channel * 2))) };
}

export function recoveryGaps(plan, firstTimestamp, lastTimestamp) {
  const gaps = [];
  if (plan.raw) {
    if (!firstTimestamp || !lastTimestamp) gaps.push({ stream: "raw", from: plan.from, to: plan.to, reason: "보드 링버퍼 또는 collector 체크포인트에 원본이 남아 있지 않음" });
    else {
      if (firstTimestamp > plan.from) gaps.push({ stream: "raw", from: plan.from, to: firstTimestamp, reason: "보드 링버퍼 시작 이전 구간" });
      if (lastTimestamp < plan.to) gaps.push({ stream: "raw", from: lastTimestamp, to: plan.to, reason: "보드 링버퍼에서 확인되지 않은 끝 구간" });
    }
  }
  if (plan.logs) gaps.push({ stream: "logs", from: plan.from, to: plan.to, reason: "현재 엣지 데몬은 장치 로그를 별도로 보관하지 않음" });
  return gaps;
}

export function recoveryCursor(recovery, earliest) {
  return recovery?.raw && earliest !== null ? earliest - BigInt(1) : null;
}

function message(type, requestId, payload = Buffer.alloc(0)) {
  const packet = Buffer.alloc(12 + payload.length); packet.writeUInt32BE(payload.length, 0); packet.writeUInt16BE(1, 4); packet.writeUInt16BE(type, 6); packet.writeUInt32BE(requestId, 8); payload.copy(packet, 12); return packet;
}

function normalizeDiscoveryCapabilities(value) {
  if (!value || !Array.isArray(value.channels) || !Array.isArray(value.sampleRateGroups) || value.channelCount !== value.channels.length) return null;
  const channels = value.channels.map(channel => Array.isArray(channel) && channel.length === 8 ? {id:channel[0],label:channel[1],adc:channel[2],adcChannel:channel[3],sampleRateHz:channel[4],inputUnit:channel[5],rateGroupId:channel[6],streamAvailable:channel[7]} : channel);
  const sampleRateGroups = value.sampleRateGroups.map(group => Array.isArray(group) && group.length === 8 ? {id:group[0],label:group[1],channelIds:group[2],currentHz:group[3],writable:group[4],...(group[5] == null ? {} : {minHz:group[5]}),...(group[6] == null ? {} : {maxHz:group[6]}),...(group[7] == null ? {} : {stepHz:group[7]})} : group);
  return channels.every(channel => channel && typeof channel.id === "string" && Number.isFinite(channel.sampleRateHz)) && sampleRateGroups.every(group => group && typeof group.id === "string" && Array.isArray(group.channelIds)) ? {...value, channels, sampleRateGroups} : null;
}

export function decodeDiscoveryResponse(packet, sourceIp, nonce) {
  if (packet.length < 36 || packet.toString("ascii", 0, 4) !== "A8DR" || ![1, 2].includes(packet.readUInt16BE(4)) || packet.readUInt16BE(6) || packet.readBigUInt64BE(8) !== nonce) return null;
  const version = packet.readUInt16BE(4), hostnameBytes = packet[34], modelBytes = packet[35], headerBytes = version === 2 ? 38 : 36;
  if (packet.length < headerBytes) return null;
  const capabilitiesBytes = version === 2 ? packet.readUInt16BE(36) : 0;
  if (packet.length !== headerBytes + hostnameBytes + modelBytes + capabilitiesBytes) return null;
  const hex = packet.subarray(16, 32).toString("hex"), uuid = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const hostname = packet.toString("utf8", headerBytes, headerBytes + hostnameBytes), modelOffset = headerBytes + hostnameBytes;
  try {
    const channelCapabilities = capabilitiesBytes ? normalizeDiscoveryCapabilities(JSON.parse(packet.toString("utf8", modelOffset + modelBytes))) : undefined;
    if (capabilitiesBytes && !channelCapabilities) return null;
    return { uuid, ip: sourceIp, port: packet.readUInt16BE(32), hostname, model: packet.toString("utf8", modelOffset, modelOffset + modelBytes), channelCapabilities };
  } catch { return null; }
}

// BOARD_HOST may list several fixed boards ("192.168.0.240,192.168.0.62"); otherwise every board answering UDP discovery is returned.
export async function discoverBoards() {
  if (process.env.BOARD_HOST) {
    const hosts = process.env.BOARD_HOST.split(",").map(host => host.trim()).filter(Boolean);
    return hosts.map(host => ({ ip: host, port: Number(process.env.BOARD_PORT || 8765), hostname: process.env.BOARD_LABEL && hosts.length === 1 ? process.env.BOARD_LABEL : undefined }));
  }
  const nonce = randomBytes(8).readBigUInt64BE(), query = Buffer.alloc(16); query.write("A8DQ", 0, "ascii"); query.writeUInt16BE(2, 4); query.writeBigUInt64BE(nonce, 8);
  return new Promise((resolve, reject) => {
    const socket=dgram.createSocket("udp4"),found=new Map();let finished=false,timer;
    const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);socket.close();error?reject(error):resolve([...found.values()]);};
    socket.on("message",(packet,source)=>{const board=decodeDiscoveryResponse(packet,source.address,nonce);if(board&&(board.channelCapabilities||!found.get(board.uuid)?.channelCapabilities))found.set(board.uuid,board);});
    socket.on("error",finish);
    socket.bind(0,"0.0.0.0",()=>{
      socket.setBroadcast(true);timer=setTimeout(()=>finish(),1000);
      const legacy=Buffer.from(query);legacy.writeUInt16BE(1,4);
      for(const request of [query,legacy])socket.send(request,Number(process.env.BOARD_DISCOVERY_PORT||8764),process.env.BOARD_DISCOVERY_ADDRESS||"255.255.255.255",error=>{if(error)finish(error);});
    });
  });
}

export async function discover() {
  const [board] = await discoverBoards(); if (!board) throw new Error("ADS8688 board not found by UDP discovery"); return board;
}

class BoardClient {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.pending = new Map(); this.requestId = 1; this.onFrame = () => {};
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    socket.on("data", chunk => this.receive(chunk)); socket.on("close", () => { for (const item of this.pending.values()) item.reject(new Error("board connection closed")); this.pending.clear(); this.resolveClosed(); }); socket.on("error", () => {});
  }
  request(type, payload = Buffer.alloc(0)) {
    const requestId = this.requestId++ >>> 0 || this.requestId++;
    return new Promise((resolve, reject) => { this.pending.set(requestId, { type, resolve, reject }); this.socket.write(message(type, requestId, payload)); });
  }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 12) {
      const size = this.buffer.readUInt32BE(0), version = this.buffer.readUInt16BE(4); if (version !== 1 || size > 65536) { this.socket.destroy(new Error("invalid board protocol header")); return; }
      if (this.buffer.length < 12 + size) return;
      const type = this.buffer.readUInt16BE(6), requestId = this.buffer.readUInt32BE(8), payload = this.buffer.subarray(12, 12 + size); this.buffer = this.buffer.subarray(12 + size);
      if ([TYPES.LIVE_DATA, TYPES.ARCHIVE_DATA, TYPES.ARCHIVE_DATA_V2, TYPES.LIVE_DATA_V2].includes(type)) { try { this.onFrame({ ...decodeFrame(payload, type === TYPES.ARCHIVE_DATA_V2 || type === TYPES.LIVE_DATA_V2), archived: type === TYPES.ARCHIVE_DATA || type === TYPES.ARCHIVE_DATA_V2 }); } catch (error) { this.socket.destroy(error); } continue; }
      const pending = this.pending.get(requestId); if (!pending) continue;
      if (type === TYPES.ERROR) { this.pending.delete(requestId); pending.reject(new Error(JSON.parse(payload.toString("utf8")).error)); }
      else if (type === (pending.type | TYPES.RESPONSE)) { this.pending.delete(requestId); pending.resolve(JSON.parse(payload.toString("utf8"))); }
    }
  }
}

async function connect(host, port) {
  const socket = net.createConnection({ host, port }); socket.setKeepAlive(true, 5000); socket.setNoDelay(true);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); }); return new BoardClient(socket);
}

async function dashboard(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers };
  if (path.startsWith("/edge/") && process.env.EDGE_API_TOKEN) headers.Authorization = `Bearer ${process.env.EDGE_API_TOKEN}`;
  const response = await fetch(new URL(`/api${path}`, dashboardUrl), { ...options, headers }); const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `dashboard HTTP ${response.status}`); return payload.data;
}

const statePath = uuid => join(stateDirectory, `${uuid}.json`);
async function saveCursor(uuid, recordId) { await mkdir(stateDirectory, { recursive: true }); const target = statePath(uuid), temporary = `${target}.tmp`; await writeFile(temporary, JSON.stringify({ uuid, lastRecordId: recordId.toString(), updatedAt: new Date().toISOString() })); await rename(temporary, target); }

function channelIndex(channel) { const match = /^CH-?([0-7])$/i.exec(channel); return match ? Number(match[1]) : null; }

export class BatchWriter {
  constructor(uuid, client, recovery = null) { this.uuid = uuid; this.client = client; this.recovery = recovery; this.recoverySequence = recovery?.nextSequence || 0; this.recoveryFirst = null; this.recoveryLast = null; this.frames = []; this.recoveryBatch = false; this.queue = Promise.resolve(); this.error = null; this.lastSaved = null; this.sensors = []; this.sensorRefresh = 0; }
  async refreshSensors() { if (Date.now() - this.sensorRefresh < 5000) return; const sensors = await dashboard("/sensors"); this.sensors = sensors.filter(sensor => sensor.daqUuid === this.uuid && channelIndex(sensor.channel) !== null); this.sensorRefresh = Date.now(); }
  add(frame) {
    const recoveryBatch = Boolean(this.recovery?.raw && frame.timestamp >= this.recovery.from && frame.timestamp <= this.recovery.to);
    // The dashboard places a batch's last sample at first + (n-1)/sps and rejects recovery batches ending after plan.to; when the real rate runs
    // faster than the advertised SPS (ESP/BLE sensors do) that projection overshoots, so start a new batch before it would.
    const overshootsRecovery = recoveryBatch && this.recoveryBatch && Date.parse(this.frames[0]?.timestamp) + this.frames.length * 1000 / frame.scanRate > Date.parse(this.recovery.to) + 1;
    if (this.frames.length && (this.recoveryBatch !== recoveryBatch || overshootsRecovery || this.frames[0].scanRate !== frame.scanRate || frame.recordId !== this.frames.at(-1).recordId + BigInt(1) || this.frames.length >= Math.min(frame.scanRate,4096))) this.closeBatch();
    if (frame.archived && !recoveryBatch) return;
    if (!this.frames.length) this.recoveryBatch = recoveryBatch;
    this.frames.push(frame); if (this.frames.length >= Math.min(frame.scanRate,4096)) this.closeBatch();
  }
  closeBatch() {
    if (!this.frames.length) return; const frames = this.frames, recoveryBatch = this.recoveryBatch; this.frames = [];
    this.queue = this.queue.then(async () => {
      await this.refreshSensors(); const first = frames[0], last = frames.at(-1), readings = this.sensors.map(sensor => {
        const index = channelIndex(sensor.channel), raw = frames.map(frame => frame.samples[index]);
        return { channel: sensor.channel, timestamp: first.timestamp, value: raw.reduce((sum, value) => sum + value, 0) / raw.length, sps: first.scanRate, raw };
      });
      if (readings.length && recoveryBatch) {
        const result = await dashboard(`/recoveries/${this.recovery.id}/batches`, { method: "POST", body: JSON.stringify({ sequence: this.recoverySequence, batchId: `record-${first.recordId}-${last.recordId}`, frame: { readings }, logs: [] }) });
        this.recoverySequence = result.nextSequence; this.recoveryFirst ||= first.timestamp; this.recoveryLast = last.timestamp;
      } else if (readings.length) await dashboard("/edge/frames", { method: "POST", body: JSON.stringify({ daqUuid: this.uuid, frameId: `record-${first.recordId}-${last.recordId}`, readings }) });
      if (!this.recovery) { await saveCursor(this.uuid, last.recordId); this.lastSaved = last.recordId; }
      if (!readings.length) log("waiting for channel registration", this.uuid);
    }).catch(error => { this.error = error; log("dashboard ingest failed", `${this.uuid} ${error.message}`); this.client.socket.destroy(error); });
  }
  async finishRecovery() {
    if (!this.recovery) return;
    this.closeBatch(); await this.queue; if (this.error) throw this.error;
    const missing = recoveryGaps(this.recovery, this.recoveryFirst, this.recoveryLast);
    await dashboard(`/recoveries/${this.recovery.id}/complete`, { method: "POST", body: JSON.stringify({ edgeComplete: true, rawCoveredThrough: this.recovery.to, logsCoveredThrough: this.recovery.to, finalSequence: this.recoverySequence - 1, missing }) });
    log("recovery completed", `plan=${this.recovery.id} batches=${this.recoverySequence} gaps=${missing.length}`); this.recovery = null;
  }
}

class OrderedFrames {
  constructor(writer, expected) { this.writer = writer; this.expected = expected; this.pending = new Map(); }
  accept(frame) { if (this.expected === null) this.expected = frame.recordId; if (frame.recordId < this.expected) return; this.pending.set(frame.recordId.toString(), frame); while (this.pending.has(this.expected.toString())) { const next = this.pending.get(this.expected.toString()); this.pending.delete(this.expected.toString()); this.writer.add(next); this.expected += BigInt(1); } }
}

const ANOMALY_SEVERITY = { normal: "normal", warning: "warning", alarm: "critical" };
const ANOMALY_TITLE = { normal: "진동 RMS 정상 복귀", warning: "진동 RMS 증가 (경고)", alarm: "진동 RMS 급증 (위험)" };
const ANOMALY_MODEL = "edge-rms-sta-lta", SEVERITY_STATE = { normal: "normal", warning: "warning", critical: "alarm" };
const ANOMALY_LOG_LEVEL = { normal: "info", warning: "warning", alarm: "error" };
// Turn the board's STATUS.anomaly (short/long-term RMS) into one dashboard diagnosis (registered channels only) and one device log
// (every channel) per channel state change. `reported` remembers the last state per channel across calls. It starts from the sensor's
// latest dashboard diagnosis from this detector, so a return to normal that happened while the collector was away still clears the
// warning; with none, normal is not reported. Log batch ids are per event, so an event posted again after a reconnect is deduplicated.
export function anomalyEvents(anomaly, reported, sensors) {
  const sensorFor = new Map(sensors.map(sensor => [sensor.channel.toUpperCase(), sensor])), diagnoses = [], logs = [];
  for (const channel of anomaly?.channels || []) {
    if (!ANOMALY_SEVERITY[channel.state]) continue;
    const sensor = sensorFor.get(channel.id.toUpperCase());
    if (!reported.has(channel.id) && sensor?.diagnosis?.model === ANOMALY_MODEL) reported.set(channel.id, SEVERITY_STATE[sensor.diagnosis.severity]);
    const previous = reported.get(channel.id); reported.set(channel.id, channel.state);
    if (previous === channel.state || (previous === undefined && channel.state === "normal")) continue;
    const timestamp = new Date(channel.changed_unix_ms || Date.now()).toISOString(), ratio = channel.ratio.toFixed(2);
    const description = `단기 RMS ${channel.rms_short_v.toFixed(4)} V / 장기 RMS ${channel.rms_long_v.toFixed(4)} V, 비율 ${ratio} (경고 ${anomaly.warn_ratio}·위험 ${anomaly.alarm_ratio}, 시정수 ${anomaly.short_tau_s}s/${anomaly.long_tau_s}s)`;
    if (sensor) diagnoses.push({ channel: channel.id, timestamp, severity: ANOMALY_SEVERITY[channel.state], title: ANOMALY_TITLE[channel.state], model: ANOMALY_MODEL, description });
    logs.push({ batchId: `ad-${channel.id}-${channel.changed_unix_ms || timestamp}-${channel.state}`, log: { timestamp, level: ANOMALY_LOG_LEVEL[channel.state], code: `AD_RMS_${channel.state.toUpperCase()}`, sensorId: sensor?.id ?? null,
      message: `${channel.id}${sensor?.name ? ` (${sensor.name})` : ""} ${ANOMALY_TITLE[channel.state]}: 비율 ${ratio}`,
      metadata: { detector: anomaly.method || "rms_sta_lta", channel: channel.id, state: channel.state, previous: previous ?? null, ratio: channel.ratio, rmsShortV: channel.rms_short_v, rmsLongV: channel.rms_long_v,
        warnRatio: anomaly.warn_ratio, alarmRatio: anomaly.alarm_ratio, shortTauS: anomaly.short_tau_s, longTauS: anomaly.long_tau_s, events: channel.events } } });
  }
  return { diagnoses, logs };
}

function backlogPayload(after, limit = 2000) { const payload = Buffer.alloc(12); payload.writeBigUInt64BE(after, 0); payload.writeUInt32BE(limit, 8); return payload; }

async function runConnection(board) {
  const client = await connect(board.ip, board.port); activeClients.add(client);
  try {
    const hello = await client.request(TYPES.HELLO), uuid = hello.uuid, label = board.hostname || hello.model || "AM6442-SK";
    const status=await client.request(TYPES.STATUS);
    const channelCapabilities=status.channel_capabilities||hello.channel_capabilities||board.channelCapabilities;
    const info={...(channelCapabilities||{}),...(status.sensors!==undefined?{sensors:status.sensors,inventoryComplete:status.inventoryComplete}:hello.sensors!==undefined?{sensors:hello.sensors,inventoryComplete:hello.inventoryComplete}:{}),...(status.sampling!==undefined?{sampling:status.sampling}:hello.sampling!==undefined?{sampling:hello.sampling}:{})};
    await dashboard("/edge/boards", { method: "POST", body: JSON.stringify({ uuid, label, ip: board.ip, port: board.port, ...info }) });
    const recoveries = await dashboard(`/edge/recovery?daqUuid=${encodeURIComponent(uuid)}`), recovery = recoveries.find(plan => plan.status === "pending" || plan.status === "receiving") || null;
    const archive = recovery ? await client.request(TYPES.ARCHIVE_INFO) : null, earliest = archive?.earliest_record_id == null ? null : BigInt(archive.earliest_record_id), cursor = recoveryCursor(recovery, earliest);
    const liveWriter = new BatchWriter(uuid, client), liveFrames = new OrderedFrames(liveWriter, null);
    const recoveryWriter = recovery ? new BatchWriter(uuid, client, recovery) : null, recoveryFrames = recoveryWriter && cursor !== null ? new OrderedFrames(recoveryWriter, cursor + BigInt(1)) : null;
    client.onFrame = frame => frame.archived ? recoveryFrames?.accept(frame) : liveFrames.accept(frame);
    const timestamped = hello.capabilities?.includes("timestamped_stream"), streamType = timestamped ? TYPES.STREAM_START_V2 : TYPES.STREAM_START, backlogType = timestamped ? TYPES.READ_BACKLOG_V2 : TYPES.READ_BACKLOG;
    await client.request(streamType);
    const afterStart = recovery ? await client.request(TYPES.ARCHIVE_INFO) : null, target = afterStart?.latest_record_id == null ? BigInt(0) : BigInt(afterStart.latest_record_id);
    // Kernel keepalive takes minutes to notice a board that lost power or changed IP, so probe it with STATUS and drop the link if it stops answering.
    const heartbeat = setInterval(() => {
      void dashboard("/edge/boards", { method: "POST", body: JSON.stringify({uuid,label,ip:board.ip,port:board.port}) }).catch(error => client.socket.destroy(error));
      const timeout = setTimeout(() => client.socket.destroy(new Error("board stopped answering STATUS")), Number(process.env.BOARD_STATUS_TIMEOUT_MS || 8000));
      client.request(TYPES.STATUS).finally(() => clearTimeout(timeout)).then(status => reportAnomaly(status.anomaly).catch(error => log("anomaly report failed", `${uuid} ${error.message}`)), () => {});
    }, 10000);
    log("collector connected", `${board.ip}:${board.port} uuid=${uuid} timestamped=${timestamped}${recovery ? ` recovery=${recovery.id}` : ""}`);
    const anomalyStates = new Map();
    async function reportAnomaly(anomaly) {
      if (!anomaly) return;
      await liveWriter.refreshSensors(); const { diagnoses, logs } = anomalyEvents(anomaly, anomalyStates, liveWriter.sensors);
      for (const { batchId, log: entry } of logs) { await dashboard("/edge/logs", { method: "POST", body: JSON.stringify({ daqUuid: uuid, batchId, logs: [entry] }) }); log("anomaly", `${uuid} ${entry.code} ${entry.message}`); }
      if (diagnoses.length) await dashboard("/edge/frames", { method: "POST", body: JSON.stringify({ daqUuid: uuid, diagnoses }) });
    }
    let replayCursor = cursor ?? target;
    try {
      while (cursor !== null && replayCursor < target) { const result = await client.request(backlogType, backlogPayload(replayCursor)); replayCursor = BigInt(result.last_record_id); if (!result.returned || replayCursor >= target) break; }
      if (recoveryWriter) await recoveryWriter.finishRecovery();
      await client.closed; return liveWriter.queue;
    } finally { clearInterval(heartbeat); }
  } finally { activeClients.delete(client); client.socket.destroy(); }
}

async function main() {
  let stopping = false; const stop = () => { stopping = true; for (const client of activeClients) client.socket.destroy(); }; process.on("SIGINT", stop); process.on("SIGTERM", stop);
  // One connection per board; discovery keeps running so boards that power up later, or drop and return, are picked up.
  const connections = new Map(), retryAt = new Map(), discoveryInterval = Number(process.env.BOARD_DISCOVERY_INTERVAL_MS || 2000);
  while (!stopping) {
    try {
      const boards = await discoverBoards(); if (!boards.length && !connections.size) log("collector retry", "no board answered UDP discovery");
      for (const board of boards) {
        const key = board.uuid || `${board.ip}:${board.port}`; if (connections.has(key) || (retryAt.get(key) || 0) > Date.now()) continue;
        connections.set(key, runConnection(board).then(() => log("collector disconnected", board.hostname || key)).catch(error => log("collector retry", `${board.hostname || key} ${error instanceof Error ? error.message : String(error)}`)).finally(() => { connections.delete(key); retryAt.set(key, Date.now() + 2000); }));
      }
    } catch (error) { log("discovery failed", error instanceof Error ? error.message : String(error)); }
    if (!stopping) await sleep(discoveryInterval);
  }
  await Promise.allSettled(connections.values());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
