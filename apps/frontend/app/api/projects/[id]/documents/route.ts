import { NextResponse } from "next/server";

import { inferProjectMetadataFromCustomerDocument } from "@/lib/server/ai";
import { extractTextFromUpload } from "@/lib/server/documents";
import { getProjectSnapshot, saveDocument, updateProjectMetadataFromInference } from "@/lib/server/projects-db";
import type { ProjectDocumentRole, SupportingDocumentSubtype } from "@/lib/types";

function isValidRole(value: string): value is ProjectDocumentRole {
  return ["primary_customer_document", "primary_solution_document", "supporting_document"].includes(value);
}

function isValidSubtype(value: string): value is SupportingDocumentSubtype {
  return [
    "rfp",
    "kravdokument",
    "prosjektbeskrivelse",
    "notat",
    "motenotat",
    "workshop",
    "vedlegg",
    "strategi",
    "utkast",
    "annet",
  ].includes(value);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const formData = await request.formData();
    const file = formData.get("file");
    const title = `${formData.get("title") || ""}`.trim();
    const role = `${formData.get("role") || ""}`.trim();
    const supportingSubtype = `${formData.get("supporting_subtype") || ""}`.trim();

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Du må velge en fil." }, { status: 400 });
    }

    if (!isValidRole(role)) {
      return NextResponse.json({ error: "Ugyldig dokumentrolle." }, { status: 400 });
    }

    if (role === "supporting_document" && supportingSubtype && !isValidSubtype(supportingSubtype)) {
      return NextResponse.json({ error: "Ugyldig undertype for støttedokument." }, { status: 400 });
    }

    const parsed = await extractTextFromUpload(file, role);
    const document = await saveDocument({
      projectId: id,
      title: title || file.name.replace(/\.[^.]+$/, ""),
      role,
      supportingSubtype: role === "supporting_document" ? ((supportingSubtype || "annet") as SupportingDocumentSubtype) : null,
      fileName: parsed.fileName,
      fileFormat: parsed.fileFormat,
      contentType: parsed.contentType,
      fileSizeBytes: file.size,
      fileBase64: parsed.fileBase64,
      rawText: parsed.rawText,
      structureMap: parsed.sourceMap,
    });

    let snapshot = await getProjectSnapshot(id);

    if (role === "primary_customer_document") {
      try {
        const inferredMetadata = await inferProjectMetadataFromCustomerDocument({
          fileName: parsed.fileName,
          title: title || file.name.replace(/\.[^.]+$/, ""),
          rawText: parsed.rawText,
        });
        await updateProjectMetadataFromInference(id, inferredMetadata);
        snapshot = await getProjectSnapshot(id);
      } catch {
        // Best-effort metadata extraction should not block document upload.
      }
    }

    return NextResponse.json({ document, project: snapshot }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke lagre dokumentet." },
      { status: 500 },
    );
  }
}
