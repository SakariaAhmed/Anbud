import { NextResponse } from "next/server";

import { inferProjectMetadataFromCustomerDocument } from "@/lib/server/ai";
import { extractTextFromUpload } from "@/lib/server/documents";
import { getProjectSnapshot, saveDocument, updateProjectMetadataFromInference } from "@/lib/server/projects-db";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const formData = await request.formData();
    const file = formData.get("file");
    const title = `${formData.get("title") || ""}`.trim();

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Du må velge en fil." }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json(
        { error: "Filen er tom. Last opp et dokument med innhold." },
        { status: 400 },
      );
    }

    const parsed = await extractTextFromUpload(file);

    if (!parsed.rawText.trim()) {
      return NextResponse.json(
        {
          error:
            "Dokumentet har ingen lesbar tekst. Last opp en tekstbasert PDF/DOCX, eller bruk OCR før opplasting.",
        },
        { status: 400 },
      );
    }

    const document = await saveDocument({
      projectId: id,
      title: title || file.name.replace(/\.[^.]+$/, ""),
      role: "supporting_document",
      supportingSubtype: null,
      fileName: parsed.fileName,
      fileFormat: parsed.fileFormat,
      contentType: parsed.contentType,
      fileSizeBytes: file.size,
      fileBase64: parsed.fileBase64,
      rawText: parsed.rawText,
      structureMap: parsed.sourceMap,
    });

    let snapshot = await getProjectSnapshot(id);

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

    return NextResponse.json({ document, project: snapshot }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke lagre dokumentet." },
      { status: 500 },
    );
  }
}
