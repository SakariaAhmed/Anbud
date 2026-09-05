import { after, NextResponse } from "next/server";

import { summarizeServiceDocumentForAi } from "@/lib/server/ai/document-analysis";
import { enforceServiceDescriptionWriteRateLimit } from "@/lib/server/api-responses";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";
import { extractTextFromUpload } from "@/lib/server/documents";
import {
  MultipartRequestError,
  parseBoundedMultipartFormData,
} from "@/lib/server/multipart";
import { getServiceDescriptionMetadata, listServiceDescriptions, saveServiceDocument, updateServiceDocumentAiSummary, upsertServiceDescription } from "@/lib/server/repositories/data-store";
import type { ServiceDocument } from "@/lib/types";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

const SERVICE_CACHE_HEADERS = {
  "Cache-Control": "private, max-age=300, stale-while-revalidate=1800",
};
const MAX_SERVICE_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

export async function GET() {
  try {
    const services = await listServiceDescriptions();
    return NextResponse.json({ services }, { headers: SERVICE_CACHE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(
          error,
          "Kunne ikke hente tjenestebeskrivelser.",
        ),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const limited = await enforceServiceDescriptionWriteRateLimit(request);
    if (limited) {
      return limited;
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Tjenesten må sendes som skjemadata." },
        { status: 415 },
      );
    }

    const formData = await parseBoundedMultipartFormData(request, {
      maxBodyBytes: MAX_SERVICE_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES,
      maxFileBytes: MAX_SERVICE_UPLOAD_BYTES,
      maxFiles: 1,
    });
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

    let parsedFile: Awaited<ReturnType<typeof extractTextFromUpload>> | null =
      null;
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
      parsedFile = await extractTextFromUpload(file, undefined, {
        useDocling: false,
      });
      if (!parsedFile.rawText.trim()) {
        return NextResponse.json(
          { error: "Dokumentet har ingen lesbar tekst." },
          { status: 400 },
        );
      }
    }

    const existingService = serviceId
      ? await getServiceDescriptionMetadata(serviceId)
      : null;
    const service = await upsertServiceDescription({
      serviceId: serviceId || null,
      name: name || existingService?.name || "",
      description: description || existingService?.description || "",
    });

    let document: ServiceDocument | null = null;
    if (file instanceof File && parsedFile) {
      document = await saveServiceDocument({
        serviceId: service.id,
        title:
          `${formData.get("title") || ""}`.trim() ||
          file.name.replace(/\.[^.]+$/, ""),
        fileName: parsedFile.fileName,
        fileFormat: parsedFile.fileFormat,
        contentType: parsedFile.contentType,
        fileSizeBytes: file.size,
        fileBase64: parsedFile.fileBase64,
        rawText: parsedFile.rawText,
        structureMap: parsedFile.sourceMap,
      });
      const documentId = document.id;
      const documentTitle = document.title;
      const documentFileName = document.file_name;
      const rawText = parsedFile.rawText;
      after(async () => {
        await summarizeServiceDocumentForAi({
          title: documentTitle,
          fileName: documentFileName,
          rawText,
        })
          .then((summary) =>
            updateServiceDocumentAiSummary({
              documentId,
              aiSummary: summary,
            }),
          )
          .catch(() => {
            // Best-effort summary generation should not block upload.
          });
      });
    }

    const services = await listServiceDescriptions();
    return NextResponse.json({ service, document, services }, { status: 201 });
  } catch (error) {
    const authorizationResponse = authorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    if (error instanceof MultipartRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(
          error,
          "Kunne ikke lagre tjenestebeskrivelsen.",
        ),
      },
      { status: 500 },
    );
  }
}
