export type DistributedRateLimitCircuitState = {
  status: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openCount: number;
  openUntil: number;
  probeInFlight: boolean;
};

export type DistributedRateLimitCircuitOptions = {
  failureThreshold: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
};

export const DEFAULT_DISTRIBUTED_RATE_LIMIT_CIRCUIT_OPTIONS = {
  failureThreshold: 2,
  baseCooldownMs: 5_000,
  maxCooldownMs: 60_000,
} satisfies DistributedRateLimitCircuitOptions;

export function createDistributedRateLimitCircuitState(): DistributedRateLimitCircuitState {
  return {
    status: "closed",
    consecutiveFailures: 0,
    openCount: 0,
    openUntil: 0,
    probeInFlight: false,
  };
}

export function beginDistributedRateLimitAttempt(
  state: DistributedRateLimitCircuitState,
  now: number,
) {
  if (state.status === "closed") {
    return true;
  }

  if (state.status === "open") {
    if (now < state.openUntil) {
      return false;
    }
    state.status = "half_open";
  }

  if (state.probeInFlight) {
    return false;
  }

  state.probeInFlight = true;
  return true;
}

export function recordDistributedRateLimitSuccess(
  state: DistributedRateLimitCircuitState,
) {
  state.status = "closed";
  state.consecutiveFailures = 0;
  state.openCount = 0;
  state.openUntil = 0;
  state.probeInFlight = false;
}

export function recordDistributedRateLimitFailure(
  state: DistributedRateLimitCircuitState,
  now: number,
  options: DistributedRateLimitCircuitOptions =
    DEFAULT_DISTRIBUTED_RATE_LIMIT_CIRCUIT_OPTIONS,
) {
  const failedHalfOpenProbe = state.status === "half_open";
  state.probeInFlight = false;
  state.consecutiveFailures += 1;

  if (
    !failedHalfOpenProbe &&
    state.consecutiveFailures < Math.max(1, options.failureThreshold)
  ) {
    state.status = "closed";
    return;
  }

  state.status = "open";
  state.openCount += 1;
  const cooldownMs = Math.min(
    Math.max(1, options.maxCooldownMs),
    Math.max(1, options.baseCooldownMs) * 2 ** Math.max(0, state.openCount - 1),
  );
  state.openUntil = now + cooldownMs;
}

export async function withAbortTimeout<T>(
  run: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
): Promise<T | null> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Distributed rate-limit request timed out."));
      resolve(null);
    }, Math.max(1, timeoutMs));
  });

  try {
    return await Promise.race([Promise.resolve(run(controller.signal)), timeout]);
  } catch (error) {
    if (timedOut || controller.signal.aborted) {
      return null;
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
