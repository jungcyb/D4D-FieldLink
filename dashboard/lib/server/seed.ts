import type { BoardResponse, Store, Sensor, Severity } from "../types.ts";

// Fixed UUIDs stand for responses issued by demo boards. The server never assigns a DAQ UUID.
export const DEMO_BOARDS: BoardResponse[] = [
  { uuid: "a7100001-2026-4000-8000-000000000001", label: "DAQ-GEN-01", ip: "192.168.10.101", port: 9000 },
  { uuid: "a7100002-2026-4000-8000-000000000002", label: "DAQ-COOL-02", ip: "192.168.10.102", port: 9000 },
  { uuid: "a7100003-2026-4000-8000-000000000003", label: "DAQ-PUMP-03", ip: "192.168.10.103", port: 9000 },
  { uuid: "a7100004-2026-4000-8000-000000000004", label: "DAQ-VEH-04", ip: "192.168.10.104", port: 9000 },
  { uuid: "a7100005-2026-4000-8000-000000000005", label: "DAQ-SPARE-05", ip: "192.168.10.105", port: 9000 },
  { uuid: "a7100006-2026-4000-8000-000000000006", label: "DAQ-NEW-06", ip: "192.168.10.106", port: 9000 },
];
export function emptyStore(mode: Store["mode"]): Store { return { version: 1, mode, lastDemoTick: 0, equipment: [], daqs: [], sensors: [], readings: [], diagnoses: [], tasks: [], receivedFrames: [] }; }
export function demoValue(sensor: Sensor, tick: number): number {
  const nominal = sensor.type === "vibration" ? (sensor.id === "s-gen-v" ? 7.8 : 2.1) : sensor.type === "temperature" ? (sensor.id === "s-cool-t" ? 78 : 44) : 12.4;
  return Number((nominal + Math.sin(tick * 0.53 + sensor.id.length) * nominal * 0.07 + Math.cos(tick * 1.7) * nominal * 0.025).toFixed(3));
}
export function rawSamples(sensor: Sensor, value: number, tick: number): number[] {
  return Array.from({ length: 64 }, (_, i) => Number((sensor.type === "vibration" ? Math.sin(i * 0.66 + tick) * value * 1.3 + Math.sin(i * 2.1) * value * 0.23 : value + Math.sin(i * 0.27 + tick) * value * 0.015).toFixed(4)));
}
export function makeDemoStore(): Store {
  const store = emptyStore("demo");
  const now = Date.now();
  const createdAt = new Date(now - 86400000).toISOString();
  const names = ["비상 발전기 G-01", "냉각장치 C-02", "급수 펌프 P-03", "지원 차량 V-04"];
  const categories = ["발전기", "냉각장치", "펌프", "차량"];
  const locations = ["A동 · 발전실", "B동 · 냉각실", "C동 · 급수실", "정비동 · 차고"];
  store.equipment = names.map((name, i) => ({ id: `eq-${i + 1}`, name, category: categories[i], location: locations[i], description: "해커톤 시연용 장비입니다. 표시된 측정값과 진단은 모의 데이터입니다.", createdAt }));
  store.daqs = DEMO_BOARDS.slice(0, 5).map((board, i) => ({ ...board, equipmentId: i < 4 ? `eq-${i + 1}` : null, lastSeen: new Date(now - (i === 3 ? 600000 : 1000)).toISOString(), source: "demo", createdAt }));
  const specs: [string, number, Sensor["type"], string, string, number][] = [
    ["s-gen-v", 0, "vibration", "발전기 베어링 진동", "구동축 베어링 외측", 1000],
    ["s-gen-t", 0, "temperature", "발전기 표면 온도", "엔진 블록 상단", 1],
    ["s-cool-t", 1, "temperature", "냉각수 출구 온도", "열교환기 출구 배관", 1],
    ["s-cool-i", 1, "current", "압축기 소비 전류", "압축기 전원 입력부", 100],
    ["s-pump-v", 2, "vibration", "펌프 모터 진동", "모터 하우징 측면", 1000],
    ["s-pump-i", 2, "current", "펌프 소비 전류", "모터 전원 입력부", 100],
    ["s-veh-v", 3, "vibration", "차량 엔진 진동", "엔진 마운트", 1000],
  ];
  store.sensors = specs.map(([id, index, type, name, position, sps], i) => {
    const unit = type === "vibration" ? "mm/s" : type === "temperature" ? "°C" : "A";
    return { id, daqUuid: DEMO_BOARDS[index].uuid, channel: `CH-${i % 2 + 1}`, name, type, position, unit, sps, calibration: { scale: 1, offset: 0, inputUnit: unit, updatedAt: null }, photo: null, createdAt };
  });
  for (const sensor of store.sensors) {
    for (let t = 0; t < 48; t++) {
      const value = demoValue(sensor, t);
      store.readings.push({ id: `${sensor.id}-${t}`, sensorId: sensor.id, timestamp: new Date(now - (48 - t) * 5000 - (sensor.id === "s-veh-v" ? 600000 : 0)).toISOString(), value, sps: sensor.sps, raw: rawSamples(sensor, value, t), source: "demo" });
    }
    const severity: Severity = sensor.id === "s-gen-v" ? "critical" : sensor.id === "s-cool-t" ? "warning" : "normal";
    store.diagnoses.push({ id: `diag-${sensor.id}`, sensorId: sensor.id, timestamp: new Date(now - 20000).toISOString(), severity, title: severity === "critical" ? "베어링 마모 징후" : severity === "warning" ? "냉각 효율 저하 징후" : "정상 운전 범위", description: severity === "critical" ? "모의 진단: 베어링 진동 증가 패턴입니다. 베어링 점검 및 교체 준비를 권장합니다." : severity === "warning" ? "모의 진단: 냉각수 온도 상승 패턴입니다. 냉각수와 필터 상태를 점검하세요." : "모의 진단: 입력 신호가 정상 범위에 있습니다.", confidence: severity === "critical" ? 0.96 : severity === "warning" ? 0.91 : 0.98, rulHours: severity === "critical" ? 36 : severity === "warning" ? 120 : null, model: "DEMO · simulated result", source: "demo", acknowledgedAt: null });
  }
  store.tasks.push({ id: "task-gen", equipmentId: "eq-1", diagnosisId: "diag-s-gen-v", title: "발전기 베어링 점검 및 교체 준비", priority: "critical", assignee: "정비 1팀", status: "pending", dueDate: null, notes: "진동 센서의 모의 진단 결과를 바탕으로 생성된 데모 작업입니다.", createdAt, completedAt: null });
  store.lastDemoTick = Math.floor(now / 5000);
  return store;
}
