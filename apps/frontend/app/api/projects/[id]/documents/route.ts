import { NextResponse } from "next/server";

import {
  contentTypeForUploadFormat,
  inferUploadFileFormat,
} from "@/lib/server/documents";
import { queueDocumentIngestionJob } from "@/lib/server/project-jobs";
import {
  listProjectDocumentSummaries,
  savePendingDocument,
} from "@/lib/server/repositories/documents";
import { getProjectSnapshot } from "@/lib/server/repositories/projects";
import { auditEvent, checkRateLimit, withTiming } from "@/lib/server/observability";
import type { ProjectDocumentRole, SupportingDocumentSubtype } from "@/lib/types";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const uploadAttempts = new Map<string, number[]>();

const documentRoles: ProjectDocumentRole[] = [
  "primary_customer_document",
  "primary_solution_document",
  "supporting_document",
];

const supportingSubtypes: SupportingDocumentSubtype[] = [
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
];

function normalizeRole(value: FormDataEntryValue | null): ProjectDocumentRole | null {
  return typeof value === "string" && documentRoles.includes(value as ProjectDocumentRole)
    ? (value as ProjectDocumentRole)
    : null;
}

function normalizeSubtype(
  value: FormDataEntryValue | null,
): SupportingDocumentSubtype | null {
  return typeof value === "string" &&
    supportingSubtypes.includes(value as SupportingDocumentSubtype)
    ? (value as SupportingDocumentSubtype)
    : null;
}

async function inferUploadRole(
  projectId: string,
  fileName: string,
  title: string,
  explicitRole: ProjectDocumentRole | null,
) {
  if (explicitRole) {
    return explicitRole;
  }

  const existingDocuments = await listProjectDocumentSummaries(projectId);
  const text = `${title} ${fileName}`.toLowerCase();

  if (
    !existingDocuments.some(
      (document) => document.role === "primary_customer_document",
    )
  ) {
    return "primary_customer_document";
  }

  if (
    /\b(solution|løsn|losn|arkitektur|architecture)\b/.test(text) &&
    !existingDocuments.some(
      (document) => document.role === "primary_solution_document",
    )
  ) {
    return "primary_solution_document";
  }

  return "supporting_document";
}

function inferSupportingSubtype(
  fileName: string,
  title: string,
  explicitSubtype: SupportingDocumentSubtype | null,
) {
  if (explicitSubtype) {
    return explicitSubtype;
  }

  const text = `${title} ${fileName}`.toLowerCase();
  if (/(krav|requirement|requirements)/.test(text)) return "kravdokument";
  if (/(rfp|konkurransegrunnlag|forespørsel|foresporsel)/.test(text)) return "rfp";
  if (/(vedlegg|appendix|bilag)/.test(text)) return "vedlegg";
  if (/(strategi|strategy)/.test(text)) return "strategi";
  if (/(utkast|draft)/.test(text)) return "utkast";
  if (/(møte|mote|meeting|workshop)/.test(text)) return "motenotat";
  return null;
}

function enforceUploadRateLimit(projectId: string) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const recentAttempts = (uploadAttempts.get(projectId) ?? []).filter(
    (timestamp) => timestamp > windowStart,
  );

  if (recentAttempts.length >= 8) {
    return false;
  }

  uploadAttempts.set(projectId, [...recentAttempts, now]);
  return true;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const requestLimit = await checkRateLimit(request, "document-upload", {
      limit: 16,
      windowMs: 60_000,
    });
    if (!requestLimit.allowed) {
      return NextResponse.json(
        {
          error:
            "For mange opplastinger på kort tid. Vent litt før du prøver igjen.",
        },
        {
          status: 429,
          headers: { "Retry-After": String(requestLimit.retryAfterSeconds) },
        },
      );
    }

    return await withTiming(
      "POST /api/projects/[id]/documents",
      { project_id: id },
      async () => {
    const formData = await request.formData();
    const file = formData.get("file");
    const title = `${formData.get("title") || ""}`.trim();

    if (!enforceUploadRateLimit(id)) {
      return NextResponse.json(
        {
          error:
            "For mange opplastinger på kort tid. Vent litt før du prøver igjen.",
        },
        { status: 429 },
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Du må velge en fil." }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json(
        { error: "Filen er tom. Last opp et dokument med innhold." },
        { status: 400 },
      );
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error:
            "Filen er for stor. Maksimal størrelse er 25 MB per dokument.",
        },
        { status: 413 },
      );
    }

    const role = await inferUploadRole(
      id,
      file.name,
      title,
      normalizeRole(formData.get("role")),
    );
    const supportingSubtype =
      role === "supporting_document"
        ? inferSupportingSubtype(
            file.name,
            title,
            normalizeSubtype(formData.get("supporting_subtype")),
          )
        : null;

    const fileFormat = inferUploadFileFormat({
      fileName: file.name || "document.txt",
      contentType: file.type || "application/octet-stream",
    });
    const document = await savePendingDocument({
      projectId: id,
      title: title || file.name.replace(/\.[^.]+$/, ""),
      role,
      supportingSubtype,
      fileName: file.name || "document.txt",
      fileFormat,
      contentType: contentTypeForUploadFormat(
        fileFormat,
        file.type || "application/octet-stream",
      ),
      fileSizeBytes: file.size,
      fileBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
    });

    const job = await queueDocumentIngestionJob({
      projectId: id,
      documentId: document.id,
    });
    const snapshot = await getProjectSnapshot(id);
    await auditEvent({
      action: "document_uploaded",
      projectId: id,
      entityType: "document",
      entityId: document.id,
      metadata: {
        role,
        file_format: document.file_format,
        file_size_bytes: document.file_size_bytes,
        ingestion_job_id: job.id,
      },
    });

    return NextResponse.json({ document, project: snapshot, job }, { status: 201 });
      },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke lagre dokumentet." },
      { status: 500 },
    );
  }
}
