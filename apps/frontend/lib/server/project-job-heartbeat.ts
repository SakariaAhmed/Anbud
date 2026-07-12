import "server-only";

const PROJECT_JOB_HEARTBEAT_INTERVAL_MS = 30_000;
const PROJECT_JOB_HEARTBEAT_TIMEOUT_MS = 10_000;

type HeartbeatTimer = ReturnType<typeof setInterval>;
type HeartbeatTimeout = ReturnType<typeof setTimeout>;

type ProjectJobHeartbeatInput = {
  renew: (signal: AbortSignal) => Promise<boolean>;
  onLeaseLost: () => void;
  onError: (error: unknown) => void;
};

type ProjectJobHeartbeatRuntime = {
  setInterval?: (callback: () => void, intervalMs: number) => HeartbeatTimer;
  clearInterval?: (timer: HeartbeatTimer) => void;
  setTimeout?: (callback: () => void, timeoutMs: number) => HeartbeatTimeout;
  clearTimeout?: (timer: HeartbeatTimeout) => void;
};

class ProjectJobHeartbeatTimeoutError extends Error {
  constructor() {
    super("Prosjektjobbens heartbeat nådde tidsgrensen.");
    this.name = "ProjectJobHeartbeatTimeoutError";
  }
}

export class ProjectJobLeaseLostError extends Error {
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
  const scheduleTimeout = runtime.setTimeout ?? setTimeout;
  const cancelTimeout = runtime.clearTimeout ?? clearTimeout;
  let stopped = false;
  let renewalInFlight = false;
  let activeRenewal: AbortController | null = null;
  const timer = schedule(() => {
    if (stopped || renewalInFlight) return;
    renewalInFlight = true;
    const renewal = new AbortController();
    activeRenewal = renewal;
    const renewalTimeout = scheduleTimeout(() => {
      if (stopped || activeRenewal !== renewal) return;
      const error = new ProjectJobHeartbeatTimeoutError();
      stopped = true;
      cancel(timer);
      renewal.abort(error);
      input.onError(error);
    }, PROJECT_JOB_HEARTBEAT_TIMEOUT_MS);
    void input
      .renew(renewal.signal)
      .then((renewed) => {
        if (stopped) return;
        if (!renewed) {
          input.onLeaseLost();
        }
      })
      .catch((error: unknown) => {
        if (!stopped) input.onError(error);
      })
      .finally(() => {
        cancelTimeout(renewalTimeout);
        if (activeRenewal === renewal) activeRenewal = null;
        renewalInFlight = false;
      });
  }, PROJECT_JOB_HEARTBEAT_INTERVAL_MS);

  return () => {
    stopped = true;
    cancel(timer);
    activeRenewal?.abort(new Error("Prosjektjobbens heartbeat ble stoppet."));
    activeRenewal = null;
  };
}
