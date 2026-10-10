import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { FileRepository } from "../lib/server/repository.ts";
import { MaintenanceService } from "../lib/server/service.ts";
import { ApiError } from "../lib/server/validation.ts";
import { UnconfiguredDiscoveryAdapter, decodeDiscoveryResponse } from "../lib/server/adapters.ts";
const boardResponse = { uuid: "11111111-2222-4333-8444-555555555555", label: "DAQ-TEST", ip: "192.168.10.55", port: 9000 };
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "fieldlink-test-"));
  t.after(() => { assert.equal(resolve(directory).startsWith(resolve(tmpdir())), true); assert.equal(basename(directory).startsWith("fieldlink-test-"), true); rmSync(directory, { recursive: true, force: true }); });
  const repo = new FileRepository(directory, "external"); const service = new MaintenanceService(repo);
  service.upsertBoard(boardResponse);
  const equipment = service.saveEquipment({ name: "테스트 발전기", category: "발전기", location: "테스트실" });
  service.bindBoard(boardResponse.uuid, { equipmentId: equipment.id });
  const sensor = service.saveSensor({ daqUuid: boardResponse.uuid, channel: "CH-1", name: "진동 센서", type: "vibration", position: "베어링", unit: "mm/s", sps: 1000 });
  return { service, repo, equipment, sensor };
}
test("same board UUID updates address and preserves equipment binding", t => {
  const { service, equipment } = setup(t);
  service.upsertBoard({ ...boardResponse, uuid: boardResponse.uuid.toUpperCase(), ip: "192.168.10.77" });
  const snapshot = service.snapshot();
  assert.equal(snapshot.daqs.length, 1); assert.equal(snapshot.daqs[0].equipmentId, equipment.id); assert.equal(snapshot.daqs[0].ip, "192.168.10.77");
});
test("equipment and sensor changes survive a new repository instance", t => {
  const { service, repo, equipment, sensor } = setup(t);
  service.saveEquipment({ ...equipment, location: "B동" }, equipment.id);
  const fresh = new MaintenanceService(new FileRepository(repo.directory, "external")).snapshot();
  assert.equal(fresh.equipment[0].location, "B동"); assert.equal(fresh.sensors[0].id, sensor.id); assert.equal(fresh.mode, "external");
});
test("rejects duplicate channels and missing/invalid board UUIDs", t => {
  const { service } = setup(t);
  assert.throws(() => service.saveSensor({ daqUuid: boardResponse.uuid, channel: "CH-1", name: "other", type: "temperature", position: "top", unit: "C", sps: 1 }), (e: unknown) => e instanceof ApiError && e.status === 409);
  assert.throws(() => service.upsertBoard({ ...boardResponse, uuid: undefined }), ApiError);
  assert.throws(() => service.upsertBoard({ ...boardResponse, port: 2.5 }), ApiError);
});
test("ingestion is atomic, frame retries deduplicate, offline replay preserves newest sample", t => {
  const { service, repo, sensor } = setup(t); const at = new Date().toISOString();
  const frame = { daqUuid: boardResponse.uuid, frameId: "f-1", readings: [{ channel: "CH-1", timestamp: at, value: 2.7, sps: 1000, raw: [1,2,3] }], diagnoses: [{ channel: "CH-1", timestamp: at, severity: "critical", title: "마모 징후", description: "엣지 결과", confidence: .9, rulHours: 0, model: "edge-v1" }] };
  assert.deepEqual(service.ingest(frame), { accepted: 1, diagnoses: 1, duplicate: false });
  assert.deepEqual(service.ingest(frame), { accepted: 0, diagnoses: 0, duplicate: true });
  const before = readFileSync(repo.filename, "utf8");
  assert.throws(() => service.ingest({ ...frame, frameId: "bad", readings: [...frame.readings, { ...frame.readings[0], channel: "CH-missing" }] }), ApiError);
  assert.equal(readFileSync(repo.filename, "utf8"), before);
  service.ingest({ daqUuid: boardResponse.uuid, readings: [{ channel: "CH-1", timestamp: new Date(Date.now()-100000).toISOString(), value: 1, sps: 100, raw: [1] }] });
  const snapshot = service.snapshot(); assert.equal(snapshot.sensors[0].sps, 1000); assert.equal(snapshot.sensors[0].latest?.value, 2.7); assert.equal(snapshot.equipment[0].rulHours, null); assert.equal(snapshot.sensors[0].diagnosis?.rulHours, 0);
  assert.equal(service.telemetry(sensor.id).length, 2);
});
test("affine calibration changes API values without changing stored samples", t => {
  const { service, repo, sensor } = setup(t); const at = new Date().toISOString();
  service.ingest({ daqUuid: boardResponse.uuid, readings: [{ channel: "CH-1", timestamp: at, value: 2, sps: 1000, raw: [1, 2, 3] }] });
  service.calibrateSensor(sensor.id, { scale: -2, offset: 1, inputUnit: "V" });
  const output = service.telemetry(sensor.id)[0];
  assert.equal(output.value, -3); assert.deepEqual(output.raw, [-1, -3, -5]); assert.equal(output.sourceValue, 2);
  const source = service.telemetry(sensor.id, 1, true, false)[0];
  assert.equal(source.value, 2); assert.deepEqual(source.raw, [1, 2, 3]);
  const stored = JSON.parse(readFileSync(repo.filename, "utf8"));
  assert.equal(stored.readings[0].value, 2); assert.deepEqual(stored.readings[0].raw, [1, 2, 3]);
  assert.throws(() => service.calibrateSensor(sensor.id, { scale: 0, offset: 0, inputUnit: "V" }), ApiError);
});
test("external hot telemetry keeps a bounded number of raw batches", t => {
  const { service, repo, sensor } = setup(t);
  for (let i = 0; i < 15; i++) service.ingest({ daqUuid: boardResponse.uuid, readings: [{ channel: "CH-1", timestamp: new Date(Date.now() + i).toISOString(), value: i, sps: 1000, raw: [i] }] });
  const readings = repo.read().readings.filter(reading => reading.sensorId === sensor.id);
  assert.equal(readings.length, 12); assert.equal(Math.min(...readings.map(reading => reading.value)), 3);
});
test("task workflow pins diagnosis and prevents duplicate active tasks", t => {
  const { service, equipment } = setup(t);
  service.ingest({ daqUuid: boardResponse.uuid, readings: [{ channel: "CH-1", timestamp: new Date().toISOString(), value: 7, sps: 1000, raw: [7] }], diagnoses: [{ channel: "CH-1", severity: "critical", title: "마모", description: "결과", rulHours: 36, model: "edge-v1" }] });
  const diagnosis = service.snapshot().diagnoses[0];
  const input = { equipmentId: equipment.id, diagnosisId: diagnosis.id, title: "베어링 점검", priority: "critical" };
  const task = service.saveTask(input); assert.throws(() => service.saveTask(input), (e: unknown) => e instanceof ApiError && e.code === "TASK_EXISTS");
  assert.equal(service.saveTask({ status: "in_progress" }, task.id).status, "in_progress");
  const complete = service.saveTask({ status: "completed" }, task.id); assert.ok(complete.completedAt);
  const reopened = service.saveTask({ status: "pending" }, task.id); assert.equal(reopened.completedAt, null);
  service.acknowledge(diagnosis.id); assert.equal(service.snapshot().equipment[0].severity, "critical");
  assert.throws(() => service.bindBoard(boardResponse.uuid, { equipmentId: null }), (e: unknown) => e instanceof ApiError && e.status === 409);
});
test("external discovery fails explicitly until a board adapter is configured", async t => {
  const { repo } = setup(t); const service = new MaintenanceService(repo, new UnconfiguredDiscoveryAdapter());
  await assert.rejects(service.discover(), (e: unknown) => e instanceof ApiError && e.status === 503);
});
test("ADS8688 UDP discovery response decodes UUID, address and TCP port", () => {
  const nonce = BigInt(1234), packet = Buffer.alloc(36 + 8 + 18);
  packet.write("A8DR", 0, "ascii"); packet.writeUInt16BE(1, 4); packet.writeBigUInt64BE(nonce, 8);
  Buffer.from("11111111222243338444555555555555", "hex").copy(packet, 16); packet.writeUInt16BE(8765, 32); packet[34] = 8; packet[35] = 18;
  packet.write("sk-am64b", 36, "utf8"); packet.write("AM6442-SK+ADS8688", 44, "utf8");
  assert.deepEqual(decodeDiscoveryResponse(packet, "192.168.0.240", nonce), { uuid: boardResponse.uuid, label: "sk-am64b", ip: "192.168.0.240", port: 8765 });
  assert.equal(decodeDiscoveryResponse(packet, "192.168.0.240", BigInt(999)), null);
});
test("discovery v2 carries channel rates and writable rate groups", () => {
  const nonce = BigInt(42), capability = Buffer.from(JSON.stringify({channelCount:2,channels:[
    {id:"CH0",label:"ADS8688 CH0",adc:"ADS8688",adcChannel:"AIN0",sampleRateHz:1000,inputUnit:"V",rateGroupId:"ads8688.scan",streamAvailable:true},
    {id:"ADS1263-AIN0_AIN1",label:"ADS1263 AIN0–AIN1",adc:"ADS1263",adcChannel:"AIN0-AIN1",sampleRateHz:400,inputUnit:"code",rateGroupId:"ads1263.adc1",streamAvailable:false},
  ],sampleRateGroups:[{id:"ads8688.scan",label:"ADS8688 공통",channelIds:["CH0"],currentHz:1000,writable:true,minHz:10,maxHz:2000,stepHz:1},{id:"ads1263.adc1",label:"ADS1263 ADC1",channelIds:["ADS1263-AIN0_AIN1"],currentHz:400,writable:false}]}));
  const hostname=Buffer.from("sk-am64b"),model=Buffer.from("AM6442-SK+ADS8688+ADS1263"),packet=Buffer.alloc(38+hostname.length+model.length+capability.length);
  packet.write("A8DR");packet.writeUInt16BE(2,4);packet.writeBigUInt64BE(nonce,8);Buffer.from("11111111222243338444555555555555","hex").copy(packet,16);packet.writeUInt16BE(8765,32);packet[34]=hostname.length;packet[35]=model.length;packet.writeUInt16BE(capability.length,36);hostname.copy(packet,38);model.copy(packet,38+hostname.length);capability.copy(packet,38+hostname.length+model.length);
  const result=decodeDiscoveryResponse(packet,"192.168.0.240",nonce);assert.equal(result?.channelCount,2);assert.equal(result?.channels?.[1].sampleRateHz,400);assert.deepEqual(result?.sampleRateGroups?.filter(group=>group.writable).map(group=>group.channelIds),[["CH0"]]);
});
test("demo discovery repeats do not duplicate UUIDs and demo data is separated from real data", async t => {
  const directory = mkdtempSync(join(tmpdir(), "fieldlink-test-"));
  t.after(() => { assert.ok(basename(directory).startsWith("fieldlink-test-")); rmSync(directory, { recursive: true, force: true }); });
  const service = new MaintenanceService(new FileRepository(directory, "demo"));
  const initial = service.snapshot(); assert.equal(initial.equipment.length, 4);
  await service.discover(); await service.discover(); assert.equal(service.snapshot().daqs.length, 6);
  const external = new MaintenanceService(new FileRepository(directory, "external")); assert.equal(external.snapshot().daqs.length, 0); assert.equal(external.snapshot().equipment.length, 0);
});
