export type LiveNotice = { type: "connected" | "disconnected" | "update"; topic?: string };
type Listener = (notice: LiveNotice) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
function notify(notice: LiveNotice) { for (const listener of listeners) listener(notice); }

/** One same-origin SSE connection shared by the visible dashboard and logs. */
export function subscribeLive(listener: Listener) {
  listeners.add(listener);
  if (!source && typeof EventSource !== "undefined") {
    source = new EventSource("/api/events");
    source.addEventListener("ready", () => { connected = true; notify({ type: "connected" }); });
    source.addEventListener("update", event => {
      try { notify({ type: "update", topic: JSON.parse((event as MessageEvent).data).topic }); }
      catch { /* Malformed notifications cannot replace server data. */ }
    });
    source.onerror = () => { connected = false; notify({ type: "disconnected" }); };
  }
  listener({ type: connected ? "connected" : "disconnected" });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { source?.close(); source = null; connected = false; }
  };
}
