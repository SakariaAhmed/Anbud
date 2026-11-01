import "server-only";

type ElapsedProgressTimers = {
  now: () => number;
  setInterval: (callback: () => void, intervalMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

const defaultTimers: ElapsedProgressTimers = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function formatElapsedSeconds(elapsedMs: number) {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
}

/**
 * Report how long one long step has been running. The step itself gives no
 * intermediate signal, so the message states elapsed time instead of claiming
 * sub-phases or a completion percentage derived from elapsed time.
 *
 * A progress write that throws (the job's lease was lost or the job was
 * cancelled) stops the ticker; the step observes the cancellation itself.
 */
export async function runWithElapsedProgress<T>(
  input: {
    onProgress?: (message: string) => void;
    label: string;
    slowLabel: string;
    startPercent: number;
    ceiling: number;
    expectedMs: number;
    intervalMs?: number;
    timers?: ElapsedProgressTimers;
  },
  run: () => Promise<T>,
) {
  const onProgress = input.onProgress;
  if (!onProgress) return run();

  const timers = input.timers ?? defaultTimers;
  const startedAt = timers.now();
  const report = (elapsedMs: number) => {
    const label = elapsedMs > input.expectedMs ? input.slowLabel : input.label;
    onProgress(`${label} (${formatElapsedSeconds(elapsedMs)})`);
  };

  let handle: unknown = null;
  const stop = () => {
    if (handle !== null) timers.clearInterval(handle);
    handle = null;
  };
  report(0);
  handle = timers.setInterval(() => {
    try {
      report(timers.now() - startedAt);
    } catch {
      stop();
    }
  }, input.intervalMs ?? 10_000);

  try {
    return await run();
  } finally {
    stop();
  }
}
