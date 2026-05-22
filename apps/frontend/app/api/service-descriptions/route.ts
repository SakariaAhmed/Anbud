import { NextResponse } from "next/server";

import { summarizeServiceDocumentForAi } from "@/lib/server/ai";
import { extractTextFromUpload } from "@/lib/server/documents";
import { checkRateLimit } from "@/lib/server/observability";
import {
  getServiceDescription,
  listServiceDescriptions,
  saveServiceDocument,
  updateServiceDocumentAiSummary,
  upsertServiceDescription,
} from "@/lib/server/repositories/services";

const SERVICE_CACHE_HEADERS = {
  "Cache-Control": "private, max-age=300, stale-while-revalidate=1800",
};
const MAX_SERVICE_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function GET() {
  try {
    const services = await listServiceDescriptions();
    return NextResponse.json({ services }, { headers: SERVICE_CACHE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke hente tjenestebeskrivelser.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const rateLimit = await checkRateLimit(request, "service-descriptions-write", {
      limit: 16,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "For mange tjenesteendringer på kort tid." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const serviceId = `${formData.get("service_id") || ""}`.trim();
    const name = `${formData.get("name") || ""}`.trim();
    const description = `${formData.get("description") || ""}`.trim();

    if (!serviceId && !name) {
      return NextResponse.json(
        { error: "Velg en eksisterende tjeneste eller skriv inn tjenestenavn." },
        { status: 400 },
      );
    }

    const existingService = serviceId
      ? await getServiceDescription(serviceId)
      : null;
    const service = await upsertServiceDescription({
      serviceId: serviceId || null,
      name: name || existingService?.name || "",
      description: description || existingService?.description || "",
    });

    let document = null;
    if (file instanceof File) {
      if (file.size <= 0) {
        return NextResponse.json(
          { error: "Filen er tom. Last opp et dokument med innhold." },
          { status: 400 },
        );
      }
      if (file.size > MAX_SERVICE_UPLOAD_BYTES) {
        return NextResponse.json(
          {
            error:
              "Filen er for stor. Maksimal størrelse er 25 MB per dokument.",
          },
          { status: 413 },
        );
      }
      const parsed = await extractTextFromUpload(file);
      if (!parsed.rawText.trim()) {
        return NextResponse.json(
          { error: "Dokumentet har ingen lesbar tekst." },
          { status: 400 },
        );
      }
      document = await saveServiceDocument({
        serviceId: service.id,
        title:
          `${formData.get("title") || ""}`.trim() ||
          file.name.replace(/\.[^.]+$/, ""),
        fileName: parsed.fileName,
        fileFormat: parsed.fileFormat,
        contentType: parsed.contentType,
        fileSizeBytes: file.size,
        fileBase64: parsed.fileBase64,
        rawText: parsed.rawText,
        structureMap: parsed.sourceMap,
      });
      void summarizeServiceDocumentForAi({
        title: document.title,
        fileName: document.file_name,
        rawText: parsed.rawText,
      })
        .then((summary) =>
          updateServiceDocumentAiSummary({
            documentId: document!.id,
            aiSummary: summary,
          }),
        )
        .catch(() => {
          // Best-effort summary generation should not block upload.
        });
    }

    const services = await listServiceDescriptions();
    return NextResponse.json({ service, document, services }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke lagre tjenestebeskrivelsen.",
      },
      { status: 500 },
    );
  }
}
