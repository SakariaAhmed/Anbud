import { NextRequest, NextResponse } from "next/server";

import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; documentId: string }> }
) {
  const tenantId = request.headers.get("x-tenant-id") ?? "default";
  const { id, documentId } = await context.params;
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("bid_documents")
    .select("id, bid_id, file_name, content_type, file_base64")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .eq("id", documentId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ detail: "Dokument ikke funnet" }, { status: 404 });
  }

  const fileBuffer = Buffer.from(String(data.file_base64), "base64");

  return new NextResponse(fileBuffer, {
    headers: {
      "Content-Type": String(data.content_type),
      "Content-Disposition": `attachment; filename="${String(data.file_name)}"`,
      "Cache-Control": "no-store",
    },
  });
}
