"use client";

import {
  Bid,
  BidBootstrapResponse,
  BidDecision,
  BidDocument,
  BidEvent,
  BidNote,
  BidRequirement,
  BidTask
} from "@/lib/types";

export interface WorkspaceCacheEntry {
  bid: Bid;
  documents: BidDocument[];
  events: BidEvent[];
  notes: BidNote[];
  requirements: BidRequirement[];
  decisions: BidDecision[];
  tasks: BidTask[];
  updatedAt: number;
}

const CACHE_PREFIX = "anbud-workspace:";
const MAX_AGE_MS = 1000 * 60 * 20;
const inflightPrefetches = new Map<string, Promise<WorkspaceCacheEntry | null>>();

function storageKey(bidId: string) {
  return `${CACHE_PREFIX}${bidId}`;
}

export function readWorkspaceCache(bidId: string): WorkspaceCacheEntry | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(storageKey(bidId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as WorkspaceCacheEntry;
    if (!parsed.updatedAt || Date.now() - parsed.updatedAt > MAX_AGE_MS) {
      window.sessionStorage.removeItem(storageKey(bidId));
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function writeWorkspaceCache(bidId: string, entry: Omit<WorkspaceCacheEntry, "updatedAt">) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const payload: WorkspaceCacheEntry = {
      ...entry,
      updatedAt: Date.now()
    };
    window.sessionStorage.setItem(storageKey(bidId), JSON.stringify(payload));
  } catch {
    // Ignore storage failures; cache is an optimization only.
  }
}

export async function prefetchWorkspaceCache(bidId: string): Promise<WorkspaceCacheEntry | null> {
  const cached = readWorkspaceCache(bidId);
  if (cached) {
    return cached;
  }

  const existing = inflightPrefetches.get(bidId);
  if (existing) {
    return existing;
  }

  const request = fetch(`/api/v1/bids/${bidId}/bootstrap`, {
    headers: {
      "x-tenant-id": "default"
    }
  })
    .then(async (response) => {
      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as BidBootstrapResponse;
      writeWorkspaceCache(bidId, payload);
      return readWorkspaceCache(bidId);
    })
    .catch(() => null)
    .finally(() => {
      inflightPrefetches.delete(bidId);
    });

  inflightPrefetches.set(bidId, request);
  return request;
}
