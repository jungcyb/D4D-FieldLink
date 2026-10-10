import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { service, ApiError } from "@/lib/server/service";
import { operationsHttp } from "@/lib/server/operations-http";
import { OperationsService } from "@/lib/server/operations";
import { eventResponse, publishUpdate } from "@/lib/server/live-events";

import { check,object } from "@/lib/server/validation";

const headers = { "Cache-Control": "no-store" };
const result = (data: unknown, status = 200) => Response.json({ data }, { status, headers });

async function boundedBytes(request: Request, max: number): Promise<Uint8Array> {
  check(Number(request.headers.get("content-length") || 0) <= max, "요청 용량이 너무 큽니다.", 413, "PAYLOAD_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let total = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); throw new ApiError(413, "요청 용량이 너무 큽니다.", "PAYLOAD_TOO_LARGE"); }
    chunks.push(value);
  }
  const output = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
async function jsonBody(request: Request): Promise<unknown> {
  check(request.headers.get("content-type")?.includes("application/json"), "application/json 형식으로 전송해 주세요.", 415);
  const bytes = await boundedBytes(request, 4 * 1024 * 1024);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, "JSON 형식이 올바르지 않습니다.", "INVALID_JSON"); }
}
function authorizeEdge(request: Request) {
  const configured = process.env.EDGE_API_TOKEN;
  if (!configured) return;
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${configured}`);
  check(actual.length === expected.length && timingSafeEqual(actual, expected), "수신 API 인증에 실패했습니다.", 401, "UNAUTHORIZED");
}
async function dispatch(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  try {
    const { path } = await context.params;
    const url = new URL(request.url);
    const method = request.method;
    const [resource, id, action] = path;
    if (method === "GET" && resource === "events" && path.length === 1) return eventResponse(request.signal);
    const svc = service();
    if (method !== "GET" && method !== "HEAD") {
      const origin = request.headers.get("origin");
      // Next may normalize request.url to localhost; compare the browser's Origin
      // against the actual Host header so 127.0.0.1 and local previews work correctly.
      check(!origin || new URL(origin).host === request.headers.get("host"), "다른 출처의 쓰기 요청은 허용하지 않습니다.", 403, "ORIGIN_MISMATCH");
    }
    const extension = await operationsHttp({request,url,path,svc,readJson:()=>jsonBody(request),bytes:max=>boundedBytes(request,max),authorize:()=>authorizeEdge(request)});
    if(extension) return extension;

    if(method === "GET" && resource === "telemetry" && id === "overview" && path.length === 2) {
      const ids = (url.searchParams.get("sensors") || "").split(",").filter(Boolean);
      const limit = Number(url.searchParams.get("limit") || 40);
      check(ids.length > 0 && ids.length <= 12 && new Set(ids).size === ids.length,"1~12개 고유 센서 ID가 필요합니다.");
      check(Number.isInteger(limit) && limit >= 1 && limit <= 120,"limit은 1~120 정수여야 합니다.");
      return result(svc.overviewTelemetry(ids,limit));
    }
    if(method === "GET" && resource === "sensors" && action === "window" && path.length === 3) {
      const maxPoints=Number(url.searchParams.get("maxPoints")||1200);
      check(Number.isInteger(maxPoints)&&maxPoints>=16&&maxPoints<=2400,"maxPoints는 16~2400 정수여야 합니다.");
      return result(svc.rawWindow(id,maxPoints));
    }
    if (method === "GET" && path.length === 1) {
      if (resource === "health") return result({ status: "ok", mode: svc.repository.mode, serverTime: new Date().toISOString() });
      const snapshot = svc.snapshot();
      if (resource === "dashboard") { snapshot.operations = new OperationsService(svc.repository).snapshot(snapshot); return result(snapshot); }
      if (["equipment", "daqs", "sensors", "diagnoses", "tasks"].includes(resource)) return result(snapshot[resource as "equipment" | "daqs" | "sensors" | "diagnoses" | "tasks"]);
    }
    if (method === "GET" && path.length === 2 && ["equipment", "daqs", "sensors", "tasks"].includes(resource)) {
      const items = svc.snapshot()[resource as "equipment" | "daqs" | "sensors" | "tasks"];
      const found = items.find(item => "uuid" in item ? item.uuid === id.toLowerCase() : item.id === id);
      check(found, "대상을 찾을 수 없습니다.", 404, "NOT_FOUND"); return result(found);
    }
    if (method === "GET" && resource === "sensors" && action === "telemetry" && path.length === 3) {
      const limit = Number(url.searchParams.get("limit") || 120);
      check(Number.isInteger(limit) && limit >= 1 && limit <= 720, "limit은 1~720 사이의 정수여야 합니다.");
      const raw = url.searchParams.get("raw") || "true";
      check(raw === "true" || raw === "false", "raw는 true 또는 false여야 합니다.");
      const calibrated = url.searchParams.get("calibrated") || "true";
      check(calibrated === "true" || calibrated === "false", "calibrated는 true 또는 false여야 합니다.");
      return result(svc.telemetry(id, limit, raw === "true", calibrated === "true"));
    }
    if (method === "GET" && resource === "photos" && path.length === 2) {
      check(/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(id), "사진을 찾을 수 없습니다.", 404);
      check(svc.repository.read().sensors.some(s => s.photo === id), "사진을 찾을 수 없습니다.", 404);
      const bytes = readFileSync(join(svc.repository.directory, "photos", svc.repository.mode, id));
      const contentType = id.endsWith(".png") ? "image/png" : id.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return new Response(bytes, { headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
    }
    if (method === "POST" && resource === "discovery" && path.length === 1) return result(await svc.discover());
    if (method === "POST" && resource === "equipment" && path.length === 1) return result(svc.saveEquipment(await jsonBody(request)), 201);
    if (method === "PATCH" && resource === "equipment" && path.length === 2) return result(svc.saveEquipment(await jsonBody(request), id));
    if (method === "PATCH" && resource === "daqs" && path.length === 2) return result(svc.bindBoard(id, await jsonBody(request)));
    if (method === "POST" && resource === "sensors" && path.length === 1) return result(svc.saveSensor(await jsonBody(request)), 201);
    if (method === "PATCH" && resource === "sensors" && action === "calibration" && path.length === 3) return result(svc.calibrateSensor(id, await jsonBody(request)));
    if (method === "PATCH" && resource === "sensors" && path.length === 2) return result(svc.saveSensor(await jsonBody(request), id));
    if (method === "POST" && resource === "sensors" && action === "photo" && path.length === 3) {
      const existing = svc.repository.read().sensors.find(s => s.id === id);
      check(existing, "센서를 찾을 수 없습니다.", 404);
      const bytes = await boundedBytes(request, 6 * 1024 * 1024);
      const contentType = request.headers.get("content-type") || "";
      check(contentType.startsWith("multipart/form-data"), "multipart/form-data의 photo 필드로 전송해 주세요.", 415);
      let form: FormData;
      try { form = await new Request(url, { method: "POST", headers: { "Content-Type": contentType }, body: new Uint8Array(bytes) }).formData(); }
      catch { throw new ApiError(400, "사진 업로드 요청 형식이 올바르지 않습니다.", "INVALID_FORM_DATA"); }
      const photo = form.get("photo");
      check(photo instanceof File && photo.size > 0 && photo.size <= 5 * 1024 * 1024, "5MB 이하의 사진을 선택해 주세요.");
      const buffer = Buffer.from(await photo.arrayBuffer());
      const extension = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png" : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? "jpg" : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
      check(extension, "PNG, JPEG, WebP 이미지 파일만 등록할 수 있습니다.", 415);
      const directory = join(svc.repository.directory, "photos", svc.repository.mode);
      mkdirSync(directory, { recursive: true });
      const filename = `${randomUUID()}.${extension}`;
      const target = join(directory, filename); writeFileSync(target, buffer);
      try { const sensor = svc.setPhoto(id, filename); return result(sensor); }
      catch (error) { unlinkSync(target); throw error; }
    }
    if (method === "POST" && resource === "diagnoses" && action === "acknowledge" && path.length === 3) return result(svc.acknowledge(id));
    if (method === "POST" && resource === "tasks" && path.length === 1) return result(svc.saveTask(await jsonBody(request)), 201);
    if (method === "PATCH" && resource === "tasks" && path.length === 2) return result(svc.saveTask(await jsonBody(request), id));
    if (method === "POST" && resource === "edge" && path.length === 2) {
      authorizeEdge(request);
      if (id === "boards" || id === "frames" || id === "predictions") {
        const ops = new OperationsService(svc.repository); ops.reconcile();
        const data = await jsonBody(request);
        if(id === "predictions")check(object(data).schema_version === "edge_prediction_v0.3", "edge/predictions에는 v0.3 예측 계약을 전송하세요.");
        const received = id === "boards" ? svc.upsertBoard(data) : svc.ingest(data);
        ops.reconcile(); return result(received,id === "boards" ? 200 : 202);
      }
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "API 경로 또는 메서드를 확인해 주세요." } }, { status: 404, headers });
  } catch (error) {
    if (error instanceof ApiError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
    console.error("API error:", error);
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "서버 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." } }, { status: 500, headers });
  }
}
async function mutation(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const response = await dispatch(request, context);
  // Only announce successfully committed data, never a rejected command.
  if (response.ok) {
    const { path } = await context.params;
    if (path[0] === "edge" && path[1] === "frames") {
      const { data } = await response.clone().json();
      if (!data.duplicate) publishUpdate(data.diagnoses ? "diagnoses" : "telemetry");
    } else publishUpdate(path[0] === "edge" && path[1] === "logs" ? "logs" : path[1] === "predictions" ? "diagnoses" : "configuration");
  }
  return response;
}
export const GET = dispatch;
export const POST = mutation;
export const PATCH = mutation;
export const DELETE = mutation;
