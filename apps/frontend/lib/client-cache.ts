"use client";

interface ClientCacheEntry<T> {
  expiresAt: number;
  value: T;
}

const clientCache = new Map<string, ClientCacheEntry<unknown>>();
const pendingReads = new Map<
  string,
  { promise: Promise<unknown>; shared: boolean }
>();

export type ClientReadOptions = {
  signal?: AbortSignal;
  forceRefresh?: boolean;
};

export const SERVICE_DESCRIPTIONS_CACHE_KEY = "service-descriptions";
export const SERVICE_DESCRIPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
export const PROJECT_SERVICES_CACHE_TTL_MS = 2 * 60 * 1000;

export function projectServicesCacheKey(projectId: string) {
  return `project-service-descriptions:${projectId}`;
}

export function setClientCache<T>(key: string, value: T, ttlMs: number) {
  // A saved value supersedes reads started before the write.
  pendingReads.delete(key);
  clientCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

export function clearClientCache(keyPrefix: string) {
  for (const key of clientCache.keys()) {
    if (key.startsWith(keyPrefix)) {
      clientCache.delete(key);
    }
  }
  for (const key of pendingReads.keys()) {
    if (key.startsWith(keyPrefix)) pendingReads.delete(key);
  }
}

export async function readClientCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number,
  options: ClientReadOptions = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  if (!options.forceRefresh) {
    const cached = clientCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;
    clientCache.delete(key);

    const pending = pendingReads.get(key);
    if (pending?.shared) {
      if (!options.signal) return pending.promise as Promise<T>;
      const signal = options.signal;
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        pending.promise.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value as T);
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    }
  }

  const request = { promise: fetcher(), shared: !options.signal };
  pendingReads.set(key, request);
  request.promise = request.promise
    .then((value) => {
      if (!options.signal?.aborted && pendingReads.get(key) === request) {
        setClientCache(key, value, ttlMs);
      }
      return value;
    })
    .finally(() => {
      if (pendingReads.get(key) === request) pendingReads.delete(key);
    });
  return request.promise as Promise<T>;
}
