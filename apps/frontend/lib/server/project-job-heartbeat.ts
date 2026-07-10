import "server-only";

const PROJECT_JOB_HEARTBEAT_INTERVAL_MS = 30_000;

type HeartbeatTimer = ReturnType<typeof setInterval>;

type ProjectJobHeartbeatInput = {
  renew: () => Promise<boolean>;
  onLeaseLost: () => void;
  onError: (error: unknown) => void;
};

type ProjectJobHeartbeatRuntime = {
  setInterval?: (callback: () => void, intervalMs: number) => HeartbeatTimer;
  clearInterval?: (timer: HeartbeatTimer) => void;
};

class ProjectJobLeaseLostError extends Error {
  constructor(jobId: string, options: { cause?: unknown } = {}) {
    super(`Prosjektjobb ${jobId} mistet lease-eierskapet.`, options);
    this.name = "ProjectJobLeaseLostError";
  }
}

export type ProjectJobLeaseGuard = {
  signal: AbortSignal;
  assertActive: () => void;
  abort: (cause?: unknown) => void;
};

export function createProjectJobLeaseGuard(jobId: string): ProjectJobLeaseGuard {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    assertActive() {
      controller.signal.throwIfAborted();
    },
    abort(cause?: unknown) {
      if (!controller.signal.aborted) {
        controller.abort(new ProjectJobLeaseLostError(jobId, { cause }));
      }
    },
  };
}

export function isProjectJobLeaseLostError(
  error: unknown,
): error is ProjectJobLeaseLostError {
  return error instanceof ProjectJobLeaseLostError;
}

export function startProjectJobHeartbeat(
  input: ProjectJobHeartbeatInput,
  runtime: ProjectJobHeartbeatRuntime = {},
) {
  const schedule = runtime.setInterval ?? setInterval;
  const cancel = runtime.clearInterval ?? clearInterval;
  const timer = schedule(() => {
    void input
      .renew()
      .then((renewed) => {
        if (!renewed) {
          input.onLeaseLost();
        }
      })
      .catch(input.onError);
  }, PROJECT_JOB_HEARTBEAT_INTERVAL_MS);

  return () => cancel(timer);
}
