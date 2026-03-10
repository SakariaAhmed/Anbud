import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { extractTextFromUpload } from "@/lib/server/documents";
import { getBidOrThrow, logBidEvent, mapDocument, mapEvent, touchBidActivity } from "@/lib/server/bids-db";
import { actorFromHeaders, tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();
  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 200) : 50;

  const { data, error } = await supabase
    .from("bid_documents")
    .select("id, file_name, content_type, status, created_at, raw_text")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  return NextResponse.json((data ?? []).map((row) => mapDocument(row as never)));
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const actor = actorFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  try {
    await getBidOrThrow(tenantId, id);
  } catch {
    return NextResponse.json({ detail: "Bid not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ detail: "File is required" }, { status: 400 });
  }

  let parsed: { rawText: string; contentType: string; fileName: string };
  try {
    parsed = await extractTextFromUpload(file);
  } catch (error) {
    return NextResponse.json({ detail: error instanceof Error ? error.message : "Failed to parse file" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("bid_documents")
    .insert({
      tenant_id: tenantId,
      bid_id: id,
      file_name: parsed.fileName,
      content_type: parsed.contentType,
      raw_text: parsed.rawText,
      status: "uploaded"
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  const eventRow = await logBidEvent({
    tenantId,
    bidId: id,
    actor,
    type: "document_uploaded",
    payload: {
      document_id: data.id,
      file_name: data.file_name,
      content_type: data.content_type
    }
  });
  await touchBidActivity(tenantId, id);
  revalidateTag("bids");
  revalidateTag(`bid:${id}`);

  return NextResponse.json(
    {
      document: mapDocument(data as never),
      event: mapEvent(eventRow)
    },
    { status: 201 }
  );
}
