export type LiveTopic = "telemetry" | "diagnoses" | "logs" | "configuration";
type Listener = (topic: LiveTopic) => void;
// This repository is single-process. Polling remains the recovery path if an
// EventSource is interrupted or a proxy cannot forward streaming responses.
const shared = globalThis as typeof globalThis & { fieldlinkListeners?: Set<Listener> };
const listeners = shared.fieldlinkListeners ??= new Set<Listener>();

export function publishUpdate(topic: LiveTopic) {
  for (const listener of listeners) listener(topic);
}

export function eventResponse(signal: AbortSignal): Response {
  if (listeners.size >= 128) return new Response("Live connection limit", { status: 503 });
  const encoder = new TextEncoder();
  let dispose = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        listeners.delete(update);
        signal.removeEventListener("abort", close);
        controller.close();
      };
      const send = (message: string) => {
        if (closed) return;
        // A slow/disconnected browser must not accumulate unbounded events.
        if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
        controller.enqueue(encoder.encode(message));
      };
      const update: Listener = topic => send(`event: update\ndata: ${JSON.stringify({ topic, at: Date.now() })}\n\n`);
      dispose = () => {
        closed = true;
        clearInterval(heartbeat);
        listeners.delete(update);
        signal.removeEventListener("abort", close);
      };
      const heartbeat = setInterval(() => send(": heartbeat\n\n"), 15000);
      if (signal.aborted) { close(); return; }
      listeners.add(update);
      signal.addEventListener("abort", close, { once: true });
      send("retry: 1000\nevent: ready\ndata: {}\n\n");
    },
    cancel() { dispose(); },
  }, { highWaterMark: 64 });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  } });
}
