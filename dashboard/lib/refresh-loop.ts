/** Coalesce bursts, never overlap requests, and retain an update received
 * during a fetch instead of silently dropping it. */
export function refreshLoop(load: (signal: AbortSignal) => Promise<void>, delay = 100) {
  const controller = new AbortController();
  let active = false, pending = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiters: (() => void)[] = [];
  const run = async () => {
    timer = undefined;
    if (stopped || active) return;
    active = true; pending = false;
    const completed = waiters; waiters = [];
    try { await load(controller.signal); }
    finally {
      active = false;
      for (const resolve of completed) resolve();
      if (pending && !stopped) timer = setTimeout(() => void run(), delay);
    }
  };
  return {
    request() {
      if (stopped) return Promise.resolve();
      pending = true;
      if (!active && timer === undefined) timer = setTimeout(() => void run(), delay);
      return new Promise<void>(resolve => waiters.push(resolve));
    },
    stop() { stopped = true; controller.abort(); clearTimeout(timer); for (const resolve of waiters) resolve(); waiters = []; },
  };
}
