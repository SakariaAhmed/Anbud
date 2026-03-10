import "server-only";

import { unstable_cache } from "next/cache";

import { Bid } from "@/lib/types";
import { getBidOrThrow, mapBid } from "@/lib/server/bids-db";
import { createServiceClient } from "@/lib/server/supabase";

const DEFAULT_TENANT_ID = "default";
const BID_REVALIDATE_SECONDS = 30;

type BidListRow = {
  id: string;
  customer_name: string;
  title: string;
  estimated_value: string | null;
  deadline: string;
  owner: string;
  created_at: string;
  updated_at: string;
};

function mapBidListRow(row: BidListRow): Bid {
  return {
    id: row.id,
    customer_name: row.customer_name,
    title: row.title,
    estimated_value: row.estimated_value,
    deadline: row.deadline,
    owner: row.owner,
    custom_fields: {},
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function fetchBidList(tenantId: string, limit?: number): Promise<Bid[]> {
  const supabase = createServiceClient();
  let query = supabase
    .from("bids")
    .select("id, customer_name, title, estimated_value, deadline, owner, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });

  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => mapBidListRow(row as BidListRow));
}

export async function getBidsForPage(): Promise<Bid[]> {
  const cached = unstable_cache(async () => fetchBidList(DEFAULT_TENANT_ID), ["bids:all"], {
    revalidate: BID_REVALIDATE_SECONDS,
    tags: ["bids"]
  });
  return cached();
}

export async function getRecentBidsForPage(limit = 6): Promise<Bid[]> {
  const cached = unstable_cache(async () => fetchBidList(DEFAULT_TENANT_ID, limit), [`bids:recent:${limit}`], {
    revalidate: BID_REVALIDATE_SECONDS,
    tags: ["bids"]
  });
  return cached();
}

export async function getBidForPage(bidId: string): Promise<Bid> {
  const cached = unstable_cache(async () => mapBid(await getBidOrThrow(DEFAULT_TENANT_ID, bidId)), [`bid:${bidId}`], {
    revalidate: BID_REVALIDATE_SECONDS,
    tags: ["bids", `bid:${bidId}`]
  });
  return cached();
}
