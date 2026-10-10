"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeLive } from "@/lib/live-client";
import { refreshLoop } from "@/lib/refresh-loop";

export function useLiveRefresh(load: (signal: AbortSignal) => Promise<void>, { paused = false, logs = false } = {}) {
  const [live, setLive] = useState(false);
  const request = useRef<() => Promise<void>>(() => Promise.resolve());
  const refresh = useCallback(async () => { await request.current(); }, []);
  useEffect(() => {
    if (paused) return;
    const loop = refreshLoop(load);
    const visible = () => document.hidden ? Promise.resolve() : loop.request();
    request.current = visible;
    const unsubscribe = subscribeLive(notice => {
      setLive(notice.type !== "disconnected");
      if (notice.type !== "update" || !logs || notice.topic !== "telemetry") visible();
    });
    // Also repairs missed events and time-derived offline status. A stalled SSE
    // proxy cannot leave the screen showing an old alarm indefinitely.
    const timer = setInterval(visible, 1000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    visible();
    return () => {
      request.current = () => Promise.resolve();
      loop.stop(); unsubscribe(); clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
    };
  }, [load, paused, logs]);
  return { live: live && !paused, refresh };
}
