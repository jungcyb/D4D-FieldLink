export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { cache: "no-store", ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "서버에 연결할 수 없습니다.");
  return payload.data as T;
}
export const send = <T>(path: string, body: unknown, method = "POST") => api<T>(path, { method, body: JSON.stringify(body) });
