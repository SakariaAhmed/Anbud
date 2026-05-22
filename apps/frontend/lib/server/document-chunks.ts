import "server-only";

import { createHash } from "node:crypto";
import OpenAI from "openai";

import { decryptString, encryptString } from "@/lib/server/crypto";
import { createServiceClient } from "@/lib/server/supabase";
import type {
  DocumentFileFormat,
  ProjectDocumentDetail,
  ProjectDocumentRole,
  ProjectDocumentStructureEntry,
  ServiceDocumentDetail,
  SupportingDocumentSubtype,
} from "@/lib/types";

export const DOCUMENT_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";

type DocumentChunkSourceType = "project_document" | "service_document";
type DocumentChunkKind =
  | "section"
  | "page"
  | "paragraph"
  | "table"
  | "requirement"
  | "spreadsheet_rows";

export type SemanticDocumentChunk = {
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
  reference: string;
  text: string;
  headingPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  similarity: number | null;
  lexicalScore: number;
  score: number;
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

function normalizeChunkText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
}

function estimateTokenCount(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
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
    ...source.matchAll(/\[\[SIDE:(\d{1,5})\]\]/g),
  ]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));

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
  if (input.fileFormat === "xlsx" || input.fileFormat === "xls") {
    return "spreadsheet_rows";
  }

  if (
    /\b(req\.?|requirement|krav(?:tekst)?|shall|must|skal|må)\b/i.test(text) ||
    /\b[A-ZÆØÅ]{1,8}-?\d{1,5}(?:\.\d+)*\b/.test(text)
  ) {
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
  const pages = [...document.rawText.matchAll(/\[\[SIDE:(\d{1,5})\]\]/g)];
  if (!pages.length) {
    return [{ reference: document.title, text: document.rawText }];
  }

  const entries: ProjectDocumentStructureEntry[] = [];
  let lastIndex = 0;
  let lastPage = 1;

  for (const match of pages) {
    if (match.index > lastIndex) {
      entries.push({
        reference: `${document.title} side ${lastPage}`,
        text: document.rawText.slice(lastIndex, match.index),
      });
    }
    lastPage = Number(match[1]) || lastPage + 1;
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < document.rawText.length) {
    entries.push({
      reference: `${document.title} side ${lastPage}`,
      text: document.rawText.slice(lastIndex),
    });
  }

  return entries;
}

export function buildSemanticDocumentChunks(document: ChunkableDocument) {
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
    const batch = texts.slice(index, index + EMBEDDING_BATCH_SIZE);
    const response = await client.embeddings.create({
      model: DOCUMENT_EMBEDDING_MODEL,
      input: batch,
      encoding_format: "float",
    });
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

  let embeddings: number[][] = [];
  try {
    embeddings = await createEmbeddings(chunks.map((chunk) => chunk.text));
  } catch {
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
  }));

  try {
    await insertChunkRows(rows);
  } catch (error) {
    if (isChunkStorageUnavailable(error as { message?: string })) {
      return;
    }
    await insertChunkRows(rows, { withoutEmbeddings: true });
  }
}

async function hasExistingDocumentChunks(input: {
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

  return Boolean(data?.length);
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
    await hasExistingDocumentChunks({
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
    await hasExistingDocumentChunks({
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
        reference: candidate.chunk.reference,
        text: candidate.chunk.text,
        headingPath: candidate.chunk.headingPath,
        pageStart: candidate.chunk.pageStart,
        pageEnd: candidate.chunk.pageEnd,
        similarity: null,
        lexicalScore: score,
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

  const embedding = (await createEmbeddings([input.query]))[0];
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
      "id, source_type, source_id, document_title, reference, heading_path, page_start, page_end, text_encrypted, metadata",
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
      reference: row.reference,
      text,
      headingPath: row.heading_path ?? [],
      pageStart: row.page_start,
      pageEnd: row.page_end,
      similarity,
      lexicalScore: lexical,
      score: similarity * 28 + lexical,
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

export async function retrieveDocumentSnippets(input: {
  query: string;
  projectId?: string | null;
  documents?: ProjectDocumentDetail[];
  serviceDocuments?: ServiceDocumentDetail[];
  exactTerms?: string[];
  limit?: number;
}) {
  const query = normalizeChunkText(input.query);
  if (!query) {
    return [];
  }

  const documents = input.documents ?? [];
  const serviceDocuments = input.serviceDocuments ?? [];
  const sourceIds = [...documents, ...serviceDocuments].map((document) => document.id);
  const queryTokens = tokenizeForRetrieval(query);
  const exactTerms = (input.exactTerms ?? []).filter(Boolean);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 16);
  let vectorCandidates: RetrievedDocumentSnippet[] = [];

  try {
    vectorCandidates = await storedVectorCandidates({
      query,
      queryTokens,
      exactTerms,
      projectId: input.projectId,
      sourceIds,
      limit,
    });
  } catch {
    vectorCandidates = [];
  }

  const fallbackCandidates = memoryCandidates({
    queryTokens,
    exactTerms,
    documents,
    serviceDocuments,
  });

  return dedupeSnippets([...vectorCandidates, ...fallbackCandidates])
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
