import type { OperationsState, OperationsSnapshot } from "./operations-types";
export type Mode = "demo" | "external";
export type Severity = "normal" | "warning" | "critical";
export type SensorType = "vibration" | "temperature" | "current" | "analog";
export type TaskStatus = "pending" | "in_progress" | "completed";
export type Priority = "critical" | "high" | "normal";
export interface Calibration { scale: number; offset: number; inputUnit: string; updatedAt: string | null }
export interface Equipment { id: string; name: string; category: string; location: string; description: string; createdAt: string }
export interface Daq { uuid: string; label: string; ip: string; port: number; equipmentId: string | null; lastSeen: string; source: Mode; createdAt: string }
export interface Sensor { id: string; daqUuid: string; channel: string; name: string; type: SensorType; position: string; unit: string; sps: number; calibration: Calibration; photo: string | null; createdAt: string }
export interface Reading { id: string; sensorId: string; timestamp: string; value: number; sourceValue?: number; sps: number; raw: number[]; source: Mode }
export interface Diagnosis { id: string; sensorId: string; timestamp: string; severity: Severity; title: string; description: string; confidence: number | null; rulHours: number | null; model: string; source: Mode; acknowledgedAt: string | null }
export interface Task { id: string; equipmentId: string; diagnosisId: string | null; title: string; priority: Priority; assignee: string; status: TaskStatus; dueDate: string | null; notes: string; createdAt: string; completedAt: string | null }
export interface Store { operations?: OperationsState; version: 1; mode: Mode; lastDemoTick: number; equipment: Equipment[]; daqs: Daq[]; sensors: Sensor[]; readings: Reading[]; diagnoses: Diagnosis[]; tasks: Task[]; receivedFrames: string[] }
export interface BoardResponse { uuid: string; label: string; ip: string; port: number }
export interface EdgeReading { channel: string; timestamp: string; value: number; sps: number; raw: number[] }
export interface EdgeDiagnosis { channel: string; timestamp?: string; severity: Severity; title: string; description: string; confidence?: number | null; rulHours?: number | null; model: string }
export interface EdgeFrame { daqUuid: string; frameId?: string; readings: EdgeReading[]; diagnoses?: EdgeDiagnosis[] }
export interface SensorView extends Sensor { equipmentId: string | null; equipmentName: string | null; daqLabel: string; latest: Omit<Reading, "raw"> | null; diagnosis: Diagnosis | null; online: boolean }
export interface EquipmentView extends Equipment { daqCount: number; sensorCount: number; online: boolean; severity: Severity | "unknown"; rulHours: number | null; sensors: SensorView[] }
export interface DaqView extends Daq { online: boolean; sensorCount: number; equipmentName: string | null }
export interface DiagnosisView extends Diagnosis { sensorName: string; equipmentId: string | null; equipmentName: string | null; location: string | null; position: string }
export interface TaskView extends Task { equipmentName: string; location: string }
export interface Snapshot { operations?: OperationsSnapshot; mode: Mode; serverTime: string; equipment: EquipmentView[]; daqs: DaqView[]; sensors: SensorView[]; diagnoses: DiagnosisView[]; tasks: TaskView[]; summary: { equipment: number; onlineDaqs: number; daqs: number; sensors: number; critical: number; warning: number; normal: number; unknown: number; openTasks: number } }
