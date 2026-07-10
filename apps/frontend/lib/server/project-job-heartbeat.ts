import "server-only";

export const PROJECT_JOB_HEARTBEAT_INTERVAL_MS = 30_000;

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
