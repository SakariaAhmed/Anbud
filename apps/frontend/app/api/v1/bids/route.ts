import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { createServiceClient } from "@/lib/server/supabase";
import { getBidsForPage } from "@/lib/server/bids-db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const bids = await getBidsForPage();
    return NextResponse.json(bids);
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "Kunne ikke hente saker" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const tenantId = request.headers.get("x-tenant-id") ?? "default";
  const supabase = createServiceClient();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "Ugyldig JSON" }, { status: 400 });
  }

  const customerName = String(payload.customer_name ?? "").trim();
  if (!customerName) {
    return NextResponse.json({ detail: "Kundenavn er påkrevd" }, { status: 422 });
  }

  const defaultDeadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("bids")
    .insert({
      tenant_id: tenantId,
      customer_name: customerName,
      title: String(payload.title ?? "").trim() || "Ny analyse",
      deadline: defaultDeadline,
      owner: "Ikke satt",
      estimated_value: null,
      custom_fields: {},
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  revalidateTag("bids");
  revalidateTag(`bid:${data.id}`);

  return NextResponse.json(data, { status: 201 });
}
