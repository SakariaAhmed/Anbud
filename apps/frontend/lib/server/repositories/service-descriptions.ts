import "server-only";

// Persistence for the service description library, its documents and each
// project's selected services.
import {
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
} from "@/lib/server/crypto";
import { createServiceClient } from "@/lib/server/data-api";
import { normalizeDocumentChunkStructureMap } from "@/lib/server/document-chunk-structure";
import { deleteDocumentChunks, replaceServiceDocumentChunks } from "@/lib/server/document-chunks";
import {
  buildStoredFilePath,
  downloadEncryptedBase64File,
  removeStoredFilePrefixes,
  removeStoredFiles,
  uploadEncryptedBase64File,
} from "@/lib/server/file-storage-azure";
import { isMissingRelationColumn } from "@/lib/server/repositories/postgrest-compat";
import {
  revalidateProjectCaches,
  revalidateServiceCaches,
  SERVICE_DESCRIPTIONS_TAG,
} from "@/lib/server/repositories/repository-cache";
import { fetchStoredFileReferencesPaginated, runStorageFirstDeletion } from "@/lib/server/storage-deletion";
import {
  type ProjectServiceDescription,
  type ServiceDescription,
  type ServiceDocument,
  type ServiceDocumentDetail,
  type ServiceInclusionMode,
} from "@/lib/types";
import { unstable_cache } from "next/cache";
import { after } from "next/server";
import { randomUUID } from "node:crypto";
import {
  decryptOptionalString,
  type Json,
  keywordsFromText,
  mergeKeywords,
  pageCountFromRawText,
  pageCountFromStructureMap,
  queryProjectRow,
  storedFileDeletionPrefixes,
} from "@/lib/server/repositories/project-rows";

interface ServiceDescriptionRow {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  inclusion_mode: ServiceInclusionMode;
  created_at: string;
  updated_at: string;
}

interface ServiceDocumentRow {
  id: string;
  service_id: string;
  title: string;
  file_name: string;
  file_format: string;
  content_type: string;
  file_size_bytes: number;
  page_count?: number | null;
  file_storage_bucket?: string | null;
  file_storage_path?: string | null;
  file_base64: string;
  raw_text: string;
  structure_map: Json;
  ai_summary?: string | null;
  ai_summary_updated_at?: string | null;
  chunk_source_revision: number;
  created_at: string;
  updated_at: string;
}

interface ServiceDocumentSummaryRow {
  id: string;
  service_id: string;
  title: string;
  file_name: string;
  file_format: string;
  content_type: string;
  file_size_bytes: number;
  page_count?: number | null;
  file_storage_bucket?: string | null;
  file_storage_path?: string | null;
  raw_text?: string;
  structure_map?: Json;
  ai_summary?: string | null;
  ai_summary_updated_at?: string | null;
  chunk_source_revision: number;
  created_at: string;
  updated_at: string;
}

const SERVICE_DOCUMENT_SUMMARY_SELECT =
  "id, service_id, title, file_name, file_format, content_type, file_size_bytes, page_count, ai_summary, ai_summary_updated_at, chunk_source_revision, created_at, updated_at";

const SERVICE_DOCUMENT_SUMMARY_SELECT_BASE =
  "id, service_id, title, file_name, file_format, content_type, file_size_bytes, page_count, chunk_source_revision, created_at, updated_at";

function mapServiceDocument(row: ServiceDocumentSummaryRow): ServiceDocument {
  const structureMap = row.structure_map
    ? decryptJson(row.structure_map, [])
    : [];
  const structurePageCount = pageCountFromStructureMap(
    structureMap,
    row.file_format,
  );
  const rawText = decryptOptionalString(row.raw_text);

  return {
    id: row.id,
    service_id: row.service_id,
    title: row.title,
    file_name: row.file_name,
    file_format: row.file_format as ServiceDocument["file_format"],
    content_type: row.content_type,
    file_size_bytes: row.file_size_bytes,
    page_count:
      row.page_count ??
      structurePageCount ??
      pageCountFromRawText(rawText, row.file_format),
    ai_summary:
      typeof row.ai_summary === "string" ? decryptString(row.ai_summary) : "",
    ai_summary_updated_at: row.ai_summary_updated_at ?? null,
    chunk_source_revision: row.chunk_source_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

type ServiceDocumentSummaryQuery = (
  select: string,
) => PromiseLike<{
  data: unknown;
  error: { message?: string } | null;
}>;

async function fetchServiceDocumentSummaryRows(
  query: ServiceDocumentSummaryQuery,
  options: {
    emptyWhenServiceDocumentRelationMissing?: boolean;
    includeAiSummary?: boolean;
  } = {},
) {
  const includeAiSummary = options.includeAiSummary !== false;
  let { data, error } = await query(
    includeAiSummary
      ? SERVICE_DOCUMENT_SUMMARY_SELECT
      : SERVICE_DOCUMENT_SUMMARY_SELECT_BASE,
  );

  if (
    includeAiSummary &&
    error &&
    isMissingRelationColumn(error, "ai_summary")
  ) {
    ({ data, error } = await query(SERVICE_DOCUMENT_SUMMARY_SELECT_BASE));
  }

  if (error) {
    if (
      options.emptyWhenServiceDocumentRelationMissing &&
      isMissingRelationColumn(error, "service_documents")
    ) {
      return [];
    }
    throw new Error(error.message || "Kunne ikke hente tjenestedokumenter.");
  }

  return (Array.isArray(data) ? data : []) as ServiceDocumentSummaryRow[];
}

function fromUnknownServiceDocumentSummaryRow(
  row: Record<string, unknown>,
): ServiceDocumentSummaryRow {
  let fileSizeBytes =
    typeof row.file_size_bytes === "number" &&
    Number.isFinite(row.file_size_bytes)
      ? row.file_size_bytes
      : 0;
  if (fileSizeBytes <= 0 && typeof row.file_base64 === "string") {
    try {
      fileSizeBytes = Buffer.from(decryptString(row.file_base64), "base64")
        .length;
    } catch {
      fileSizeBytes = 0;
    }
  }
  const createdAt = String(row.created_at ?? new Date().toISOString());

  return {
    id: String(row.id ?? ""),
    service_id: String(row.service_id ?? ""),
    title: String(row.title ?? row.file_name ?? "Tjenestedokument"),
    file_name: String(row.file_name ?? row.title ?? "document.txt"),
    file_format: String(row.file_format ?? "txt"),
    content_type: String(row.content_type ?? "application/octet-stream"),
    file_size_bytes: fileSizeBytes,
    page_count:
      typeof row.page_count === "number" && Number.isFinite(row.page_count)
        ? row.page_count
        : null,
    file_storage_bucket:
      row.file_storage_bucket == null ? null : String(row.file_storage_bucket),
    file_storage_path:
      row.file_storage_path == null ? null : String(row.file_storage_path),
    raw_text: typeof row.raw_text === "string" ? row.raw_text : undefined,
    structure_map: (row.structure_map ?? []) as Json,
    ai_summary:
      typeof row.ai_summary === "string" ? row.ai_summary : undefined,
    ai_summary_updated_at:
      row.ai_summary_updated_at == null
        ? null
        : String(row.ai_summary_updated_at),
    chunk_source_revision: Math.max(
      0,
      Number(row.chunk_source_revision ?? 0),
    ),
    created_at: createdAt,
    updated_at: String(row.updated_at ?? createdAt),
  };
}

function mapServiceDescription(
  row: ServiceDescriptionRow,
  documents: ServiceDocumentSummaryRow[],
): ServiceDescription {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
    inclusion_mode: row.inclusion_mode,
    created_at: row.created_at,
    updated_at: row.updated_at,
    documents: documents.map(mapServiceDocument),
  };
}

function decryptServiceDocumentRow(
  row: ServiceDocumentRow,
): ServiceDocumentDetail {
  return {
    id: row.id,
    service_id: row.service_id,
    title: row.title,
    file_name: row.file_name,
    file_format: row.file_format as ServiceDocumentDetail["file_format"],
    content_type: row.content_type,
    file_size_bytes: row.file_size_bytes,
    page_count: row.page_count ?? null,
    file_base64: decryptString(row.file_base64),
    raw_text: decryptString(row.raw_text),
    structure_map: decryptJson(row.structure_map, []),
    ai_summary:
      typeof row.ai_summary === "string" ? decryptString(row.ai_summary) : "",
    ai_summary_updated_at: row.ai_summary_updated_at ?? null,
    chunk_source_revision: row.chunk_source_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function resolveServiceDocumentRow(
  row: ServiceDocumentRow,
): Promise<ServiceDocumentDetail> {
  const document = decryptServiceDocumentRow(row);
  if (document.file_base64 || !row.file_storage_path) {
    return document;
  }

  return {
    ...document,
    file_base64: decryptString(
      await downloadEncryptedBase64File({
        bucket: row.file_storage_bucket,
        path: row.file_storage_path,
      }),
    ),
  };
}

export async function listServiceDescriptions(
  options: { includeDocumentAiSummaries?: boolean } = {},
): Promise<ServiceDescription[]> {
  const includeDocumentAiSummaries =
    options.includeDocumentAiSummaries === true;
  return unstable_cache(
    async () => {
      const dataApi = createServiceClient();
      const [servicesResult, documents] = await Promise.all([
        dataApi
          .from("service_descriptions")
          .select("*")
          .order("name", { ascending: true }),
        fetchServiceDocumentSummaryRows(
          (select) =>
            dataApi
              .from("service_documents")
              .select(select)
              .order("created_at", { ascending: false }),
          {
            emptyWhenServiceDocumentRelationMissing: true,
            includeAiSummary: includeDocumentAiSummaries,
          },
        ),
      ]);
      const { data: services, error: servicesError } = servicesResult;

      if (servicesError) {
        if (
          isMissingRelationColumn(servicesError, "service_descriptions")
        ) {
          return [];
        }
        throw new Error(
          servicesError.message || "Kunne ikke hente tjenestebeskrivelser.",
        );
      }

      const documentsByService = new Map<string, ServiceDocumentSummaryRow[]>();
      for (const document of documents) {
        const list = documentsByService.get(document.service_id) ?? [];
        list.push(document);
        documentsByService.set(document.service_id, list);
      }

      return ((services ?? []) as ServiceDescriptionRow[]).map((service) =>
        mapServiceDescription(service, documentsByService.get(service.id) ?? []),
      );
    },
    [
      "service-descriptions",
      includeDocumentAiSummaries ? "with-ai-summaries" : "catalog",
    ],
    {
      tags: [SERVICE_DESCRIPTIONS_TAG],
      revalidate: 3600,
    },
  )();
}

export async function getServiceDescriptionMetadata(
  serviceId: string,
) {
  const dataApi = createServiceClient();
  const serviceResult = await dataApi
    .from("service_descriptions")
    .select("id, name, description")
    .eq("id", serviceId)
    .maybeSingle<Pick<ServiceDescriptionRow, "id" | "name" | "description">>();

  if (serviceResult.error || !serviceResult.data) {
    throw new Error("Fant ikke tjenesten.");
  }
  return serviceResult.data;
}

export async function upsertServiceDescription(input: {
  serviceId?: string | null;
  name: string;
  description?: string | null;
}) {
  const dataApi = createServiceClient();
  const payload = {
    name: input.name.trim(),
    description: input.description?.trim() || "",
    keywords: keywordsFromText(
      `${input.name} ${input.description?.trim() || ""}`,
    ),
    inclusion_mode: "selected" as ServiceInclusionMode,
    updated_at: new Date().toISOString(),
  };

  if (!payload.name) {
    throw new Error("Tjenesten må ha et navn.");
  }

  let query = input.serviceId
    ? dataApi
        .from("service_descriptions")
        .update(payload)
        .eq("id", input.serviceId)
        .select("*")
        .single<ServiceDescriptionRow>()
    : dataApi
        .from("service_descriptions")
        .insert(payload)
        .select("*")
        .single<ServiceDescriptionRow>();
  let { data, error } = await query;

  if (error && isMissingRelationColumn(error, "service_descriptions")) {
    const legacyPayload = {
      name: payload.name,
      description: payload.description,
      inclusion_mode: payload.inclusion_mode,
      updated_at: payload.updated_at,
    };
    query = input.serviceId
      ? dataApi
          .from("service_descriptions")
          .update(legacyPayload)
          .eq("id", input.serviceId)
          .select("*")
          .single<ServiceDescriptionRow>()
      : dataApi
          .from("service_descriptions")
          .insert(legacyPayload)
          .select("*")
          .single<ServiceDescriptionRow>();
    const retry = await query;
    data = retry.data;
    error = retry.error;
  }

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre tjenesten.");
  }

  revalidateServiceCaches();
  return mapServiceDescription(data, []);
}

export async function saveServiceDocument(input: {
  serviceId: string;
  title: string;
  fileName: string;
  fileFormat: ServiceDocument["file_format"];
  contentType: string;
  fileSizeBytes: number;
  fileBase64: string;
  rawText: string;
  structureMap: unknown;
}) {
  const dataApi = createServiceClient();
  const documentId = randomUUID();
  const normalizedTitle =
    input.title?.trim() ||
    input.fileName.replace(/\.[^.]+$/, "").trim() ||
    "Tjenestedokument";
  const pageCount =
    pageCountFromStructureMap(input.structureMap, input.fileFormat) ??
    pageCountFromRawText(input.rawText, input.fileFormat);
  const encryptedBase64 = encryptString(input.fileBase64);
  const encryptedRawText = encryptString(input.rawText);
  const encryptedStructureMap = encryptJson(input.structureMap);
  const storedFile = await uploadEncryptedBase64File({
    path: buildStoredFilePath({
      scope: "services",
      ownerId: input.serviceId,
      fileId: documentId,
      fileName: input.fileName,
    }),
    encryptedBase64,
  });
  const insertPayload: Record<string, unknown> = {
    id: documentId,
    service_id: input.serviceId,
    title: normalizedTitle,
    file_name: input.fileName,
    file_format: input.fileFormat,
    content_type: input.contentType,
    file_size_bytes: input.fileSizeBytes,
    page_count: pageCount,
    file_storage_bucket: storedFile.bucket,
    file_storage_path: storedFile.path,
    file_base64: "",
    raw_text: encryptedRawText,
    structure_map: encryptedStructureMap,
  };
  const nextKeywords = keywordsFromText(
    `${normalizedTitle} ${input.fileName} ${input.rawText}`,
  );
  const insertResult = await dataApi.rpc(
    "insert_service_document_with_keywords",
    {
      p_service_id: input.serviceId,
      p_payload: insertPayload,
      p_keywords: nextKeywords,
    },
  );
  const insertedRow = Array.isArray(insertResult.data)
    ? insertResult.data[0]
    : insertResult.data;
  if (
    insertResult.error ||
    !insertedRow ||
    typeof insertedRow !== "object"
  ) {
    await removeStoredFiles([storedFile]);
    throw new Error(
      insertResult.error?.message || "Kunne ikke lagre tjenestedokumentet.",
    );
  }
  const data = fromUnknownServiceDocumentSummaryRow(
    insertedRow as Record<string, unknown>,
  );

  after(async () => {
    await replaceServiceDocumentChunks({
      documentId,
      serviceId: input.serviceId,
      title: normalizedTitle,
      fileName: input.fileName,
      fileFormat: input.fileFormat,
      rawText: input.rawText,
      structureMap: normalizeDocumentChunkStructureMap(input.structureMap),
      sourceRevision: data.chunk_source_revision,
    }).catch(() => {
      // Chunk indexing improves retrieval, but the document is already saved.
    });
  });

  revalidateServiceCaches();
  return mapServiceDocument(data);
}

export async function deleteServiceDocument(
  serviceId: string,
  documentId: string,
) {
  const dataApi = createServiceClient();
  const { data: storedFile, error: storedFileError } = await dataApi
    .from("service_documents")
    .select("file_storage_bucket, file_storage_path")
    .eq("service_id", serviceId)
    .eq("id", documentId)
    .maybeSingle<{
      file_storage_bucket?: string | null;
      file_storage_path?: string | null;
    }>();
  if (storedFileError) {
    throw new Error(
      storedFileError.message ||
        "Kunne ikke lese tjenestedokumentets lagringsreferanse.",
    );
  }
  await runStorageFirstDeletion({
    removeStorage: async () => {
      await removeStoredFiles(
        storedFile
          ? [
              {
                bucket: storedFile.file_storage_bucket,
                path: storedFile.file_storage_path,
              },
            ]
          : [],
      );
      await removeStoredFilePrefixes(
        storedFileDeletionPrefixes({
          scope: "services",
          ownerId: serviceId,
          fileId: documentId,
          files: storedFile ? [storedFile] : [],
        }),
      );
    },
    deleteDatabaseRows: async () => {
      const { error } = await dataApi
        .from("service_documents")
        .delete()
        .eq("service_id", serviceId)
        .eq("id", documentId);
      if (error) {
        throw new Error(error.message);
      }
    },
  });
  await deleteDocumentChunks({
    sourceType: "service_document",
    sourceId: documentId,
  }).catch(() => {
    // Best-effort cleanup for deployments before the chunk table exists.
  });
  revalidateServiceCaches();
}

export async function deleteServiceDescription(serviceId: string) {
  const dataApi = createServiceClient();
  const storedFiles = await fetchStoredFileReferencesPaginated((from, to) =>
    dataApi
      .from("service_documents")
      .select("file_storage_bucket, file_storage_path")
      .eq("service_id", serviceId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  await runStorageFirstDeletion({
    removeStorage: async () => {
      await removeStoredFiles(
        storedFiles.map((file) => ({
          bucket: file.file_storage_bucket,
          path: file.file_storage_path,
        })),
      );
      await removeStoredFilePrefixes(
        storedFileDeletionPrefixes({
          scope: "services",
          ownerId: serviceId,
          files: storedFiles,
        }),
      );
    },
    deleteDatabaseRows: async () => {
      const { error } = await dataApi
        .from("service_descriptions")
        .delete()
        .eq("id", serviceId);
      if (error) {
        throw new Error(error.message);
      }
    },
  });
  revalidateServiceCaches();
}

export async function listServiceDocumentDetailsForProject(
  projectId: string,
  options?: {
    limit?: number;
    documentIds?: string[];
  },
): Promise<ServiceDocumentDetail[]> {
  const limit =
    typeof options?.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : undefined;

  if (limit === 0) {
    return [];
  }

  const dataApi = createServiceClient();
  const documentIdFilter = Array.isArray(options?.documentIds)
    ? options.documentIds
    : null;
  const documentIds = documentIdFilter ? documentIdFilter.filter(Boolean) : [];

  if (documentIdFilter && !documentIds.length) {
    return [];
  }

  if (documentIds.length) {
    let query = dataApi
      .from("service_documents")
      .select("*")
      .in("id", documentIds)
      .order("created_at", { ascending: false });

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(error.message);
    }

    return Promise.all(
      ((data ?? []) as ServiceDocumentRow[]).map(resolveServiceDocumentRow),
    );
  }

  const { data: selections, error: selectionsError } = await dataApi
    .from("project_service_selections")
    .select("service_id")
    .eq("project_id", projectId)
    .eq("selected", true);

  if (isMissingRelationColumn(selectionsError, "project_service_selections")) {
    return [];
  }
  if (selectionsError) {
    throw new Error(
      selectionsError.message || "Kunne ikke hente valgte tjenester.",
    );
  }

  const serviceIds = Array.from(
    new Set(
      ((selections ?? []) as Array<{ service_id: string }>)
        .map((item) => item.service_id)
        .filter(Boolean),
    ),
  );

  if (!serviceIds.length) {
    return [];
  }

  let query = dataApi
    .from("service_documents")
    .select("*")
    .in("service_id", serviceIds)
    .order("created_at", { ascending: false });

  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return Promise.all(
    ((data ?? []) as ServiceDocumentRow[]).map(resolveServiceDocumentRow),
  );
}

export async function listServiceDocumentSummariesForProject(
  projectId: string,
): Promise<ServiceDocument[]> {
  const dataApi = createServiceClient();
  const { data: selections, error: selectionsError } = await dataApi
    .from("project_service_selections")
    .select("service_id")
    .eq("project_id", projectId)
    .eq("selected", true);

  if (isMissingRelationColumn(selectionsError, "project_service_selections")) {
    return [];
  }
  if (selectionsError) {
    throw new Error(
      selectionsError.message || "Kunne ikke hente valgte tjenester.",
    );
  }

  const serviceIds = Array.from(
    new Set(
      ((selections ?? []) as Array<{ service_id: string }>)
        .map((item) => item.service_id)
        .filter(Boolean),
    ),
  );

  if (!serviceIds.length) {
    return [];
  }

  const rows = await fetchServiceDocumentSummaryRows((select) =>
    dataApi
      .from("service_documents")
      .select(select)
      .in("service_id", serviceIds)
      .order("created_at", { ascending: false }),
  );

  return rows.map(mapServiceDocument);
}

export async function updateServiceDocumentAiSummary(input: {
  documentId: string;
  aiSummary: string;
}) {
  const dataApi = createServiceClient();
  const { error } = await dataApi
    .from("service_documents")
    .update({
      ai_summary: encryptString(input.aiSummary),
      ai_summary_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error && !isMissingRelationColumn(error, "ai_summary")) {
    throw new Error(error.message);
  }

  revalidateServiceCaches();
}

export async function listProjectServiceDescriptions(
  projectId: string,
  options: { includeDocumentAiSummaries?: boolean } = {},
): Promise<ProjectServiceDescription[]> {
  const dataApi = createServiceClient();
  const [
    services,
    project,
    { data: documentRows },
    { data: selections, error: selectionsError },
  ] = await Promise.all([
    listServiceDescriptions({
      includeDocumentAiSummaries: options.includeDocumentAiSummaries,
    }),
    queryProjectRow(projectId),
    dataApi
      .from("documents")
      .select("title, file_name")
      .eq("project_id", projectId),
    dataApi
      .from("project_service_selections")
      .select("service_id, selected")
      .eq("project_id", projectId),
  ]);

  if (
    selectionsError &&
    !isMissingRelationColumn(selectionsError, "project_service_selections")
  ) {
    throw new Error(selectionsError.message);
  }

  const selected = new Map(
    ((selections ?? []) as Array<{ service_id: string; selected: boolean }>).map(
      (item) => [item.service_id, item.selected],
    ),
  );
  const projectKeywords = new Set(
    mergeKeywords(
      project.context_keywords,
      keywordsFromText(
        [
          project.name,
          project.customer_name ?? "",
          project.description ?? "",
          project.industry ?? "",
          ...((documentRows ?? []) as Array<{
            title: string | null;
            file_name: string | null;
          }>).map(
            (document) => `${document.title ?? ""} ${document.file_name ?? ""}`,
          ),
        ].join(" "),
      ),
    ),
  );

  return services.map((service) => {
    const serviceKeywords = mergeKeywords(
      service.keywords,
      keywordsFromText(
        [
          service.name,
          service.description,
          ...service.documents.map(
            (document) => `${document.title} ${document.file_name}`,
          ),
        ].join(" "),
      ),
    );
    const overlap = serviceKeywords.filter((word) =>
      projectKeywords.has(word),
    );
    const score = Math.min(
      100,
      Math.round((overlap.length / Math.max(4, serviceKeywords.length)) * 100),
    );
    return {
      ...service,
      selected: selected.get(service.id) ?? false,
      recommended: score >= 18,
      recommendation_score: score,
      recommendation_reason: overlap.length
        ? `Matcher prosjektet på ${overlap.slice(0, 4).join(", ")}.`
        : "Ingen tydelig match mot prosjektkonteksten ennå.",
    };
  });
}

export async function setProjectServiceSelections(
  projectId: string,
  serviceIds: string[],
) {
  const dataApi = createServiceClient();
  const uniqueIds = Array.from(new Set(serviceIds.filter(Boolean)));
  const { error } = await dataApi.rpc("replace_project_service_selections", {
    p_project_id: projectId,
    p_service_ids: uniqueIds,
  });

  if (error) {
    throw new Error(
      error.message || "Kunne ikke lagre prosjektets valgte tjenester.",
    );
  }

  revalidateProjectCaches(projectId);
}
