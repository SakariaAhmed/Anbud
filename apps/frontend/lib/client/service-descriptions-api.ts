"use client";

import {
  SERVICE_DESCRIPTIONS_CACHE_KEY,
  SERVICE_DESCRIPTIONS_CACHE_TTL_MS,
  clearClientCache,
  readClientCache,
  setClientCache,
  type ClientReadOptions,
} from "@/lib/client-cache";
import type { ServiceDescription } from "@/lib/types";

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
  options: ClientReadOptions = {},
) {
  return readClientCache(
    SERVICE_DESCRIPTIONS_CACHE_KEY,
    async () => {
      const response = await fetch("/api/service-descriptions", {
        cache: "no-store",
        signal: options.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        services?: ServiceDescription[];
        error?: string;
      };
      if (!response.ok || !payload.services) {
        throw new Error(payload.error || "Kunne ikke hente tjenestebeskrivelser.");
      }
      return payload.services;
    },
    SERVICE_DESCRIPTIONS_CACHE_TTL_MS,
    options,
  );
}
