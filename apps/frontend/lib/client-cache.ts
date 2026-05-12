"use client";

interface ClientCacheEntry<T> {
  expiresAt: number;
  value: T;
}

const clientCache = new Map<string, ClientCacheEntry<unknown>>();

export function getClientCache<T>(key: string): T | null {
  const entry = clientCache.get(key) as ClientCacheEntry<T> | undefined;
  if (!entry || entry.expiresAt <= Date.now()) {
    clientCache.delete(key);
    return null;
  }

  return entry.value;
}

export function setClientCache<T>(key: string, value: T, ttlMs: number) {
  clientCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

export function clearClientCache(keyPrefix: string) {
  for (const key of clientCache.keys()) {
    if (key === keyPrefix || key.startsWith(keyPrefix)) {
      clientCache.delete(key);
    }
  }
}
