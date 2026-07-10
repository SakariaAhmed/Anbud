import "server-only";

import { createHash } from "node:crypto";
import OpenAI from "openai";

import { decryptString, encryptString } from "@/lib/server/crypto";
import {
  assertProjectWorkflowActive,
  getProjectWorkflowAbortSignal,
  getProjectWorkflowLease,
} from "@/lib/server/project-workflow-cancellation";
import {
  rethrowAuthoritativeLeaseLoss,
  runLeaseFencedProjectMutation,
} from "@/lib/server/repositories/lease-fenced-persistence";
import { findPdfPageMarkers } from "@/lib/server/requirements/pdf-normalization";
import { createServiceClient } from "@/lib/server/supabase";
import type {
  DocumentFileFormat,
  ProjectDocumentDetail,
  ProjectDocumentRole,
  ProjectDocumentStructureEntry,
  ServiceDocumentDetail,
  SupportingDocumentSubtype,
} from "@/lib/types";

const DOCUMENT_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";

type DocumentChunkSourceType = "project_document" | "service_document";
type DocumentChunkKind =
  | "section"
  | "page"
  | "paragraph"
  | "table"
  | "requirement"
  | "requirement_row"
  | "answer_cell"
  | "evaluation_criteria"
  | "risk"
  | "commercial_term"
  | "architecture_signal"
  | "spreadsheet_rows";

type SemanticDocumentChunk = {
  chunkIndex: number;
  kind: DocumentChunkKind;
  reference: string;
  headingPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
};

export type RetrievedDocumentSnippet = {
  sourceType: DocumentChunkSourceType;
  sourceId: string;
  documentTitle: string;
  kind: DocumentChunkKind | null;
  reference: string;
  text: string;
  headingPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  similarity: number | null;
  lexicalScore: number;
  keywordRank?: number | null;
  semanticRank?: number | null;
  rrfScore?: number | null;
  retrievalSource?: "hybrid" | "vector" | "memory";
  score: number;
};

export type RetrievalQuality = {
  sufficient: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  topScore: number;
  semanticHits: number;
  keywordHits: number;
  lexicalHits: number;
  sourceCount: number;
  uniqueDocumentCount: number;
  exactTermCoverage: number;
};

export type RetrievalTelemetry = {
  query: string;
  exactTerms: string[];
  limit: number;
  sourceCount: number;
  usedHybridSearch: boolean;
  usedVectorSearch: boolean;
  usedMemoryFallback: boolean;
  durationMs: number;
  quality: RetrievalQuality;
};

export type DocumentSnippetRetrievalResult = {
  snippets: RetrievedDocumentSnippet[];
  telemetry: RetrievalTelemetry;
};

type ChunkableDocument = {
  id: string;
  projectId?: string | null;
  serviceId?: string | null;
  role?: ProjectDocumentRole | null;
  supportingSubtype?: SupportingDocumentSubtype | null;
  title: string;
  fileName: string;
  fileFormat: DocumentFileFormat;
  rawText: string;
  structureMap: ProjectDocumentStructureEntry[];
};

type StoredChunkRow = {
  id: string;
  source_type: DocumentChunkSourceType;
  source_id: string;
  document_title: string;
  kind: DocumentChunkKind;
  reference: string;
  heading_path: string[] | null;
  page_start: number | null;
  page_end: number | null;
  text_encrypted: string;
  metadata: Record<string, unknown> | null;
};

const MAX_CHUNK_CHARS = 4800;
const CHUNK_OVERLAP_CHARS = 550;
const EMBEDDING_BATCH_SIZE = 32;
const INSERT_BATCH_SIZE = 80;
const VECTOR_MATCH_THRESHOLD = 0.15;
const HYBRID_RRF_K = 50;
const HYBRID_MATCH_MULTIPLIER = 4;
const MIN_RETRIEVAL_QUALITY_SCORE = 9;
const EMBEDDING_RETRY_DELAYS_MS = [750, 2000];
const QUERY_EMBEDDING_CACHE_LIMIT = 128;

const RETRIEVAL_STOP_WORDS = new Set([
  "eller",
  "ikke",
  "skal",
  "som",
  "for",
  "med",
  "til",
  "det",
  "den",
  "dette",
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "have",
  "will",
  "must",
  "shall",
  "requirement",
  "requirements",
  "krav",
  "kunden",
  "leverandor",
  "leverandoren",
]);

let cachedEmbeddingClient: OpenAI | null = null;
let cachedChunkStorageAvailable: boolean | null = null;

function getEmbeddingClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  if (!cachedEmbeddingClient) {
    cachedEmbeddingClient = new OpenAI({ apiKey });
  }

  return cachedEmbeddingClient;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeChunkText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
}

function isSyntheticRequirementReference(value: string) {
  return /^side\s+\d{1,5}\s+krav\s+\d{1,5}$/i.test(value.trim());
}

function estimateTokenCount(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const queryEmbeddingCache = new Map<string, number[]>();

function queryEmbeddingCacheKey(query: string) {
  return `${DOCUMENT_EMBEDDING_MODEL}:${hashText(normalizeChunkText(query))}`;
}

function rememberQueryEmbedding(key: string, embedding: number[]) {
  if (queryEmbeddingCache.has(key)) {
    queryEmbeddingCache.delete(key);
  }
  queryEmbeddingCache.set(key, embedding);
  while (queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_LIMIT) {
    const oldestKey = queryEmbeddingCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    queryEmbeddingCache.delete(oldestKey);
  }
}

async function createQueryEmbedding(query: string) {
  const key = queryEmbeddingCacheKey(query);
  const cached = queryEmbeddingCache.get(key);
  if (cached) {
    queryEmbeddingCache.delete(key);
    queryEmbeddingCache.set(key, cached);
    return cached;
  }

  const embedding = (await createEmbeddings([query]))[0] ?? null;
  if (embedding) {
    rememberQueryEmbedding(key, embedding);
  }
  return embedding;
}

function comparableText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9aeo\s.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForRetrieval(value: string, limit = 180) {
  return Array.from(
    new Set(
      comparableText(value)
        .split(/\s+/)
        .filter((token) => token.length >= 4)
        .filter((token) => !RETRIEVAL_STOP_WORDS.has(token))
        .slice(0, limit),
    ),
  );
}

function pageRangeFrom(reference: string, text: string) {
  const source = `${reference}\n${text}`;
  const pageNumbers = [
    ...source.matchAll(/\b(?:side|page)\s+(\d{1,5})\b/gi),
  ]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  for (const marker of findPdfPageMarkers(source)) {
    pageNumbers.push(marker.startPage, marker.endPage);
  }

  if (!pageNumbers.length) {
    return { pageStart: null, pageEnd: null };
  }

  return {
    pageStart: Math.min(...pageNumbers),
    pageEnd: Math.max(...pageNumbers),
  };
}

function looksLikeHeading(line: string) {
  const text = line.trim();
  if (text.length < 4 || text.length > 140) {
    return false;
  }

  return (
    /^(kapittel|chapter|section|del|vedlegg|appendix)\b/i.test(text) ||
    /^\d{1,3}(?:\.\d{1,3})*\s+\S+/.test(text) ||
    /^[A-ZÆØÅ][A-ZÆØÅ0-9\s:()/.+-]{7,}$/.test(text)
  );
}

function headingFromReference(reference: string) {
  const parts = reference.split(/\s+[\u2013-]\s+/);
  const candidate = parts[parts.length - 1]?.trim() ?? "";
  if (!candidate || /^side\s+\d+$/i.test(candidate) || /^tekstblokk\s+\d+$/i.test(candidate)) {
    return "";
  }
  return candidate;
}

function nextHeadingPath(current: string[], reference: string, text: string) {
  const firstLine = normalizeChunkText(text).split("\n").find(Boolean) ?? "";
  const heading = looksLikeHeading(firstLine)
    ? firstLine
    : headingFromReference(reference);

  if (!heading) {
    return current;
  }

  const numbered = heading.match(/^(\d{1,3}(?:\.\d{1,3})*)\s+/);
  if (!numbered) {
    return [heading].slice(-4);
  }

  const depth = numbered[1].split(".").length;
  return [...current.slice(0, Math.max(0, depth - 1)), heading].slice(-6);
}

function detectChunkKind(input: {
  fileFormat: DocumentFileFormat;
  reference: string;
  text: string;
}): DocumentChunkKind {
  const text = input.text;
  if (
    isSyntheticRequirementReference(text) ||
    isSyntheticRequirementReference(input.reference)
  ) {
    return /\bside\s+\d+\b/i.test(input.reference) ? "page" : "paragraph";
  }

  if (input.fileFormat === "xlsx" || input.fileFormat === "xls") {
    return "spreadsheet_rows";
  }

  if (/\b(evalueringskriter|award criteria|tildelingskriter|evaluation criteria)\b/i.test(text)) {
    return "evaluation_criteria";
  }

  if (/\b(risiko|risk|sårbarhet|mitigering|avvik)\b/i.test(text)) {
    return "risk";
  }

  if (/\b(pris|kostnad|betaling|kontrakt|ssa-|sanksjon|dagmulkt|commercial|pricing)\b/i.test(text)) {
    return "commercial_term";
  }

  if (/\b(arkitektur|architecture|integrasjon|api|plattform|sikkerhet|identity|monitorering|backup)\b/i.test(text)) {
    return "architecture_signal";
  }

  if (
    /\b(req\.?|requirement|krav(?:tekst)?|shall|must|skal|må)\b/i.test(text) ||
    /\b[A-ZÆØÅ]{1,8}-?\d{1,5}(?:\.\d+)*\b/.test(text)
  ) {
    if (/\b(svar|answer|besvarelse|response)\b/i.test(input.reference)) {
      return "answer_cell";
    }
    if (/\b(tabell|table|rad|row)\b/i.test(input.reference) || text.includes(" | ")) {
      return "requirement_row";
    }
    return "requirement";
  }

  if (/\b(table|tabell|row|rad|kolonne|column)\b/i.test(text) || text.includes(" | ")) {
    return "table";
  }

  if (/\bside\s+\d+\b/i.test(input.reference)) {
    return "page";
  }

  return looksLikeHeading(text.split("\n").find(Boolean) ?? "") ? "section" : "paragraph";
}

function findSplitPoint(text: string, preferredEnd: number, minimumEnd: number) {
  const boundedEnd = Math.min(preferredEnd, text.length);
  const window = text.slice(minimumEnd, boundedEnd);
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak >= 0) {
    return minimumEnd + paragraphBreak;
  }

  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak >= 0) {
    return minimumEnd + lineBreak;
  }

  const sentenceBreak = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  );
  if (sentenceBreak >= 0) {
    return minimumEnd + sentenceBreak + 1;
  }

  const wordBreak = window.lastIndexOf(" ");
  return wordBreak >= 0 ? minimumEnd + wordBreak : boundedEnd;
}

function splitTextWithOverlap(text: string) {
  const normalized = normalizeChunkText(text);
  if (!normalized) {
    return [];
  }

  if (normalized.length <= MAX_CHUNK_CHARS) {
    return [normalized];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const preferredEnd = cursor + MAX_CHUNK_CHARS;
    const minimumEnd = Math.min(cursor + Math.floor(MAX_CHUNK_CHARS * 0.72), normalized.length);
    const end =
      preferredEnd >= normalized.length
        ? normalized.length
        : findSplitPoint(normalized, preferredEnd, minimumEnd);
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }

    const nextCursor = Math.max(0, end - CHUNK_OVERLAP_CHARS);
    cursor = nextCursor <= cursor ? end : nextCursor;
  }

  return chunks;
}

function entriesFromRawText(document: ChunkableDocument) {
  const pageMarkers = findPdfPageMarkers(document.rawText);
  if (!pageMarkers.length) {
    return [{ reference: document.title, text: document.rawText }];
  }

  const entries: ProjectDocumentStructureEntry[] = [];
  for (const [index, marker] of pageMarkers.entries()) {
    const nextMarker = pageMarkers[index + 1];
    const textStart = marker.index + marker.marker.length;
    const textEnd = nextMarker?.index ?? document.rawText.length;
    const text = document.rawText.slice(textStart, textEnd);
    if (normalizeChunkText(text)) {
      const reference =
        marker.startPage === marker.endPage
          ? `${document.title} side ${marker.startPage}`
          : `${document.title} side ${marker.startPage}-${marker.endPage}`;
      entries.push({
        reference,
        text,
        page: marker.startPage,
      });
    }
  }

  return entries;
}

function buildSemanticDocumentChunks(document: ChunkableDocument) {
  const entries = Array.isArray(document.structureMap) && document.structureMap.length
    ? document.structureMap
    : entriesFromRawText(document);
  const chunks: SemanticDocumentChunk[] = [];
  let headingPath: string[] = [];

  for (const entry of entries) {
    const entryText = normalizeChunkText(entry.text);
    if (!entryText) {
      continue;
    }

    headingPath = nextHeadingPath(headingPath, entry.reference, entryText);
    const kind = detectChunkKind({
      fileFormat: document.fileFormat,
      reference: entry.reference,
      text: entryText,
    });
    const pageRange = pageRangeFrom(entry.reference, entryText);
    const parts = splitTextWithOverlap(entryText);

    for (const [partIndex, part] of parts.entries()) {
      chunks.push({
        chunkIndex: chunks.length,
        kind,
        reference:
          parts.length > 1
            ? `${entry.reference} del ${partIndex + 1}`
            : entry.reference,
        headingPath,
        ...pageRange,
        text: part,
        tokenCount: estimateTokenCount(part),
        metadata: {
          file_name: document.fileName,
          file_format: document.fileFormat,
          role: document.role ?? null,
          supporting_subtype: document.supportingSubtype ?? null,
          content_hash: hashText(part),
        },
      });
    }
  }

  return chunks;
}

function isChunkStorageUnavailable(error: { message?: string } | null | undefined) {
  const message = (error?.message ?? "").toLowerCase();
  return (
    message.includes("document_chunks") &&
    (message.includes("does not exist") ||
      message.includes("schema cache") ||
      message.includes("relation") ||
      message.includes("function"))
  );
}

function isRetrievalStorageUnavailable(error: { message?: string } | null | undefined) {
  const message = (error?.message ?? "").toLowerCase();
  return (
    isChunkStorageUnavailable(error) ||
    message.includes("hybrid_match_document_chunks") ||
    message.includes("update_document_chunk_search_vectors") ||
    message.includes("could not find the function") ||
    message.includes("schema cache")
  );
}

async function hasChunkStorage() {
  if (cachedChunkStorageAvailable === false) {
    return false;
  }
  if (cachedChunkStorageAvailable === true) {
    return true;
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("document_chunks")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (error) {
    if (isChunkStorageUnavailable(error)) {
      cachedChunkStorageAvailable = false;
      return false;
    }
    return true;
  }

  cachedChunkStorageAvailable = true;
  return true;
}

async function createEmbeddings(texts: string[]) {
  const client = getEmbeddingClient();
  if (!client || !texts.length) {
    return [];
  }

  const embeddings: number[][] = [];

  for (let index = 0; index < texts.length; index += EMBEDDING_BATCH_SIZE) {
    assertProjectWorkflowActive();
    const batch = texts.slice(index, index + EMBEDDING_BATCH_SIZE);
    let response: Awaited<ReturnType<typeof client.embeddings.create>> | null = null;
    for (let attempt = 0; attempt <= EMBEDDING_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        assertProjectWorkflowActive();
        response = await client.embeddings.create(
          {
            model: DOCUMENT_EMBEDDING_MODEL,
            input: batch,
            encoding_format: "float",
          },
          getProjectWorkflowAbortSignal()
            ? { signal: getProjectWorkflowAbortSignal() }
            : undefined,
        );
        break;
      } catch (error) {
        assertProjectWorkflowActive();
        if (attempt >= EMBEDDING_RETRY_DELAYS_MS.length) {
          throw error;
        }
        await sleep(EMBEDDING_RETRY_DELAYS_MS[attempt] ?? 1000);
      }
    }
    if (!response) {
      throw new Error("Embedding-kall returnerte ikke svar.");
    }
    for (const item of response.data) {
      embeddings[index + item.index] = item.embedding;
    }
  }

  return embeddings;
}

async function insertChunkRows(
  rows: Array<Record<string, unknown>>,
  options?: { withoutEmbeddings?: boolean },
) {
  const supabase = createServiceClient();
  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + INSERT_BATCH_SIZE).map((row) => {
      if (!options?.withoutEmbeddings) {
        return row;
      }
      const { embedding: _embedding, ...rest } = row;
      return rest;
    });
    const { error } = await supabase.from("document_chunks").insert(batch);
    if (error) {
      throw error;
    }
  }
}

function chunkSearchText(document: ChunkableDocument, chunk: SemanticDocumentChunk) {
  return normalizeChunkText(
    [
      document.title,
      document.fileName,
      document.role ?? "",
      document.supportingSubtype ?? "",
      chunk.kind,
      chunk.reference,
      chunk.headingPath.join(" "),
      chunk.text,
    ].join("\n"),
  );
}

async function updateChunkSearchVectors(input: {
  sourceType: DocumentChunkSourceType;
  sourceId: string;
  chunks: SemanticDocumentChunk[];
  document: ChunkableDocument;
}) {
  if (!input.chunks.length) {
    return;
  }

  const supabase = createServiceClient();
  const { error } = await supabase.rpc("update_document_chunk_search_vectors", {
    source_type_filter: input.sourceType,
    source_id_filter: input.sourceId,
    chunks: input.chunks.map((chunk) => ({
      chunk_index: chunk.chunkIndex,
      search_text: chunkSearchText(input.document, chunk),
    })),
  });

  if (error && !isRetrievalStorageUnavailable(error)) {
    throw new Error(error.message);
  }
}

async function replaceDocumentChunks(input: {
  sourceType: DocumentChunkSourceType;
  sourceId: string;
  projectId?: string | null;
  serviceId?: string | null;
  document: ChunkableDocument;
}) {
  if (!(await hasChunkStorage())) {
    return;
  }

  const chunks = buildSemanticDocumentChunks(input.document);

  let embeddings: number[][] = [];
  try {
    embeddings = await createEmbeddings(chunks.map((chunk) => chunk.text));
  } catch (error) {
    rethrowAuthoritativeLeaseLoss(error);
    assertProjectWorkflowActive();
    embeddings = [];
  }

  const now = new Date().toISOString();
  const rows = chunks.map((chunk, index) => ({
    source_type: input.sourceType,
    source_id: input.sourceId,
    project_id: input.projectId ?? null,
    service_id: input.serviceId ?? null,
    document_title: input.document.title,
    file_name: input.document.fileName,
    file_format: input.document.fileFormat,
    role: input.document.role ?? null,
    supporting_subtype: input.document.supportingSubtype ?? null,
    chunk_index: chunk.chunkIndex,
    kind: chunk.kind,
    reference: chunk.reference,
    heading_path: chunk.headingPath,
    page_start: chunk.pageStart,
    page_end: chunk.pageEnd,
    token_count: chunk.tokenCount,
    text_encrypted: encryptString(chunk.text),
    content_hash: String(chunk.metadata.content_hash ?? hashText(chunk.text)),
    metadata: chunk.metadata,
    embedding: embeddings[index] ?? null,
    embedding_model: embeddings[index] ? DOCUMENT_EMBEDDING_MODEL : null,
    embedding_created_at: embeddings[index] ? now : null,
    search_text: chunkSearchText(input.document, chunk),
  }));

  const lease = getProjectWorkflowLease();
  if (lease) {
    const fencedPayload = {
      source_type: input.sourceType,
      source_id: input.sourceId,
      rows,
    };
    try {
      await runLeaseFencedProjectMutation(
        lease.projectId,
        "replace_document_chunks",
        fencedPayload,
      );
    } catch (error) {
      rethrowAuthoritativeLeaseLoss(error);
      await runLeaseFencedProjectMutation(
        lease.projectId,
        "replace_document_chunks",
        {
          ...fencedPayload,
          rows: rows.map(({ embedding: _embedding, ...row }) => ({
            ...row,
            embedding: null,
            embedding_model: null,
            embedding_created_at: null,
          })),
        },
      );
    }
    return;
  }

  const supabase = createServiceClient();
  const deleteResult = await supabase
    .from("document_chunks")
    .delete()
    .eq("source_type", input.sourceType)
    .eq("source_id", input.sourceId);

  if (deleteResult.error) {
    if (isChunkStorageUnavailable(deleteResult.error)) {
      return;
    }
    throw new Error(deleteResult.error.message);
  }

  if (!chunks.length) {
    return;
  }

  try {
    await insertChunkRows(rows);
  } catch (error) {
    rethrowAuthoritativeLeaseLoss(error);
    if (isChunkStorageUnavailable(error as { message?: string })) {
      return;
    }
    await insertChunkRows(rows, { withoutEmbeddings: true });
  }

  await updateChunkSearchVectors({
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    chunks,
    document: input.document,
  }).catch((error) => {
    rethrowAuthoritativeLeaseLoss(error);
    // Full-text vectors improve hybrid retrieval but should not block indexing.
  });
}

async function hasCompleteExistingDocumentChunks(input: {
  sourceType: DocumentChunkSourceType;
  sourceId: string;
}) {
  if (!(await hasChunkStorage())) {
    return true;
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("document_chunks")
    .select("id")
    .eq("source_type", input.sourceType)
    .eq("source_id", input.sourceId)
    .limit(1);

  if (error) {
    return true;
  }

  if (!data?.length) {
    return false;
  }

  if (!getEmbeddingClient()) {
    return true;
  }

  const { data: incompleteRows, error: incompleteError } = await supabase
    .from("document_chunks")
    .select("id")
    .eq("source_type", input.sourceType)
    .eq("source_id", input.sourceId)
    .or(
      `embedding_created_at.is.null,embedding_model.is.null,embedding_model.neq.${DOCUMENT_EMBEDDING_MODEL}`,
    )
    .limit(1);

  if (incompleteError) {
    return true;
  }

  return !incompleteRows?.length;
}

export async function replaceProjectDocumentChunks(input: {
  documentId: string;
  projectId: string;
  role: ProjectDocumentRole;
  supportingSubtype?: SupportingDocumentSubtype | null;
  title: string;
  fileName: string;
  fileFormat: DocumentFileFormat;
  rawText: string;
  structureMap: ProjectDocumentStructureEntry[];
}) {
  await replaceDocumentChunks({
    sourceType: "project_document",
    sourceId: input.documentId,
    projectId: input.projectId,
    document: {
      id: input.documentId,
      projectId: input.projectId,
      role: input.role,
      supportingSubtype: input.supportingSubtype ?? null,
      title: input.title,
      fileName: input.fileName,
      fileFormat: input.fileFormat,
      rawText: input.rawText,
      structureMap: input.structureMap,
    },
  });
}

export async function ensureProjectDocumentChunks(input: {
  document: ProjectDocumentDetail;
}) {
  if (
    await hasCompleteExistingDocumentChunks({
      sourceType: "project_document",
      sourceId: input.document.id,
    })
  ) {
    return;
  }

  await replaceProjectDocumentChunks({
    documentId: input.document.id,
    projectId: input.document.project_id,
    role: input.document.role,
    supportingSubtype: input.document.supporting_subtype,
    title: input.document.title,
    fileName: input.document.file_name,
    fileFormat: input.document.file_format,
    rawText: input.document.raw_text,
    structureMap: input.document.structure_map,
  });
}

export async function replaceServiceDocumentChunks(input: {
  documentId: string;
  serviceId: string;
  title: string;
  fileName: string;
  fileFormat: DocumentFileFormat;
  rawText: string;
  structureMap: ProjectDocumentStructureEntry[];
}) {
  await replaceDocumentChunks({
    sourceType: "service_document",
    sourceId: input.documentId,
    serviceId: input.serviceId,
    document: {
      id: input.documentId,
      serviceId: input.serviceId,
      title: input.title,
      fileName: input.fileName,
      fileFormat: input.fileFormat,
      rawText: input.rawText,
      structureMap: input.structureMap,
    },
  });
}

export async function ensureServiceDocumentChunks(input: {
  document: ServiceDocumentDetail;
}) {
  if (
    await hasCompleteExistingDocumentChunks({
      sourceType: "service_document",
      sourceId: input.document.id,
    })
  ) {
    return;
  }

  await replaceServiceDocumentChunks({
    documentId: input.document.id,
    serviceId: input.document.service_id,
    title: input.document.title,
    fileName: input.document.file_name,
    fileFormat: input.document.file_format,
    rawText: input.document.raw_text,
    structureMap: input.document.structure_map,
  });
}

export async function deleteDocumentChunks(input: {
  sourceType: DocumentChunkSourceType;
  sourceId: string;
}) {
  if (!(await hasChunkStorage())) {
    return;
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("document_chunks")
    .delete()
    .eq("source_type", input.sourceType)
    .eq("source_id", input.sourceId);

  if (error && !isChunkStorageUnavailable(error)) {
    throw new Error(error.message);
  }
}

function lexicalScore(input: {
  queryTokens: string[];
  exactTerms: string[];
  title: string;
  reference: string;
  text: string;
}) {
  const haystack = comparableText(`${input.title} ${input.reference} ${input.text}`);
  const tokenHits = input.queryTokens.reduce(
    (sum, token) => sum + (haystack.includes(token) ? 1 : 0),
    0,
  );
  const exactHits = input.exactTerms.reduce((sum, term) => {
    const normalized = comparableText(term);
    return sum + (normalized && haystack.includes(normalized) ? 1 : 0);
  }, 0);

  return tokenHits + exactHits * 5;
}

function memoryCandidates(input: {
  queryTokens: string[];
  exactTerms: string[];
  documents: ProjectDocumentDetail[];
  serviceDocuments: ServiceDocumentDetail[];
}) {
  const projectCandidates = input.documents.flatMap((document) =>
    buildSemanticDocumentChunks({
      id: document.id,
      projectId: document.project_id,
      role: document.role,
      supportingSubtype: document.supporting_subtype,
      title: document.title,
      fileName: document.file_name,
      fileFormat: document.file_format,
      rawText: document.raw_text,
      structureMap: document.structure_map,
    }).map((chunk) => ({
      sourceType: "project_document" as const,
      sourceId: document.id,
      documentTitle: document.title,
      chunk,
    })),
  );
  const serviceCandidates = input.serviceDocuments.flatMap((document) =>
    buildSemanticDocumentChunks({
      id: document.id,
      serviceId: document.service_id,
      title: document.title,
      fileName: document.file_name,
      fileFormat: document.file_format,
      rawText: document.raw_text,
      structureMap: document.structure_map,
    }).map((chunk) => ({
      sourceType: "service_document" as const,
      sourceId: document.id,
      documentTitle: document.title,
      chunk,
    })),
  );

  return [...projectCandidates, ...serviceCandidates]
    .map((candidate) => {
      const score = lexicalScore({
        queryTokens: input.queryTokens,
        exactTerms: input.exactTerms,
        title: candidate.documentTitle,
        reference: candidate.chunk.reference,
        text: candidate.chunk.text,
      });
      return {
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        documentTitle: candidate.documentTitle,
        kind: candidate.chunk.kind,
        reference: candidate.chunk.reference,
        text: candidate.chunk.text,
        headingPath: candidate.chunk.headingPath,
        pageStart: candidate.chunk.pageStart,
        pageEnd: candidate.chunk.pageEnd,
        similarity: null,
        lexicalScore: score,
        retrievalSource: "memory" as const,
        score,
      };
    })
    .filter((candidate) => candidate.score > 0);
}

async function storedVectorCandidates(input: {
  query: string;
  queryTokens: string[];
  exactTerms: string[];
  projectId?: string | null;
  sourceIds: string[];
  limit: number;
}) {
  if (!(await hasChunkStorage())) {
    return [];
  }

  const embedding = await createQueryEmbedding(input.query);
  if (!embedding) {
    return [];
  }

  const supabase = createServiceClient();
  const { data: matches, error: matchError } = await supabase.rpc(
    "match_document_chunks",
    {
      query_embedding: embedding,
      match_count: Math.min(Math.max(input.limit * 4, 12), 48),
      match_threshold: VECTOR_MATCH_THRESHOLD,
      project_filter: input.projectId ?? null,
      source_id_filter: input.sourceIds.length ? input.sourceIds : null,
    },
  );

  if (matchError) {
    if (isChunkStorageUnavailable(matchError)) {
      return [];
    }
    throw new Error(matchError.message);
  }

  const ids = ((matches ?? []) as Array<{ id?: string }>)
    .map((match) => match.id)
    .filter((id): id is string => Boolean(id));
  if (!ids.length) {
    return [];
  }

  const similarityById = new Map(
    ((matches ?? []) as Array<{ id?: string; similarity?: number }>).map((match) => [
      match.id ?? "",
      typeof match.similarity === "number" ? match.similarity : 0,
    ]),
  );
  const { data: rows, error: rowsError } = await supabase
    .from("document_chunks")
    .select(
      "id, source_type, source_id, document_title, kind, reference, heading_path, page_start, page_end, text_encrypted, metadata",
    )
    .in("id", ids);

  if (rowsError) {
    if (isChunkStorageUnavailable(rowsError)) {
      return [];
    }
    throw new Error(rowsError.message);
  }

  return ((rows ?? []) as StoredChunkRow[]).map((row) => {
    const text = decryptString(row.text_encrypted);
    const lexical = lexicalScore({
      queryTokens: input.queryTokens,
      exactTerms: input.exactTerms,
      title: row.document_title,
      reference: row.reference,
      text,
    });
    const similarity = similarityById.get(row.id) ?? 0;
    return {
      sourceType: row.source_type,
      sourceId: row.source_id,
      documentTitle: row.document_title,
      kind: row.kind,
      reference: row.reference,
      text,
      headingPath: row.heading_path ?? [],
      pageStart: row.page_start,
      pageEnd: row.page_end,
      similarity,
      lexicalScore: lexical,
      semanticRank: null,
      retrievalSource: "vector" as const,
      score: similarity * 28 + lexical,
    };
  });
}

async function storedHybridCandidates(input: {
  query: string;
  queryTokens: string[];
  exactTerms: string[];
  projectId?: string | null;
  sourceIds: string[];
  limit: number;
}) {
  if (!(await hasChunkStorage())) {
    return [];
  }

  const embedding = await createQueryEmbedding(input.query);
  if (!embedding) {
    return [];
  }

  const matchCount = Math.min(
    Math.max(input.limit * HYBRID_MATCH_MULTIPLIER, 12),
    64,
  );
  const supabase = createServiceClient();
  const { data: matches, error: matchError } = await supabase.rpc(
    "hybrid_match_document_chunks",
    {
      query_embedding: embedding,
      query_text: input.query,
      match_count: matchCount,
      match_threshold: VECTOR_MATCH_THRESHOLD,
      project_filter: input.projectId ?? null,
      source_id_filter: input.sourceIds.length ? input.sourceIds : null,
      rrf_k: HYBRID_RRF_K,
      full_text_weight: 1,
      semantic_weight: 1,
    },
  );

  if (matchError) {
    if (isRetrievalStorageUnavailable(matchError)) {
      return [];
    }
    throw new Error(matchError.message);
  }

  const matchRows = (matches ?? []) as Array<{
    id?: string;
    similarity?: number | null;
    keyword_rank?: number | null;
    semantic_rank?: number | null;
    rrf_score?: number | null;
  }>;
  const ids = matchRows
    .map((match) => match.id)
    .filter((id): id is string => Boolean(id));
  if (!ids.length) {
    return [];
  }

  const matchById = new Map(matchRows.map((match) => [match.id ?? "", match]));
  const { data: rows, error: rowsError } = await supabase
    .from("document_chunks")
    .select(
      "id, source_type, source_id, document_title, kind, reference, heading_path, page_start, page_end, text_encrypted, metadata",
    )
    .in("id", ids);

  if (rowsError) {
    if (isRetrievalStorageUnavailable(rowsError)) {
      return [];
    }
    throw new Error(rowsError.message);
  }

  return ((rows ?? []) as StoredChunkRow[]).map((row) => {
    const text = decryptString(row.text_encrypted);
    const match = matchById.get(row.id);
    const lexical = lexicalScore({
      queryTokens: input.queryTokens,
      exactTerms: input.exactTerms,
      title: row.document_title,
      reference: row.reference,
      text,
    });
    const similarity =
      typeof match?.similarity === "number" ? match.similarity : null;
    const rrfScore =
      typeof match?.rrf_score === "number" ? match.rrf_score : null;

    return {
      sourceType: row.source_type,
      sourceId: row.source_id,
      documentTitle: row.document_title,
      kind: row.kind,
      reference: row.reference,
      text,
      headingPath: row.heading_path ?? [],
      pageStart: row.page_start,
      pageEnd: row.page_end,
      similarity,
      lexicalScore: lexical,
      keywordRank: match?.keyword_rank ?? null,
      semanticRank: match?.semantic_rank ?? null,
      rrfScore,
      retrievalSource: "hybrid" as const,
      score: (rrfScore ?? 0) * 120 + (similarity ?? 0) * 18 + lexical,
    };
  });
}

function dedupeSnippets(candidates: RetrievedDocumentSnippet[]) {
  const byKey = new Map<string, RetrievedDocumentSnippet>();
  for (const candidate of candidates) {
    const key = [
      candidate.sourceType,
      candidate.sourceId,
      candidate.reference,
      hashText(candidate.text.slice(0, 700)),
    ].join(":");
    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function kindBoost(kind: DocumentChunkKind | null) {
  switch (kind) {
    case "requirement":
    case "requirement_row":
    case "evaluation_criteria":
      return 3;
    case "table":
    case "spreadsheet_rows":
    case "answer_cell":
      return 2;
    case "risk":
    case "commercial_term":
    case "architecture_signal":
      return 1.5;
    default:
      return 0;
  }
}

function rerankSnippets(input: {
  candidates: RetrievedDocumentSnippet[];
  queryTokens: string[];
  exactTerms: string[];
}) {
  return dedupeSnippets(input.candidates)
    .map((candidate) => {
      const headingText = candidate.headingPath.join(" ");
      const focusedLexicalScore = lexicalScore({
        queryTokens: input.queryTokens,
        exactTerms: input.exactTerms,
        title: candidate.documentTitle,
        reference: `${candidate.reference} ${headingText}`,
        text: candidate.text,
      });
      const exactTermBoost = input.exactTerms.length
        ? Math.min(
            focusedLexicalScore,
            input.exactTerms.length * 6,
          )
        : 0;
      const hybridBoost =
        candidate.retrievalSource === "hybrid"
          ? (candidate.rrfScore ?? 0) * 180
          : 0;
      const semanticBoost = (candidate.similarity ?? 0) * 22;
      return {
        ...candidate,
        lexicalScore: Math.max(candidate.lexicalScore, focusedLexicalScore),
        score:
          candidate.score +
          focusedLexicalScore * 1.8 +
          exactTermBoost +
          kindBoost(candidate.kind) +
          hybridBoost +
          semanticBoost,
      };
    })
    .sort((left, right) => right.score - left.score);
}

function assessRetrievalQuality(input: {
  snippets: RetrievedDocumentSnippet[];
  exactTerms: string[];
}) {
  const snippets = input.snippets;
  const topScore = snippets[0]?.score ?? 0;
  const sourceCount = snippets.length;
  const semanticHits = snippets.filter(
    (snippet) => (snippet.similarity ?? 0) >= VECTOR_MATCH_THRESHOLD,
  ).length;
  const keywordHits = snippets.filter(
    (snippet) =>
      snippet.keywordRank != null ||
      snippet.lexicalScore > 0,
  ).length;
  const lexicalHits = snippets.filter((snippet) => snippet.lexicalScore > 0).length;
  const uniqueDocumentCount = new Set(
    snippets.map((snippet) => `${snippet.sourceType}:${snippet.sourceId}`),
  ).size;
  const exactTerms = input.exactTerms.map(comparableText).filter(Boolean);
  const exactTermCoverage = exactTerms.length
    ? exactTerms.filter((term) =>
        snippets.some((snippet) =>
          comparableText(
            `${snippet.documentTitle} ${snippet.reference} ${snippet.text}`,
          ).includes(term),
        ),
      ).length / exactTerms.length
    : 1;
  const qualityScore =
    Math.min(topScore / 6, 10) +
    Math.min(sourceCount, 4) +
    Math.min(semanticHits, 3) +
    Math.min(keywordHits, 3) +
    Math.min(uniqueDocumentCount, 2) +
    exactTermCoverage * 4;
  const sufficient =
    sourceCount > 0 &&
    qualityScore >= MIN_RETRIEVAL_QUALITY_SCORE &&
    exactTermCoverage >= 0.4;
  const confidence: RetrievalQuality["confidence"] =
    sufficient && qualityScore >= 18
      ? "high"
      : sufficient
        ? "medium"
        : "low";

  return {
    sufficient,
    confidence,
    reason: sufficient
      ? "Retrieval fant nok relevante, varierte kilder."
      : "Retrieval fant for svakt eller for smalt kildegrunnlag.",
    topScore,
    semanticHits,
    keywordHits,
    lexicalHits,
    sourceCount,
    uniqueDocumentCount,
    exactTermCoverage,
  };
}

export async function retrieveDocumentSnippetsWithMetadata(input: {
  query: string;
  projectId?: string | null;
  documents?: ProjectDocumentDetail[];
  serviceDocuments?: ServiceDocumentDetail[];
  exactTerms?: string[];
  limit?: number;
}): Promise<DocumentSnippetRetrievalResult> {
  const startedAt = Date.now();
  const query = normalizeChunkText(input.query);
  if (!query) {
    const quality = assessRetrievalQuality({ snippets: [], exactTerms: [] });
    return {
      snippets: [],
      telemetry: {
        query: "",
        exactTerms: [],
        limit: input.limit ?? 8,
        sourceCount: 0,
        usedHybridSearch: false,
        usedVectorSearch: false,
        usedMemoryFallback: false,
        durationMs: 0,
        quality,
      },
    };
  }

  const documents = input.documents ?? [];
  const serviceDocuments = input.serviceDocuments ?? [];
  const sourceIds = [...documents, ...serviceDocuments].map((document) => document.id);
  const queryTokens = tokenizeForRetrieval(query);
  const exactTerms = (input.exactTerms ?? []).filter(Boolean);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 16);
  let hybridCandidates: RetrievedDocumentSnippet[] = [];
  let vectorCandidates: RetrievedDocumentSnippet[] = [];
  let usedHybridSearch = false;
  let usedVectorSearch = false;
  let usedMemoryFallback = false;

  try {
    hybridCandidates = await storedHybridCandidates({
      query,
      queryTokens,
      exactTerms,
      projectId: input.projectId,
      sourceIds,
      limit,
    });
    usedHybridSearch = hybridCandidates.length > 0;
  } catch {
    hybridCandidates = [];
  }

  if (!hybridCandidates.length) {
    try {
      vectorCandidates = await storedVectorCandidates({
        query,
        queryTokens,
        exactTerms,
        projectId: input.projectId,
        sourceIds,
        limit,
      });
      usedVectorSearch = vectorCandidates.length > 0;
    } catch {
      vectorCandidates = [];
    }
  }

  const fallbackCandidates =
    !hybridCandidates.length && !vectorCandidates.length
      ? memoryCandidates({
          queryTokens,
          exactTerms,
          documents,
          serviceDocuments,
        })
      : [];
  usedMemoryFallback = fallbackCandidates.length > 0;

  const snippets = rerankSnippets({
    candidates: [...hybridCandidates, ...vectorCandidates, ...fallbackCandidates],
    queryTokens,
    exactTerms,
  })
    .slice(0, limit);
  const quality = assessRetrievalQuality({ snippets, exactTerms });
  const telemetry = {
    query,
    exactTerms,
    limit,
    sourceCount: snippets.length,
    usedHybridSearch,
    usedVectorSearch,
    usedMemoryFallback,
    durationMs: Date.now() - startedAt,
    quality,
  };

  console.info(
    JSON.stringify({
      event: "document_retrieval",
      project_id: input.projectId ?? null,
      source_ids: sourceIds.length,
      query_hash: hashText(query).slice(0, 16),
      exact_term_count: exactTerms.length,
      limit,
      sourceCount: telemetry.sourceCount,
      usedHybridSearch,
      usedVectorSearch,
      usedMemoryFallback,
      durationMs: telemetry.durationMs,
      quality: {
        ...quality,
        topScore: Math.round(quality.topScore * 100) / 100,
      },
    }),
  );

  return { snippets, telemetry };
}

export async function retrieveDocumentSnippets(input: {
  query: string;
  projectId?: string | null;
  documents?: ProjectDocumentDetail[];
  serviceDocuments?: ServiceDocumentDetail[];
  exactTerms?: string[];
  limit?: number;
}) {
  const result = await retrieveDocumentSnippetsWithMetadata(input);
  return result.snippets;
}
