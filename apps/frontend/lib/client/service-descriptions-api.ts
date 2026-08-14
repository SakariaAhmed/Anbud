"use client";

import {
  clearClientCache,
  getClientCache,
  SERVICE_DESCRIPTIONS_CACHE_KEY,
  SERVICE_DESCRIPTIONS_CACHE_TTL_MS,
  setClientCache,
} from "@/lib/client-cache";
import type { ServiceDescription } from "@/lib/types";

type ServiceDescriptionReadOptions = {
  forceRefresh?: boolean;
  signal?: AbortSignal;
};

let pendingServiceDescriptionRead: Promise<ServiceDescription[]> | null = null;

function abortableRead<T>(request: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(
      new DOMException("Forespørselen ble avbrutt.", "AbortError"),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException("Forespørselen ble avbrutt.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function cacheServiceDescriptions(services: ServiceDescription[]) {
  setClientCache(
    SERVICE_DESCRIPTIONS_CACHE_KEY,
    services,
    SERVICE_DESCRIPTIONS_CACHE_TTL_MS,
  );
}

export function invalidateProjectServiceDescriptionCaches() {
  clearClientCache("project-service-descriptions:");
}

export async function fetchServiceDescriptions(
  options: ServiceDescriptionReadOptions = {},
) {
  if (!options.forceRefresh) {
    const cached = getClientCache<ServiceDescription[]>(
      SERVICE_DESCRIPTIONS_CACHE_KEY,
    );
    if (cached) return cached;

    if (pendingServiceDescriptionRead) {
      return options.signal
        ? abortableRead(pendingServiceDescriptionRead, options.signal)
        : pendingServiceDescriptionRead;
    }
  }

  const request = (async () => {
    const response = await fetch("/api/service-descriptions", {
      cache: "no-store",
      signal: options.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      services?: ServiceDescription[];
      error?: string;
    };
    if (!response.ok || !payload.services) {
      throw new Error(
        payload.error || "Kunne ikke hente tjenestebeskrivelser.",
      );
    }
    if (!options.signal?.aborted) {
      cacheServiceDescriptions(payload.services);
    }
    return payload.services;
  })();

  if (!options.forceRefresh && !options.signal) {
    pendingServiceDescriptionRead = request;
  }

  try {
    return await request;
  } finally {
    if (pendingServiceDescriptionRead === request) {
      pendingServiceDescriptionRead = null;
    }
  }
}
