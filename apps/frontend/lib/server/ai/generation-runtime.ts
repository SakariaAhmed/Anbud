import "server-only";

const REQUIREMENT_RESPONSE_PROGRESS_HEARTBEAT_MS = 35_000;

export function boundedIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

type ConcurrentTaskResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export function startConcurrentTasks<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const resolvers: Array<(result: ConcurrentTaskResult<R>) => void> = [];
  const taskPromises = items.map(
    () =>
      new Promise<ConcurrentTaskResult<R>>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          resolvers[index]?.({
            ok: true,
            value: await mapper(items[index], index),
          });
        } catch (error) {
          resolvers[index]?.({ ok: false, error });
        }
      }
    },
  );

  void Promise.all(workers);
  return taskPromises;
}

export async function awaitConcurrentTask<T>(
  task: Promise<ConcurrentTaskResult<T>>,
) {
  const result = await task;
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export async function runWithProgressHeartbeat<T>(
  input: {
    onProgress?: (message: string) => void;
    message: string;
    intervalMs?: number;
  },
  run: () => Promise<T>,
) {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (input.onProgress) {
    heartbeat = setInterval(
      () => input.onProgress?.(input.message),
      input.intervalMs ?? REQUIREMENT_RESPONSE_PROGRESS_HEARTBEAT_MS,
    );
  }

  try {
    return await run();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}
