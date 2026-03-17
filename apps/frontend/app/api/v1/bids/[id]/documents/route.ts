import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { extractTextFromUpload } from "@/lib/server/documents";
import { getBidDocuments, getBidOrThrow, mapDocument, touchBidActivity } from "@/lib/server/bids-db";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

function normalizeRole(value: FormDataEntryValue | null) {
  const role = String(value ?? "").trim().toLowerCase();
  return role === "bilag1" || role === "bilag2" ? role : null;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = request.headers.get("x-tenant-id") ?? "default";
  const { id } = await context.params;

  try {
    const documents = await getBidDocuments(tenantId, id);
    return NextResponse.json(
      documents.map((document) => ({
        id: document.id,
        document_role: document.document_role,
        file_name: document.file_name,
        content_type: document.content_type,
        file_format: document.file_format,
        created_at: document.created_at,
      }))
    );
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "Kunne ikke hente dokumenter" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = request.headers.get("x-tenant-id") ?? "default";
  const { id } = await context.params;
  const supabase = createServiceClient();

  try {
    await getBidOrThrow(tenantId, id);
  } catch {
    return NextResponse.json({ detail: "Sak ikke funnet" }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  const documentRole = normalizeRole(formData.get("document_role"));

  if (!(file instanceof File)) {
    return NextResponse.json({ detail: "Fil er påkrevd" }, { status: 400 });
  }

  if (!documentRole) {
    return NextResponse.json({ detail: "document_role må være bilag1 eller bilag2" }, { status: 422 });
  }

  let parsed;
  try {
    parsed = await extractTextFromUpload(file, documentRole);
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "Kunne ikke lese filen" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("bid_documents")
    .insert({
      tenant_id: tenantId,
      bid_id: id,
      document_role: documentRole,
      file_name: parsed.fileName,
      content_type: parsed.contentType,
      file_format: parsed.fileFormat,
      file_base64: parsed.fileBase64,
      raw_text: parsed.rawText,
      source_map: parsed.sourceMap,
    })
    .select("id, document_role, file_name, content_type, file_format, created_at")
    .single();

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  await touchBidActivity(tenantId, id);
  revalidateTag("bids");
  revalidateTag(`bid:${id}`);

  return NextResponse.json({ document: mapDocument(data as never) }, { status: 201 });
}
