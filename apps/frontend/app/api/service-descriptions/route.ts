import { NextResponse } from "next/server";

import { extractTextFromUpload } from "@/lib/server/documents";
import {
  getServiceDescription,
  listServiceDescriptions,
  saveServiceDocument,
  upsertServiceDescription,
} from "@/lib/server/projects-db";
import type { ServiceInclusionMode } from "@/lib/types";

const SERVICE_CACHE_HEADERS = {
  "Cache-Control": "private, max-age=300, stale-while-revalidate=1800",
};

function isInclusionMode(value: unknown): value is ServiceInclusionMode {
  return value === "fixed" || value === "selected";
}

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
    const formData = await request.formData();
    const file = formData.get("file");
    const serviceId = `${formData.get("service_id") || ""}`.trim();
    const name = `${formData.get("name") || ""}`.trim();
    const description = `${formData.get("description") || ""}`.trim();
    const modeRaw = `${formData.get("inclusion_mode") || "selected"}`;
    const inclusionMode = isInclusionMode(modeRaw) ? modeRaw : "selected";

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
      inclusionMode: existingService?.inclusion_mode ?? inclusionMode,
    });

    let document = null;
    if (file instanceof File) {
      if (file.size <= 0) {
        return NextResponse.json(
          { error: "Filen er tom. Last opp et dokument med innhold." },
          { status: 400 },
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
