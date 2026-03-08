import { Bid, BidDocument, BidEvent, BidNote, BidWorkspaceData } from "@/lib/types";

const API_BASE = process.env.API_SERVER_BASE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? process.env.URL ?? "http://localhost:3000";

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "x-tenant-id": "default"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function getBids(): Promise<Bid[]> {
  return fetchJson<Bid[]>("/api/v1/bids");
}

export async function getBid(bidId: string): Promise<Bid> {
  return fetchJson<Bid>(`/api/v1/bids/${bidId}`);
}

export async function getBidDocuments(bidId: string): Promise<BidDocument[]> {
  return fetchJson<BidDocument[]>(`/api/v1/bids/${bidId}/documents`);
}

export async function getBidEvents(bidId: string): Promise<BidEvent[]> {
  return fetchJson<BidEvent[]>(`/api/v1/bids/${bidId}/events`);
}

export async function getBidNotes(bidId: string): Promise<BidNote[]> {
  return fetchJson<BidNote[]>(`/api/v1/bids/${bidId}/notes`);
}

export async function getBidWorkspace(bidId: string): Promise<BidWorkspaceData> {
  return fetchJson<BidWorkspaceData>(`/api/v1/bids/${bidId}/workspace`);
}
