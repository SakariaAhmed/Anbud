import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { extractBidRequirements } from "@/lib/server/ai";
import { getBidOrThrow, mapRequirement } from "@/lib/server/bids-db";
import { tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function mapRequirementsError(message: string) {
  if (message.includes("public.bid_requirements")) {
    return NextResponse.json(
      {
        detail:
          "Requirements storage is not enabled in the database yet. Apply the latest Supabase schema so the bid_requirements table exists."
      },
      { status: 503 }
    );
  }

  return NextResponse.json({ detail: message }, { status: 500 });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();
  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 200) : 100;

  const { data, error } = await supabase
    .from("bid_requirements")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    return mapRequirementsError(error.message);
  }

  return NextResponse.json((data ?? []).map((row) => mapRequirement(row as never)));
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  let bid;
  try {
    bid = await getBidOrThrow(tenantId, id);
  } catch {
    return NextResponse.json({ detail: "Bid not found" }, { status: 404 });
  }

  const { data: documents, error: documentsError } = await supabase
    .from("bid_documents")
    .select("file_name, raw_text")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("created_at", { ascending: false });

  if (documentsError) {
    return NextResponse.json({ detail: documentsError.message }, { status: 500 });
  }

  const documentTexts = (documents ?? [])
    .map((doc) => {
      const rawText = String(doc.raw_text ?? "").trim();
      const fileName = String(doc.file_name ?? "").trim();
      if (!rawText) {
        return "";
      }
      return fileName ? `Source file: ${fileName}\n${rawText}` : rawText;
    })
    .filter(Boolean);

  if (!documentTexts.length) {
    return NextResponse.json({ detail: "Upload at least one document before generating requirements." }, { status: 422 });
  }

  const suggestions = await extractBidRequirements({
    documentTexts,
    bidContext: {
      customer_name: bid.customer_name,
      title: bid.title,
      owner: bid.owner,
      deadline: bid.deadline
    }
  });

  const { data: existingRows, error: existingError } = await supabase
    .from("bid_requirements")
    .select("id, title, status, completion_notes")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id);

  if (existingError) {
    return mapRequirementsError(existingError.message);
  }

  const existingByTitle = new Map(
    (existingRows ?? []).map((row) => [normalizeKey(String(row.title ?? "")), row as { id: string; status: string; completion_notes: string }])
  );

  const now = new Date().toISOString();
  const inserts: Record<string, unknown>[] = [];

  for (const suggestion of suggestions) {
    const key = normalizeKey(suggestion.title);
    const existing = existingByTitle.get(key);

    if (existing) {
      const { error } = await supabase
        .from("bid_requirements")
        .update({
          title: suggestion.title,
          detail: suggestion.detail,
          category: suggestion.category,
          priority: suggestion.priority,
          source_excerpt: suggestion.source_excerpt,
          source_document: suggestion.source_document,
          updated_at: now
        })
        .eq("tenant_id", tenantId)
        .eq("bid_id", id)
        .eq("id", existing.id);

      if (error) {
        return mapRequirementsError(error.message);
      }
      continue;
    }

    inserts.push({
      tenant_id: tenantId,
      bid_id: id,
      title: suggestion.title,
      detail: suggestion.detail,
      category: suggestion.category,
      priority: suggestion.priority,
      status: "Open",
      source_excerpt: suggestion.source_excerpt,
      source_document: suggestion.source_document,
      completion_notes: "",
      updated_at: now
    });
  }

  if (inserts.length) {
    const { error } = await supabase.from("bid_requirements").insert(inserts);
    if (error) {
      return mapRequirementsError(error.message);
    }
  }

  const { data: finalRows, error: finalError } = await supabase
    .from("bid_requirements")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (finalError) {
    return mapRequirementsError(finalError.message);
  }

  revalidateTag("bids");
  revalidateTag(`bid:${id}`);

  return NextResponse.json({ requirements: (finalRows ?? []).map((row) => mapRequirement(row as never)) });
}
