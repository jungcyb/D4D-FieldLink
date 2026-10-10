import { isIP } from "node:net";
export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, message: string, code = "VALIDATION_ERROR") { super(message); this.status = status; this.code = code; }
}
export function check(condition: unknown, message: string, status = 400, code = "VALIDATION_ERROR"): asserts condition {
  if (!condition) throw new ApiError(status, message, code);
}
export function object(input: unknown): Record<string, unknown> {
  check(input !== null && typeof input === "object" && !Array.isArray(input), "JSON 객체를 전송해 주세요.");
  return input as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 120, optional = false): string {
  if (optional && (value == null || value === "")) return "";
  check(typeof value === "string" && value.trim().length > 0 && value.trim().length <= max, `${label}: 1~${max}자를 입력해 주세요.`);
  return value.trim();
}
export function numeric(value: unknown, label: string, min: number, max: number): number {
  check(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max, `${label}: ${min}~${max} 범위의 숫자가 필요합니다.`);
  return value;
}
export function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  check(typeof value === "string" && allowed.includes(value as T), `${label} 값이 올바르지 않습니다.`);
  return value as T;
}
export function uuid(value: unknown): string {
  const result = text(value, "보드 UUID", 36).toLowerCase();
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result), "보드 UUID 형식이 올바르지 않습니다.");
  return result;
}
export function ip(value: unknown): string { const result = text(value, "IP 주소", 50); check(isIP(result), "IP 주소가 올바르지 않습니다."); return result; }
export function timestamp(value: unknown): string {
  const result = text(value, "수집 시각", 40);
  check(/(?:Z|[+-]\d{2}:\d{2})$/.test(result) && Number.isFinite(Date.parse(result)), "수집 시각은 시간대가 포함된 ISO 8601 형식이어야 합니다.");
  check(Date.parse(result) <= Date.now() + 300000, "수집 시각이 현재보다 5분 이상 미래입니다.");
  return new Date(result).toISOString();
}
