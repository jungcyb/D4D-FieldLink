import { randomUUID } from "node:crypto";
import { minMaxEnvelope } from "../signal.ts";
import {parseSensorPrediction,predictionFrame} from "./edge-prediction.ts";
import {parseDaqInfo,applyDaqInfo} from "./daq-info.ts";
import {channelKey,channelRate,samplingFromCapabilities} from "../daq-sampling.ts";
import type { Store, BoardResponse, Daq, Equipment, Sensor, Diagnosis, Task, Reading, Snapshot, SensorView } from "../types.ts";
import { FileRepository } from "./repository.ts";
import { check, object, text, numeric, choice, uuid, ip, timestamp, ApiError } from "./validation.ts";
import { Ads8688DiscoveryAdapter, DemoDiscoveryAdapter, normalizeCapabilities } from "./adapters.ts";
import type { DiscoveryAdapter } from "./adapters.ts";
import { demoValue, rawSamples, DEMO_BOARDS } from "./seed.ts";

const iso = () => new Date().toISOString();
const online = (daq: Daq) => Date.now() - Date.parse(daq.lastSeen) < 30000;
function find<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find(item => item.id === id);
  check(item, "대상을 찾을 수 없습니다.", 404, "NOT_FOUND");
  return item;
}
function board(store: Store, key: string): Daq {
  const daq = store.daqs.find(d => d.uuid === key.toLowerCase());
  check(daq, "DAQ를 찾을 수 없습니다.", 404, "NOT_FOUND"); return daq;
}
function latest<T extends { sensorId: string; timestamp: string }>(items: T[], sensorId: string): T | null {
  return items.filter(r => r.sensorId === sensorId).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] || null;
}
function calibrated(reading: Reading, sensor: Sensor): Reading {
  const { scale, offset } = sensor.calibration;
  return { ...reading, sourceValue: reading.value, value: reading.value * scale + offset, raw: reading.raw.map(value => value * scale + offset) };
}

export class MaintenanceService {
  repository: FileRepository; adapter: DiscoveryAdapter;
  constructor(repository = new FileRepository(), adapter?: DiscoveryAdapter) {
    this.repository = repository;
    this.adapter = adapter || (repository.mode === "demo" ? new DemoDiscoveryAdapter() : new Ads8688DiscoveryAdapter());
  }
  snapshot(): Snapshot {
    this.advanceDemo();
    const store = this.repository.read();
    const lastReadings = new Map<string, Reading>();
    for (const r of store.readings) if (!lastReadings.has(r.sensorId) || r.timestamp > lastReadings.get(r.sensorId)!.timestamp) lastReadings.set(r.sensorId, r);
    const lastDiagnoses = new Map<string, Diagnosis>();
    for (const d of store.diagnoses) if (!lastDiagnoses.has(d.sensorId) || d.timestamp >= lastDiagnoses.get(d.sensorId)!.timestamp) lastDiagnoses.set(d.sensorId, d);
    const daqs = store.daqs.map(d => ({ ...d, online: online(d), sensorCount: store.sensors.filter(s => s.daqUuid === d.uuid).length, equipmentName: store.equipment.find(e => e.id === d.equipmentId)?.name || null }));
    const sensors: SensorView[] = store.sensors.map(s => {
      const d = board(store, s.daqUuid);
      const stored = lastReadings.get(s.id) || null;
      const last = stored ? { ...stored, value: stored.value * s.calibration.scale + s.calibration.offset } : null;
      const preview = last ? { id: last.id, sensorId: last.sensorId, timestamp: last.timestamp, value: last.value, sps: last.sps, source: last.source } : null;
      return { ...s, equipmentId: d.equipmentId, equipmentName: store.equipment.find(e => e.id === d.equipmentId)?.name || null, daqLabel: d.label, latest: preview, diagnosis: lastDiagnoses.get(s.id) || null, online: online(d)&&s.connected!==false };
    });
    const equipment = store.equipment.map(e => {
      const children = sensors.filter(s => s.equipmentId === e.id);
      const severity = children.some(s => s.diagnosis?.severity === "critical") ? "critical" as const : children.some(s => s.diagnosis?.severity === "warning") ? "warning" as const : children.length>0 && children.every(s => s.diagnosis?.severity === "normal") ? "normal" as const : "unknown" as const;
      return { ...e, daqCount: daqs.filter(d => d.equipmentId === e.id).length, sensorCount: children.length, severity, rulHours: null, online: daqs.some(d => d.equipmentId === e.id && d.online), sensors: children };
    });
    const rank = { critical: 0, warning: 1, unknown: 2, normal: 3 };
    const diagnoses = sensors.flatMap(s => s.diagnosis ? [{ ...s.diagnosis, sensorName: s.name, equipmentId: s.equipmentId, equipmentName: s.equipmentName, location: store.equipment.find(e => e.id === s.equipmentId)?.location || null, position: s.position }] : []).sort((a, b) => rank[a.severity] - rank[b.severity] || (a.rulHours ?? Infinity) - (b.rulHours ?? Infinity) || b.timestamp.localeCompare(a.timestamp));
    const tasks = store.tasks.map(t => ({ ...t, equipmentName: find(store.equipment, t.equipmentId).name, location: find(store.equipment, t.equipmentId).location })).sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed") || ({ critical: 0, high: 1, normal: 2 }[a.priority] - { critical: 0, high: 1, normal: 2 }[b.priority]));
    return { mode: store.mode, serverTime: iso(), equipment, sensors, daqs, diagnoses, tasks, summary: { equipment: equipment.length, daqs: daqs.length, onlineDaqs: daqs.filter(d => d.online).length, sensors: sensors.length, critical: equipment.filter(e => e.severity === "critical").length, warning: equipment.filter(e => e.severity === "warning").length, normal: equipment.filter(e => e.severity === "normal").length, unknown: equipment.filter(e => e.severity === "unknown").length, openTasks: tasks.filter(t => t.status !== "completed").length } };
  }
  advanceDemo(): void {
    if (this.repository.mode !== "demo") return;
    const tick = Math.floor(Date.now() / 5000);
    if (this.repository.read().lastDemoTick >= tick) return;
    this.repository.mutate(store => {
      for (const d of store.daqs) {
        if (store.operations?.demoOffline.includes(d.uuid) || d.uuid === DEMO_BOARDS[3].uuid && !store.operations?.demoForceOnline.includes(d.uuid) || !DEMO_BOARDS.some(b => b.uuid === d.uuid)) continue;
        d.lastSeen = iso();
        if(d.acquiring===false)continue;
        for (const s of store.sensors.filter(s => s.daqUuid === d.uuid)) {
          if(s.sps==null||s.sps<=0||s.connected===false)continue;
          const value = demoValue(s, tick);
          store.readings.push({ id: randomUUID(), sensorId: s.id, timestamp: iso(), value, sps: s.sps, raw: rawSamples(s, value, tick), source: "demo" });
        }
      }
      this.trimReadings(store);
      store.lastDemoTick = tick;
    });
  }
  private trimReadings(store: Store): void {
    const configured = Number(process.env.RAW_BATCH_RETENTION);
    const limit = Number.isInteger(configured) && configured > 0 ? configured : store.mode === "external" ? 12 : 720;
    store.readings = store.sensors.flatMap(s => store.readings.filter(r => r.sensorId === s.id).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit));
  }
  upsertBoard(input: unknown): Daq {
    const data = object(input);
    const hasCapabilities = data.channelCount != null || data.channels != null || data.sampleRateGroups != null;
    const capabilities = hasCapabilities ? normalizeCapabilities(data) : null;
    check(!hasCapabilities || capabilities, "DAQ 채널 capability 형식이 올바르지 않습니다.");
    const response: BoardResponse = { uuid: uuid(data.uuid), label: text(data.label || `DAQ ${String(data.uuid).slice(0, 8)}`, "DAQ 이름"), ip: ip(data.ip), port: numeric(data.port, "TCP 포트", 1, 65535), ...(capabilities || {}) };
    check(Number.isInteger(response.port), "TCP 포트는 정수여야 합니다.");
    const info=parseDaqInfo(data);
    if(capabilities&&!info.sampling)info.sampling=samplingFromCapabilities(capabilities);
    return this.repository.mutate(store => {
      const existing = store.daqs.find(d => d.uuid === response.uuid);
      if (existing) { Object.assign(existing, response, { lastSeen: iso() }); applyDaqInfo(store,existing,info); return existing; }
      const newBoard: Daq = { ...response, equipmentId: null, lastSeen: iso(), source: store.mode, createdAt: iso() };
      store.daqs.push(newBoard); applyDaqInfo(store,newBoard,info); return newBoard;
    });
  }
  async discover() {
    const responses = await this.adapter.discover();
    const found = responses.map(r => this.upsertBoard(r));
    return { source: this.repository.mode, count: found.length, boards: found };
  }
  saveEquipment(input: unknown, id?: string): Equipment {
    const data = object(input);
    const fields = { name: text(data.name, "장비명"), category: text(data.category, "장비 종류", 50), location: text(data.location, "설치 위치"), description: text(data.description, "설명", 1000, true) };
    return this.repository.mutate(store => {
      if (id) { const existing = find(store.equipment, id); Object.assign(existing, fields); return existing; }
      const item: Equipment = { id: randomUUID(), ...fields, createdAt: iso() }; store.equipment.push(item); return item;
    });
  }
  bindBoard(key: string, input: unknown): Daq {
    const data = object(input);
    return this.repository.mutate(store => {
      const d = board(store, key);
      const equipmentId = data.equipmentId == null || data.equipmentId === "" ? null : text(data.equipmentId, "장비 ID");
      if (equipmentId) find(store.equipment, equipmentId);
      if (d.equipmentId && d.equipmentId !== equipmentId) {
        const sensorIds = store.sensors.filter(s => s.daqUuid === d.uuid).map(s => s.id);
        check(!store.readings.some(r => sensorIds.includes(r.sensorId)) && !store.diagnoses.some(r => sensorIds.includes(r.sensorId)), "데이터 이력이 있는 DAQ는 장비 연결을 변경할 수 없습니다.", 409, "HAS_HISTORY");
      }
      d.equipmentId = equipmentId;
      if (data.label != null) d.label = text(data.label, "DAQ 이름");
      return d;
    });
  }
  saveSensor(input: unknown, id?: string): Sensor {
    const data = object(input);
    return this.repository.mutate(store => {
      const existing = id ? find(store.sensors, id) : null;
      const daqUuid = uuid(data.daqUuid || existing?.daqUuid);
      const daq=board(store, daqUuid);
      const requested=data.sps==null?null:numeric(data.sps,"SPS",0.01,1000000);
      const sps=existing?.sps??channelRate(daq,String(data.channel||existing?.channel||""))??requested;
      check(!existing || existing.daqUuid === daqUuid, "센서의 DAQ는 변경할 수 없습니다.");
      const fields = { daqUuid, channel: text(data.channel, "채널", 40), name: text(data.name, "센서명"), type: choice(data.type, ["vibration", "temperature", "current", "analog"] as const, "센서 종류"), position: text(data.position, "부착 위치"), unit: text(data.unit, "단위", 20), sps };
      check(!store.sensors.some(s => s.daqUuid === daqUuid && channelKey(s.channel) === channelKey(fields.channel) && s.id !== id), "이 DAQ에 이미 등록된 채널입니다.", 409, "DUPLICATE_CHANNEL");
      if (existing) { Object.assign(existing, fields); existing.registrationSource="manual"; return existing; }
      const sensor: Sensor = { id: randomUUID(), registrationSource:"manual", ...fields, calibration: { scale: 1, offset: 0, inputUnit: data.inputUnit == null ? daq.channels?.find(c=>channelKey(c.id)===channelKey(fields.channel))?.inputUnit || (store.mode === "demo" ? fields.unit : "V") : text(data.inputUnit,"입력 단위",20), updatedAt: null }, photo: null, createdAt: iso() }; store.sensors.push(sensor); return sensor;
    });
  }
  calibrateSensor(sensorId: string, input: unknown): Sensor {
    const data = object(input);
    const scale = numeric(data.scale, "Scale", -1e12, 1e12);
    check(Math.abs(scale) >= 1e-12, "Scale은 0일 수 없습니다.");
    const offset = numeric(data.offset, "Offset", -1e12, 1e12);
    const inputUnit = text(data.inputUnit, "입력 단위", 20);
    return this.repository.mutate(store => {
      const sensor = find(store.sensors, sensorId);
      sensor.calibration = { scale, offset, inputUnit, updatedAt: iso() };
      return sensor;
    });
  }
  setPhoto(sensorId: string, filename: string): Sensor {
    return this.repository.mutate(store => { const s = find(store.sensors, sensorId); s.photo = filename; return s; });
  }
  telemetry(sensorId: string, limit = 120, includeRaw = true, applyCalibration = true): Reading[] {
    this.advanceDemo();
    const store = this.repository.read(); const sensor = find(store.sensors, sensorId);
    const rows = store.readings.filter(r => r.sensorId === sensorId).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit).reverse();
    return rows.map(r => {
      const reading = applyCalibration ? calibrated(r, sensor) : r;
      return includeRaw ? reading : { ...reading, raw: [] };
    });
  }
  rawWindow(sensorId: string, maxPoints = 1200) {
    const r = this.telemetry(sensorId, 1)[0];
    return {sensorId, timestamp:r?.timestamp || null, sps:r?.sps || 1, ...minMaxEnvelope(r?.raw || [], maxPoints)};
  }
  overviewTelemetry(sensorIds: string[], limit = 40) {
    this.advanceDemo(); const store = this.repository.read();
    for (const id of sensorIds) find(store.sensors,id);
    const wanted=new Set(sensorIds), indexed=new Map<string,Reading[]>();
    for(const r of store.readings) if(wanted.has(r.sensorId)) {const rows=indexed.get(r.sensorId)||[];rows.push(r);indexed.set(r.sensorId,rows);}
    return sensorIds.map(sensorId=>{const sensor=find(store.sensors,sensorId);return {sensorId,points:(indexed.get(sensorId)||[]).sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,limit).reverse().map(r=>({timestamp:r.timestamp,value:calibrated(r,sensor).value}))};});
  }
  ingest(input: unknown) {
    let data = object(input);
    const daqUuid = uuid(data.daqUuid);
    const info=data.schema_version===undefined?parseDaqInfo(data):{};
    const converted=data.schema_version!==undefined?predictionFrame({...data,daqUuid},this.repository.read()):null;
    if(converted)data=converted.data;
    const frameReadings=data.readings??[];
    check(Array.isArray(frameReadings) && frameReadings.length <= 100, "readings는 최대 100개 배열이어야 합니다.");
    check(frameReadings.length>0 || Array.isArray(data.diagnoses)&&data.diagnoses.length>0 || info.sampling || info.sensors,"readings, diagnoses 또는 DAQ 정보가 하나 이상 필요합니다.");
    check(data.diagnoses == null || Array.isArray(data.diagnoses) && data.diagnoses.length <= 100, "diagnoses는 최대 100개 배열이어야 합니다.");
    const frameId = data.frameId == null ? null : text(data.frameId, "프레임 ID", 100);
    return this.repository.mutate(store => {
      const daq = board(store, daqUuid);
      const frameKey = frameId ? `${daqUuid}/${frameId}` : null;
      if (frameKey && store.receivedFrames.includes(frameKey)) return { accepted: 0, diagnoses: 0, duplicate: true };
      applyDaqInfo(store,daq,info);
      const channelSensor = (channel: unknown) => {
        const result = store.sensors.find(s => s.daqUuid === daqUuid && typeof channel==="string" && channelKey(s.channel) === channelKey(channel));
        check(result, `등록되지 않은 채널입니다: ${String(channel)}`, 404, "UNKNOWN_CHANNEL"); return result;
      };
      // Build and validate both arrays before mutating any records.
      const readings: Reading[] = (frameReadings as unknown[]).map(input => {
        const r = object(input); const sensor = channelSensor(r.channel);
        check(Array.isArray(r.raw) && r.raw.length > 0 && r.raw.length <= 4096 && r.raw.every(n => typeof n === "number" && Number.isFinite(n)), "raw는 1~4096개의 유한한 숫자 배열이어야 합니다.");
        return { id: randomUUID(), sensorId: sensor.id, timestamp: timestamp(r.timestamp), value: numeric(r.value, "대표값", -1e12, 1e12), sps: numeric(r.sps, "SPS", 0.01, 1000000), raw: r.raw as number[], source: store.mode };
      });
      const diagnoses: Diagnosis[] = ((data.diagnoses || []) as unknown[]).map(input => {
        const d = object(input); const sensor = channelSensor(d.channel);
        const edgePrediction=d.edgePrediction===undefined?undefined:parseSensorPrediction(d.edgePrediction);
        const anomaly=edgePrediction?.anomaly_detection;
        return { id: randomUUID(), receivedAt: iso(), sensorId: sensor.id, timestamp: d.timestamp == null ? iso() : timestamp(d.timestamp), severity: edgePrediction?(anomaly?.status==="ok"?(anomaly.is_anomaly?"warning":"normal"):"unknown"):choice(d.severity, ["normal", "warning", "critical", "unknown"] as const, "진단 상태"), title: text(d.title, "진단명"), description: text(d.description, "진단 설명", 2000), confidence: edgePrediction?null:d.confidence == null ? null : numeric(d.confidence, "신뢰도", 0, 1), rulHours: edgePrediction?(edgePrediction.rul.status==="available"?edgePrediction.rul.estimated_rul_hours:null):d.rulHours == null ? null : numeric(d.rulHours, "RUL", 0, 1e9), ...(edgePrediction?{edgePrediction}:{}), model: text(d.model, "모델명"), source: store.mode, acknowledgedAt: null };
      });
      for (const r of readings) {
        const last = latest(store.readings, r.sensorId);
        if (!last || r.timestamp >= last.timestamp) {const sensor=find(store.sensors, r.sensorId);sensor.sps = r.sps;}
        store.readings.push(r);
      }
      store.diagnoses.push(...diagnoses);
      if(converted){const equipment=find(store.equipment,converted.equipmentId);if(!equipment.edgePrediction||converted.equipmentPrediction.timestamp>=equipment.edgePrediction.timestamp)equipment.edgePrediction=converted.equipmentPrediction;}
      this.trimReadings(store);
      // Keep recent diagnostics plus every diagnostic referenced by a maintenance task.
      const pinned = new Set(store.tasks.map(t => t.diagnosisId));
      store.diagnoses = store.sensors.flatMap(s => {
        const all = store.diagnoses.filter(d => d.sensorId === s.id).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return all.filter((d, i) => i < 100 || pinned.has(d.id));
      });
      daq.lastSeen = iso();
      if (frameKey) { store.receivedFrames.push(frameKey); store.receivedFrames = store.receivedFrames.slice(-10000); }
      return { accepted: readings.length, diagnoses: diagnoses.length, duplicate: false };
    });
  }
  acknowledge(id: string): Diagnosis {
    return this.repository.mutate(store => { const d = find(store.diagnoses, id); d.acknowledgedAt = iso(); return d; });
  }
  saveTask(input: unknown, id?: string): Task {
    const data = object(input);
    return this.repository.mutate(store => {
      const existing = id ? find(store.tasks, id) : null;
      const merged = { ...existing, ...data };
      const equipmentId = text(merged.equipmentId, "장비 ID"); find(store.equipment, equipmentId);
      check(!existing || existing.equipmentId === equipmentId, "기존 정비 작업의 장비는 변경할 수 없습니다.");
      const diagnosisId = merged.diagnosisId == null || merged.diagnosisId === "" ? null : text(merged.diagnosisId, "진단 ID");
      const status = choice(merged.status || "pending", ["pending", "in_progress", "completed"] as const, "작업 상태");
      if (diagnosisId) {
        const diagnosis = find(store.diagnoses, diagnosisId); const sensor = find(store.sensors, diagnosis.sensorId);
        check(board(store, sensor.daqUuid).equipmentId === equipmentId, "진단과 장비가 일치하지 않습니다.");
        check(status === "completed" || !store.tasks.some(t => t.id !== id && t.diagnosisId === diagnosisId && t.status !== "completed"), "이미 이 진단에 대한 정비 작업이 있습니다.", 409, "TASK_EXISTS");
      }
      const dueDate = merged.dueDate ? text(merged.dueDate, "마감일", 10) : null;
      check(!dueDate || /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && Number.isFinite(Date.parse(dueDate)) && new Date(dueDate).toISOString().slice(0, 10) === dueDate, "마감일 형식이 올바르지 않습니다.");
      const fields = { equipmentId, diagnosisId, title: text(merged.title, "작업명"), priority: choice(merged.priority, ["critical", "high", "normal"] as const, "우선순위"), assignee: text(merged.assignee, "담당자", 120, true), status, dueDate, notes: text(merged.notes, "메모", 2000, true), completedAt: status === "completed" ? existing?.completedAt || iso() : null };
      if (existing) { Object.assign(existing, fields); return existing; }
      const task: Task = { id: randomUUID(), ...fields, createdAt: iso() }; store.tasks.push(task); return task;
    });
  }
}
export const service = () => new MaintenanceService();
export { ApiError };
