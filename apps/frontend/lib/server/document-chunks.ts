import "server-only";

import { createHash } from "node:crypto";
import OpenAI from "openai";

import { decryptString, encryptString } from "@/lib/server/crypto";
import { normalizeDocumentChunkStructureMap } from "@/lib/server/document-chunk-structure";
import {
  createMemoizedEmbeddingRequest,
  embeddingFallbackMetadata,
  EmbeddingRequestTimeoutError,
  runEmbeddingRequestWithDeadline,
} from "@/lib/server/embedding-request";
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
import { createServiceClient } from "@/lib/server/data-api";
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
  /** In memory only: the structure entry this part was cut from. */
  sectionIndex: number;
  sectionReference: string;
  sectionText: string;
  sectionOffset: number;
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
  /** Position in the stored chunk set; null when it cannot be traced. */
  chunkIndex?: number | null;
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
  usedBroadenedSearch: boolean;
  usedModelRerank: boolean;
  durationMs: number;
  quality: RetrievalQuality;
};

/** Returns indexes into `candidates`, most relevant first, or null to keep
 * the existing order. Indexes left out keep their order after the listed ones. */
export type RetrievalReranker = (input: {
  query: string;
  candidates: RetrievedDocumentSnippet[];
}) => Promise<number[] | null>;

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
  chunk_index?: number | null;
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

// Small parts keep each embedding focused on one requirement or passage.
// Retrieval returns the surrounding section, up to the former chunk size.
const MAX_CHUNK_CHARS = 1600;
const CHUNK_OVERLAP_CHARS = 200;
const SECTION_CONTEXT_MAX_CHARS = 4800;
const EMBEDDING_BATCH_SIZE = 32;
const VECTOR_MATCH_THRESHOLD = 0.15;
const HYBRID_RRF_K = 50;
const HYBRID_MATCH_MULTIPLIER = 4;
const MIN_RETRIEVAL_QUALITY_SCORE = 9;
const EMBEDDING_RETRY_DELAYS_MS = [500];
const EMBEDDING_REQUEST_TIMEOUT_MS = 12_000;
const EMBEDDING_OPERATION_TIMEOUT_MS = 30_000;
const EMBEDDING_RETRY_BACKOFF_MS = 15 * 60_000;
const CHUNK_REPLACEMENT_LOCK_RETRY_DELAYS_MS = [25, 75];
const QUERY_EMBEDDING_CACHE_LIMIT = 128;
const DOCUMENT_SOURCE_FINGERPRINT_VERSION = 1;

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
// Only a successful probe is cached: a missing-table error can be transient
// (for example while PostgREST reloads its schema cache).
let chunkStorageConfirmed = false;

function getEmbeddingClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  if (!cachedEmbeddingClient) {
    cachedEmbeddingClient = new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: EMBEDDING_REQUEST_TIMEOUT_MS,
    });
  }

  return cachedEmbeddingClient;
}

function sleep(ms: number) {
  const signal = getProjectWorkflowAbortSignal();
  signal?.throwIfAborted();

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(handle);
      reject(signal?.reason);
    };
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTransientEmbeddingError(error: unknown) {
  if (error instanceof EmbeddingRequestTimeoutError) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const status = "status" in error ? Number(error.status) : 0;
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return true;
  }
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  return /APIConnection|Timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(
    `${name} ${message}`,
  );
}

function embeddingFailureReason(error: unknown) {
  if (getProjectWorkflowAbortSignal()?.aborted) {
    return "workflow_abort";
  }
  if (error instanceof EmbeddingRequestTimeoutError) {
    return error.scope === "operation"
      ? "operation_timeout"
      : "request_timeout";
  }
  return isTransientEmbeddingError(error) ? "transient" : "permanent";
}

function embeddingErrorFields(error: unknown) {
  if (!error || typeof error !== "object") {
    return {};
  }
  const status = "status" in error ? Number(error.status) : 0;
  const code = "code" in error ? String(error.code) : "";
  return {
    error_name: "name" in error ? String(error.name) : "Error",
    ...(Number.isFinite(status) && status > 0 ? { status } : {}),
    ...(code ? { error_code: code.slice(0, 80) } : {}),
  };
}

export function assertEmbeddingFallbackAllowed(error: unknown) {
  rethrowAuthoritativeLeaseLoss(error);
  assertProjectWorkflowActive();
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

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, nestedValue]) => [key, canonicalJsonValue(nestedValue)]),
    );
  }
  return value;
}

export function documentChunkSourceFingerprint(document: ChunkableDocument) {
  return hashText(
    JSON.stringify(
      canonicalJsonValue({
        version: DOCUMENT_SOURCE_FINGERPRINT_VERSION,
        id: document.id,
        project_id: document.projectId ?? null,
        service_id: document.serviceId ?? null,
        role: document.role ?? null,
        supporting_subtype: document.supportingSubtype ?? null,
        title: document.title,
        file_name: document.fileName,
        file_format: document.fileFormat,
        raw_text: document.rawText,
        structure_map: normalizeDocumentChunkStructureMap(
          document.structureMap,
        ),
      }),
    ),
  );
}

export function projectDocumentChunkSourceFingerprint(
  document: ProjectDocumentDetail,
) {
  return documentChunkSourceFingerprint({
    id: document.id,
    projectId: document.project_id,
    role: document.role,
    supportingSubtype: document.supporting_subtype,
    title: document.title,
    fileName: document.file_name,
    fileFormat: document.file_format,
    rawText: document.raw_text,
    structureMap: document.structure_map,
  });
}

export function serviceDocumentChunkSourceFingerprint(
  document: ServiceDocumentDetail,
) {
  return documentChunkSourceFingerprint({
    id: document.id,
    serviceId: document.service_id,
    title: document.title,
    fileName: document.file_name,
    fileFormat: document.file_format,
    rawText: document.raw_text,
    structureMap: document.structure_map,
  });
}

export function projectDocumentExpectedChunkCount(
  document: ProjectDocumentDetail,
) {
  return buildSemanticDocumentChunks({
    id: document.id,
    projectId: document.project_id,
    role: document.role,
    supportingSubtype: document.supporting_subtype,
    title: document.title,
    fileName: document.file_name,
    fileFormat: document.file_format,
    rawText: document.raw_text,
    structureMap: document.structure_map,
  }).length;
}

export function serviceDocumentExpectedChunkCount(
  document: ServiceDocumentDetail,
) {
  return buildSemanticDocumentChunks({
    id: document.id,
    serviceId: document.service_id,
    title: document.title,
    fileName: document.file_name,
    fileFormat: document.file_format,
    rawText: document.raw_text,
    structureMap: document.structure_map,
  }).length;
}

export function documentChunkMetadataMatchesSourceFingerprint(
  metadata: unknown,
  expectedSourceFingerprint: string,
) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  return (
    (metadata as Record<string, unknown>).source_fingerprint ===
      expectedSourceFingerprint &&
    (metadata as Record<string, unknown>).source_fingerprint_version ===
      DOCUMENT_SOURCE_FINGERPRINT_VERSION
  );
}

export function withDocumentChunkSourceFingerprint(
  metadata: Record<string, unknown>,
  sourceFingerprint: string,
) {
  return {
    ...metadata,
    source_fingerprint: sourceFingerprint,
    source_fingerprint_version: DOCUMENT_SOURCE_FINGERPRINT_VERSION,
  };
}

function documentChunkSourceKey(
  sourceType: DocumentChunkSourceType,
  sourceId: string,
) {
  return `${sourceType}:${sourceId}`;
}

export function storedChunkMatchesCurrentSourceFingerprint(
  row: Pick<StoredChunkRow, "source_type" | "source_id" | "metadata">,
  expectedSourceFingerprints: ReadonlyMap<string, string>,
) {
  const expected = expectedSourceFingerprints.get(
    documentChunkSourceKey(row.source_type, row.source_id),
  );
  return (
    typeof expected === "string" &&
    documentChunkMetadataMatchesSourceFingerprint(row.metadata, expected)
  );
}

export function documentSourceKeysForMemoryFallback(
  requestedSourceKeys: readonly string[],
  storedCandidateCount: number,
  staleFilteredSourceKeys: ReadonlySet<string>,
) {
  return new Set(
    storedCandidateCount === 0
      ? requestedSourceKeys
      : requestedSourceKeys.filter((sourceKey) =>
          staleFilteredSourceKeys.has(sourceKey),
        ),
  );
}

const MAX_RETRIEVAL_LIMIT = 16;
const MODEL_RERANK_CANDIDATES = 32;

/** Occurrences of `needle` in `haystack` that stand as a whole value: not
 * preceded or followed by a letter or digit. */
function wholeValueOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = at > 0 ? haystack[at - 1]! : "";
    const after = haystack[at + needle.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) count += 1;
  }
  return count;
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

// Words that occur in nearly every tender passage or only phrase the question.
// In an OR query they would match almost every chunk and drown the ranking.
const KEYWORD_QUERY_STOP_WORDS = new Set([
  "hva", "hvem", "hvor", "hvordan", "hvilke", "hvilken", "hvilket", "hvorfor",
  "når", "sier", "står", "stå", "beskriv", "beskriver", "beskrevet", "fortell",
  "om", "og", "eller", "men", "på", "av", "fra", "til", "for", "med", "uten",
  "ved", "som", "der", "her", "det", "den", "de", "dem", "denne", "dette", "disse",
  "en", "ei", "et", "er", "var", "blir", "bli", "være", "har", "hadde", "kan",
  "skal", "vil", "må", "bør", "ikke", "at", "så", "seg", "sin", "sitt", "sine",
  "vi", "oss", "vår", "våre", "du", "deg", "dere", "jeg", "meg", "min", "mitt",
  "han", "hun", "alle", "andre", "noe", "noen", "også", "bare", "mer", "mest",
  "krav", "kravet", "kravene", "kravgrunnlaget", "krever", "kreves", "kreve",
  "gjelder", "inneholder", "kunden", "kundens",
  "leverandør", "leverandøren", "leverandørens", "dokument", "dokumentet",
  "the", "and", "or", "of", "to", "in", "is", "are", "what", "does", "about",
  "with", "from", "that", "this", "must", "shall", "requirement",
  "requirements",
]);
// Norwegian inflects by suffix. The index uses the 'simple' configuration,
// which keeps every inflected form as its own lexeme, so the query names the
// common forms of each word instead.
const NORWEGIAN_STRIPPED_SUFFIXES = ["ene", "ane", "ens", "ets", "er", "en", "et", "ar", "e", "a"];
const NORWEGIAN_INFLECTION_SUFFIXES = ["", "e", "en", "er", "et", "ene", "a", "ar", "ane", "s"];
const MAX_KEYWORD_QUERY_WORDS = 16;
const MAX_KEYWORD_QUERY_EXACT_TERMS = 12;

function norwegianInflections(word: string) {
  const suffix = word.length > 5
    ? NORWEGIAN_STRIPPED_SUFFIXES.find((candidate) => word.endsWith(candidate) && word.length - candidate.length >= 4)
    : undefined;
  // An uninflected word can end like a suffix ("sikkerhet", "ansvar"), so the
  // word itself is inflected as well as its stripped stem.
  const stems = suffix ? [word, word.slice(0, -suffix.length)] : [word];
  return stems.flatMap((stem) => NORWEGIAN_INFLECTION_SUFFIXES.map((ending) => `${stem}${ending}`));
}

/**
 * Builds the `websearch_to_tsquery` text for the keyword half of hybrid search.
 * A plain question would require every word to occur in one chunk, so the
 * keyword search matched almost nothing. Each term is a quoted alternative:
 * exact terms such as requirement IDs keep their punctuation as phrases, and
 * content words carry their common Norwegian inflections.
 */
export function buildKeywordSearchQuery(query: string, exactTerms: string[] = []) {
  const clean = (value: string) =>
    value
      .toLowerCase()
      .replace(/["\u0000]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .replace(/^[-.]+|[-.]+$/gu, "");
  const terms = new Set<string>();
  for (const term of exactTerms.slice(0, MAX_KEYWORD_QUERY_EXACT_TERMS)) {
    const cleaned = clean(term).slice(0, 80);
    if (cleaned && !KEYWORD_QUERY_STOP_WORDS.has(cleaned)) terms.add(cleaned);
  }
  const words = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}.\-]+/u)) {
    const word = clean(raw);
    if (words.size >= MAX_KEYWORD_QUERY_WORDS) break;
    if (!word || KEYWORD_QUERY_STOP_WORDS.has(word)) continue;
    if (/\p{N}/u.test(word) ? word.length >= 2 : word.length >= 3) words.add(word);
  }
  for (const word of words) {
    const inflections = /^\p{L}{4,}$/u.test(word) ? norwegianInflections(word) : [word];
    for (const inflection of inflections) terms.add(inflection);
  }
  return [...terms].map((term) => `"${term}"`).join(" or ");
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

function splitTextWithOverlap(normalized: string) {
  if (!normalized) {
    return [];
  }

  if (normalized.length <= MAX_CHUNK_CHARS) {
    return [{ text: normalized, start: 0 }];
  }

  const chunks: Array<{ text: string; start: number }> = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const preferredEnd = cursor + MAX_CHUNK_CHARS;
    const minimumEnd = Math.min(cursor + Math.floor(MAX_CHUNK_CHARS * 0.72), normalized.length);
    const end =
      preferredEnd >= normalized.length
        ? normalized.length
        : findSplitPoint(normalized, preferredEnd, minimumEnd);
    const slice = normalized.slice(cursor, end);
    const chunk = slice.trim();
    if (chunk) {
      chunks.push({ text: chunk, start: cursor + slice.indexOf(chunk) });
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

function structureEntryPageRange(
  entry: ProjectDocumentStructureEntry,
  reference: string,
  text: string,
) {
  const detected = pageRangeFrom(reference, text);
  if (detected.pageStart !== null || entry.page == null) {
    return detected;
  }
  return { pageStart: entry.page, pageEnd: entry.page };
}

function structureEntryChunkMetadata(entry: ProjectDocumentStructureEntry) {
  return {
    ...(entry.kind ? { structure_kind: entry.kind } : {}),
    ...(entry.parser ? { structure_parser: entry.parser } : {}),
    ...(entry.page != null ? { structure_page: entry.page } : {}),
    ...(entry.table_index != null
      ? { structure_table_index: entry.table_index }
      : {}),
    ...(entry.row_index != null
      ? { structure_row_index: entry.row_index }
      : {}),
    ...(entry.docling_ref ? { structure_docling_ref: entry.docling_ref } : {}),
    ...(entry.source_id ? { structure_source_id: entry.source_id } : {}),
    ...(entry.role ? { structure_role: entry.role } : {}),
    ...(entry.confidence != null
      ? { structure_confidence: entry.confidence }
      : {}),
    ...(entry.polygon?.length ? { structure_polygon: entry.polygon } : {}),
    ...(entry.heading_path?.length
      ? { structure_heading_path: entry.heading_path }
      : {}),
  };
}

function buildSemanticDocumentChunks(document: ChunkableDocument) {
  const structureMap = normalizeDocumentChunkStructureMap(
    document.structureMap,
  );
  const entries = structureMap.length
    ? structureMap
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
    const pageRange = structureEntryPageRange(
      entry,
      entry.reference,
      entryText,
    );
    const parts = splitTextWithOverlap(entryText);
    const sectionIndex = chunks.length;

    for (const [partIndex, { text: part, start }] of parts.entries()) {
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
          ...structureEntryChunkMetadata(entry),
        },
        sectionIndex,
        sectionReference: entry.reference,
        sectionText: entryText,
        sectionOffset: start,
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

export function shouldReuseChunksAfterCompletenessQueryError(error: unknown) {
  rethrowAuthoritativeLeaseLoss(error);
  return isChunkStorageUnavailable(
    error as { message?: string } | null | undefined,
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
  if (chunkStorageConfirmed) {
    return true;
  }

  const dataApi = createServiceClient();
  const { error } = await dataApi
    .from("document_chunks")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (error) {
    return !isChunkStorageUnavailable(error);
  }

  chunkStorageConfirmed = true;
  return true;
}

async function createEmbeddings(texts: string[]) {
  const client = getEmbeddingClient();
  if (!client || !texts.length) {
    return [];
  }

  const embeddings: number[][] = [];
  const operationStartedAt = Date.now();
  const operationDeadline =
    operationStartedAt + EMBEDDING_OPERATION_TIMEOUT_MS;

  for (let index = 0; index < texts.length; index += EMBEDDING_BATCH_SIZE) {
    assertProjectWorkflowActive();
    const batch = texts.slice(index, index + EMBEDDING_BATCH_SIZE);
    let response: Awaited<ReturnType<typeof client.embeddings.create>> | null = null;
    for (let attempt = 0; attempt <= EMBEDDING_RETRY_DELAYS_MS.length; attempt += 1) {
      const remainingOperationMs = operationDeadline - Date.now();
      if (remainingOperationMs <= 0) {
        throw new EmbeddingRequestTimeoutError(
          EMBEDDING_OPERATION_TIMEOUT_MS,
          "operation",
        );
      }
      const attemptTimeoutMs = Math.max(
        1,
        Math.min(EMBEDDING_REQUEST_TIMEOUT_MS, remainingOperationMs),
      );
      const attemptStartedAt = Date.now();
      try {
        assertProjectWorkflowActive();
        response = await runEmbeddingRequestWithDeadline({
          timeoutMs: attemptTimeoutMs,
          timeoutScope:
            attemptTimeoutMs < EMBEDDING_REQUEST_TIMEOUT_MS
              ? "operation"
              : "request",
          workflowSignal: getProjectWorkflowAbortSignal(),
          request: (signal) =>
            client.embeddings.create(
              {
                model: DOCUMENT_EMBEDDING_MODEL,
                input: batch,
                encoding_format: "float",
              },
              {
                maxRetries: 0,
                signal,
                timeout: attemptTimeoutMs,
              },
            ),
        });
        break;
      } catch (error) {
        assertProjectWorkflowActive();
        const transient = isTransientEmbeddingError(error);
        const retryDelayMs = EMBEDDING_RETRY_DELAYS_MS[attempt] ?? 0;
        const willRetry =
          transient &&
          attempt < EMBEDDING_RETRY_DELAYS_MS.length &&
          Date.now() + retryDelayMs < operationDeadline;
        console.warn(
          JSON.stringify({
            event: "embedding_request_failure",
            model: DOCUMENT_EMBEDDING_MODEL,
            batch_index: index / EMBEDDING_BATCH_SIZE,
            batch_size: batch.length,
            attempt: attempt + 1,
            reason: embeddingFailureReason(error),
            duration_ms: Date.now() - attemptStartedAt,
            will_retry: willRetry,
            ...embeddingErrorFields(error),
          }),
        );
        if (!willRetry) {
          throw error;
        }
        await sleep(retryDelayMs);
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

export function isDocumentChunkReplacementLockConflict(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code ?? "")
      : "";
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message ?? "")
      : String(error ?? "");
  return (
    code === "55P03" ||
    code === "40P01" ||
    /could not obtain lock|lock not available|deadlock detected/i.test(message)
  );
}

async function runDocumentChunkReplacementWithLockRetry<T>(
  operation: () => Promise<T>,
) {
  for (
    let attempt = 0;
    attempt <= CHUNK_REPLACEMENT_LOCK_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      return await operation();
    } catch (error) {
      rethrowAuthoritativeLeaseLoss(error);
      const retryDelay = CHUNK_REPLACEMENT_LOCK_RETRY_DELAYS_MS[attempt];
      if (
        retryDelay === undefined ||
        !isDocumentChunkReplacementLockConflict(error)
      ) {
        throw error;
      }
      await sleep(retryDelay);
    }
  }
  throw new Error("Chunk-erstatning avsluttet uten resultat.");
}

async function replaceDocumentChunkRowsAtomically(input: {
  sourceType: DocumentChunkSourceType;
  sourceId: string;
  sourceFingerprint: string;
  sourceRevision: number;
  rows: Array<Record<string, unknown>>;
}) {
  const dataApi = createServiceClient();
  const { data, error } = await dataApi.rpc("replace_document_chunks_atomic", {
    p_source_type: input.sourceType,
    p_source_id: input.sourceId,
    p_source_fingerprint: input.sourceFingerprint,
    p_expected_source_revision: input.sourceRevision,
    p_expected_chunk_count: input.rows.length,
    p_rows: input.rows,
  });

  if (error) {
    throw error;
  }

  if (Number(data) !== input.rows.length) {
    throw new Error(
      `Atomisk chunk-erstatning lagret ${String(data)} av ${input.rows.length} rader.`,
    );
  }
}

async function replaceDocumentChunks(input: {
  sourceType: DocumentChunkSourceType;
  sourceId: string;
  projectId?: string | null;
  serviceId?: string | null;
  sourceRevision: number;
  document: ChunkableDocument;
}) {
  if (!(await hasChunkStorage())) {
    return;
  }

  const chunks = buildSemanticDocumentChunks(input.document);
  const sourceFingerprint = documentChunkSourceFingerprint(input.document);

  let embeddings: number[][] = [];
  let embeddingFallback: {
    failedAtMs: number;
    reason: string;
    retryAfterMs: number;
  } | null = null;
  const embeddingStartedAt = Date.now();
  try {
    embeddings = await createEmbeddings(chunks.map((chunk) => chunk.text));
  } catch (error) {
    assertEmbeddingFallbackAllowed(error);
    const failedAtMs = Date.now();
    const reason = embeddingFailureReason(error);
    embeddingFallback = {
      failedAtMs,
      reason,
      retryAfterMs: failedAtMs + EMBEDDING_RETRY_BACKOFF_MS,
    };
    console.warn(
      JSON.stringify({
        event: "document_embedding_fallback",
        source_type: input.sourceType,
        source_id: input.sourceId,
        model: DOCUMENT_EMBEDDING_MODEL,
        chunk_count: chunks.length,
        reason,
        duration_ms: Date.now() - embeddingStartedAt,
        fallback: "lexical_chunks",
        retry_after: new Date(
          embeddingFallback.retryAfterMs,
        ).toISOString(),
        ...embeddingErrorFields(error),
      }),
    );
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
    metadata: embeddingFallback
      ? embeddingFallbackMetadata({
          metadata: withDocumentChunkSourceFingerprint(
            chunk.metadata,
            sourceFingerprint,
          ),
          reason: embeddingFallback.reason,
          failedAtMs: embeddingFallback.failedAtMs,
          retryAfterMs: embeddingFallback.retryAfterMs,
        })
      : withDocumentChunkSourceFingerprint(chunk.metadata, sourceFingerprint),
    embedding: embeddings[index] ?? null,
    embedding_model: embeddings[index] ? DOCUMENT_EMBEDDING_MODEL : null,
    embedding_created_at: embeddings[index] ? now : null,
    search_text: chunkSearchText(input.document, chunk),
  }));
  const rowsForPersistenceRetry = (error: unknown) => {
    const message = String(
      (error as { message?: string } | null | undefined)?.message ?? "",
    ).toLowerCase();
    if (!message.includes("embedding") && !message.includes("vector")) {
      return null;
    }

    const failedAtMs = Date.now();
    const retryAfterMs = failedAtMs + EMBEDDING_RETRY_BACKOFF_MS;
    return rows.map(({ embedding: _embedding, ...row }) => ({
      ...row,
      metadata: embeddingFallbackMetadata({
        metadata: row.metadata,
        reason: `embedding_persistence: ${message.slice(0, 240)}`,
        failedAtMs,
        retryAfterMs,
      }),
      embedding: null,
      embedding_model: null,
      embedding_created_at: null,
    }));
  };

  const lease = getProjectWorkflowLease();
  if (lease) {
    const fencedPayload = {
      source_type: input.sourceType,
      source_id: input.sourceId,
      source_fingerprint: sourceFingerprint,
      expected_source_revision: input.sourceRevision,
      expected_chunk_count: rows.length,
      rows,
    };
    const persistFencedRows = async (
      replacementRows: Array<Record<string, unknown>>,
    ) => {
      const result = await runLeaseFencedProjectMutation<{ count?: unknown }>(
        lease.projectId,
        "replace_document_chunks",
        {
          ...fencedPayload,
          rows: replacementRows,
        },
      );
      const insertedCount = result.fenced
        ? Number(result.data?.count)
        : Number.NaN;
      if (!result.fenced || insertedCount !== replacementRows.length) {
        throw new Error(
          `Lease-fencet chunk-erstatning lagret ${String(insertedCount)} av ${replacementRows.length} rader.`,
        );
      }
    };
    try {
      await runDocumentChunkReplacementWithLockRetry(() =>
        persistFencedRows(rows),
      );
    } catch (error) {
      rethrowAuthoritativeLeaseLoss(error);
      const retryRows = rowsForPersistenceRetry(error);
      if (!retryRows) {
        throw error;
      }
      await runDocumentChunkReplacementWithLockRetry(() =>
        persistFencedRows(retryRows),
      );
    }
    return;
  }

  try {
    await runDocumentChunkReplacementWithLockRetry(() =>
      replaceDocumentChunkRowsAtomically({
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceFingerprint,
        sourceRevision: input.sourceRevision,
        rows,
      }),
    );
  } catch (error) {
    rethrowAuthoritativeLeaseLoss(error);
    const message = String(
      (error as { message?: string } | null | undefined)?.message ?? "",
    ).toLowerCase();
    const requiredRpcMissing = message.includes(
      "replace_document_chunks_atomic",
    );
    if (
      isChunkStorageUnavailable(error as { message?: string }) &&
      !requiredRpcMissing
    ) {
      return;
    }
    const retryRows = rowsForPersistenceRetry(error);
    if (!retryRows) {
      throw error;
    }
    await runDocumentChunkReplacementWithLockRetry(() =>
      replaceDocumentChunkRowsAtomically({
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceFingerprint,
        sourceRevision: input.sourceRevision,
        rows: retryRows,
      }),
    );
  }
}

async function hasCompleteExistingDocumentChunks(input: {
  sourceType: DocumentChunkSourceType;
  sourceId: string;
  sourceFingerprint: string;
  sourceRevision: number;
  expectedChunkCount: number;
}) {
  if (!(await hasChunkStorage())) {
    return true;
  }

  const dataApi = createServiceClient();
  const { data, error } = await dataApi.rpc("document_chunks_are_complete", {
    p_source_type: input.sourceType,
    p_source_id: input.sourceId,
    p_source_fingerprint: input.sourceFingerprint,
    p_expected_source_revision: input.sourceRevision,
    p_expected_chunk_count: input.expectedChunkCount,
    p_embedding_model: getEmbeddingClient()
      ? DOCUMENT_EMBEDDING_MODEL
      : null,
    p_checked_at: new Date().toISOString(),
  });

  if (error) {
    if (
      String(error.message ?? "")
        .toLowerCase()
        .includes("document_chunks_are_complete")
    ) {
      return false;
    }
    return shouldReuseChunksAfterCompletenessQueryError(error);
  }

  return data === true;
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
  sourceRevision: number;
}) {
  await replaceDocumentChunks({
    sourceType: "project_document",
    sourceId: input.documentId,
    projectId: input.projectId,
    sourceRevision: input.sourceRevision,
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
      sourceFingerprint: projectDocumentChunkSourceFingerprint(input.document),
      sourceRevision: input.document.chunk_source_revision,
      expectedChunkCount: projectDocumentExpectedChunkCount(input.document),
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
    sourceRevision: input.document.chunk_source_revision,
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
  sourceRevision: number;
}) {
  await replaceDocumentChunks({
    sourceType: "service_document",
    sourceId: input.documentId,
    serviceId: input.serviceId,
    sourceRevision: input.sourceRevision,
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
      sourceFingerprint: serviceDocumentChunkSourceFingerprint(input.document),
      sourceRevision: input.document.chunk_source_revision,
      expectedChunkCount: serviceDocumentExpectedChunkCount(input.document),
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
    sourceRevision: input.document.chunk_source_revision,
  });
}

export async function deleteDocumentChunks(input: {
  sourceType: DocumentChunkSourceType;
  sourceId: string;
}) {
  if (!(await hasChunkStorage())) {
    return;
  }

  const dataApi = createServiceClient();
  const { error } = await dataApi
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
        chunkIndex: candidate.chunk.chunkIndex,
        similarity: null,
        lexicalScore: score,
        retrievalSource: "memory" as const,
        score,
      };
    })
    .filter((candidate) => candidate.score > 0);
}

async function storedVectorCandidates(input: {
  getEmbedding: () => Promise<number[] | null>;
  queryTokens: string[];
  exactTerms: string[];
  projectId?: string | null;
  sourceIds: string[];
  sourceFingerprints: ReadonlyMap<string, string>;
  staleFilteredSourceKeys: Set<string>;
  limit: number;
}) {
  if (!(await hasChunkStorage())) {
    return [];
  }

  const embedding = await input.getEmbedding();
  if (!embedding) {
    return [];
  }

  const dataApi = createServiceClient();
  const { data: matches, error: matchError } = await dataApi.rpc(
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
  const { data: rows, error: rowsError } = await dataApi
    .from("document_chunks")
    .select(
      "id, chunk_index, source_type, source_id, document_title, kind, reference, heading_path, page_start, page_end, text_encrypted, metadata",
    )
    .in("id", ids);

  if (rowsError) {
    if (isChunkStorageUnavailable(rowsError)) {
      return [];
    }
    throw new Error(rowsError.message);
  }

  return ((rows ?? []) as StoredChunkRow[])
    .filter((row) => {
      const current = storedChunkMatchesCurrentSourceFingerprint(
        row,
        input.sourceFingerprints,
      );
      if (!current) {
        input.staleFilteredSourceKeys.add(
          documentChunkSourceKey(row.source_type, row.source_id),
        );
      }
      return current;
    })
    .map((row) => {
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
        chunkIndex: row.chunk_index ?? null,
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
  getEmbedding: () => Promise<number[] | null>;
  queryTokens: string[];
  exactTerms: string[];
  projectId?: string | null;
  sourceIds: string[];
  sourceFingerprints: ReadonlyMap<string, string>;
  staleFilteredSourceKeys: Set<string>;
  limit: number;
}) {
  if (!(await hasChunkStorage())) {
    return [];
  }

  const embedding = await input.getEmbedding();
  if (!embedding) {
    return [];
  }

  const matchCount = Math.min(
    Math.max(input.limit * HYBRID_MATCH_MULTIPLIER, 12),
    64,
  );
  const dataApi = createServiceClient();
  const { data: matches, error: matchError } = await dataApi.rpc(
    "hybrid_match_document_chunks",
    {
      query_embedding: embedding,
      query_text: buildKeywordSearchQuery(input.query, input.exactTerms),
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
  const { data: rows, error: rowsError } = await dataApi
    .from("document_chunks")
    .select(
      "id, chunk_index, source_type, source_id, document_title, kind, reference, heading_path, page_start, page_end, text_encrypted, metadata",
    )
    .in("id", ids);

  if (rowsError) {
    if (isRetrievalStorageUnavailable(rowsError)) {
      return [];
    }
    throw new Error(rowsError.message);
  }

  return ((rows ?? []) as StoredChunkRow[])
    .filter((row) => {
      const current = storedChunkMatchesCurrentSourceFingerprint(
        row,
        input.sourceFingerprints,
      );
      if (!current) {
        input.staleFilteredSourceKeys.add(
          documentChunkSourceKey(row.source_type, row.source_id),
        );
      }
      return current;
    })
    .map((row) => {
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
        chunkIndex: row.chunk_index ?? null,
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
  const topScore = Math.max(0, ...snippets.map((snippet) => snippet.score));
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

/** The part of a section shown around a matched part: the whole section when
 * it fits, otherwise a window centred on the part, cut at whitespace. */
function sectionWindow(section: string, partStart: number, partEnd: number) {
  if (section.length <= SECTION_CONTEXT_MAX_CHARS) {
    return { start: 0, end: section.length };
  }
  const margin = Math.max(0, SECTION_CONTEXT_MAX_CHARS - (partEnd - partStart));
  let start = Math.max(0, partStart - Math.floor(margin / 2));
  let end = Math.min(section.length, start + Math.max(SECTION_CONTEXT_MAX_CHARS, partEnd - partStart));
  start = Math.max(0, Math.min(start, end - SECTION_CONTEXT_MAX_CHARS));
  if (start > 0) {
    const boundary = section.slice(start, partStart).search(/\s/u);
    start = boundary >= 0 ? start + boundary + 1 : partStart;
  }
  if (end < section.length) {
    const boundary = section.slice(partEnd, end).search(/\s\S*$/u);
    end = boundary >= 0 ? partEnd + boundary : partEnd;
  }
  return { start, end };
}

/**
 * Replaces each matched part with its surrounding section. The part is traced
 * to its section by rebuilding the source's chunks; a stored part whose text
 * differs from the rebuilt part at its index (for example a chunk stored with
 * an earlier chunk size) is returned as stored. A later part already inside an
 * earlier window is skipped, so one section is not sent twice; the next ranked
 * candidates fill its place up to `limit`.
 */
function withSurroundingSections(input: {
  snippets: RetrievedDocumentSnippet[];
  documents: ProjectDocumentDetail[];
  serviceDocuments: ServiceDocumentDetail[];
  limit: number;
  /** Rebuilt chunks per source, shared by the calls of one retrieval. */
  chunksBySource: Map<string, SemanticDocumentChunk[]>;
}) {
  const { chunksBySource } = input;
  const sourceChunks = (snippet: RetrievedDocumentSnippet) => {
    const key = documentChunkSourceKey(snippet.sourceType, snippet.sourceId);
    let chunks = chunksBySource.get(key);
    if (!chunks) {
      const project = snippet.sourceType === "project_document"
        ? input.documents.find((document) => document.id === snippet.sourceId)
        : undefined;
      const service = snippet.sourceType === "service_document"
        ? input.serviceDocuments.find((document) => document.id === snippet.sourceId)
        : undefined;
      chunks = project
        ? buildSemanticDocumentChunks({
            id: project.id, projectId: project.project_id, role: project.role,
            supportingSubtype: project.supporting_subtype, title: project.title,
            fileName: project.file_name, fileFormat: project.file_format,
            rawText: project.raw_text, structureMap: project.structure_map,
          })
        : service
          ? buildSemanticDocumentChunks({
              id: service.id, serviceId: service.service_id, title: service.title,
              fileName: service.file_name, fileFormat: service.file_format,
              rawText: service.raw_text, structureMap: service.structure_map,
            })
          : [];
      chunksBySource.set(key, chunks);
    }
    return chunks;
  };
  const windows: Array<{ key: string; section: number; start: number; end: number }> = [];
  const result: RetrievedDocumentSnippet[] = [];
  for (const snippet of input.snippets) {
    if (result.length >= input.limit) break;
    const chunk = snippet.chunkIndex == null ? undefined : sourceChunks(snippet)[snippet.chunkIndex];
    if (!chunk || chunk.text !== snippet.text) {
      result.push(snippet);
      continue;
    }
    const key = documentChunkSourceKey(snippet.sourceType, snippet.sourceId);
    const partEnd = chunk.sectionOffset + chunk.text.length;
    if (windows.some((window) =>
      window.key === key && window.section === chunk.sectionIndex &&
      window.start <= chunk.sectionOffset && partEnd <= window.end)) {
      continue;
    }
    const window = sectionWindow(chunk.sectionText, chunk.sectionOffset, partEnd);
    windows.push({ key, section: chunk.sectionIndex, ...window });
    const text = chunk.sectionText.slice(window.start, window.end);
    // A window wider than its part cites the section, not "del N".
    result.push({ ...snippet, text, reference: text === chunk.text ? snippet.reference : chunk.sectionReference });
  }
  return result;
}

export async function retrieveDocumentSnippetsWithMetadata(input: {
  query: string;
  projectId?: string | null;
  documents?: ProjectDocumentDetail[];
  serviceDocuments?: ServiceDocumentDetail[];
  exactTerms?: string[];
  limit?: number;
  /** Exact document text already sent in this prompt, keyed by project document ID. */
  promptDocumentText?: ReadonlyMap<string, string>;
  /** Searched as well when the first results are too weak. */
  broaderQuery?: string;
  /** Exact terms the broader search must cover; the first pass terms otherwise do not apply. */
  broaderExactTerms?: string[];
  /** Orders the best candidates by relevance; null keeps the heuristic order. */
  rerank?: RetrievalReranker;
  /**
   * Returns each matched part with up to 4 800 characters of its section. Only
   * for callers that send whole snippets: a caller that cuts snippets to their
   * first characters would lose the match, and the section can repeat text
   * already covered by `promptDocumentText`.
   */
  surroundingSections?: boolean;
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
        usedBroadenedSearch: false,
        usedModelRerank: false,
        durationMs: 0,
        quality,
      },
    };
  }

  const documents = input.documents ?? [];
  const serviceDocuments = input.serviceDocuments ?? [];
  const sourceIds = [...documents, ...serviceDocuments].map((document) => document.id);
  const sourceFingerprints = new Map<string, string>([
    ...documents.map(
      (document) =>
        [
          documentChunkSourceKey("project_document", document.id),
          projectDocumentChunkSourceFingerprint(document),
        ] as const,
    ),
    ...serviceDocuments.map(
      (document) =>
        [
          documentChunkSourceKey("service_document", document.id),
          serviceDocumentChunkSourceFingerprint(document),
        ] as const,
    ),
  ]);
  const queryTokens = tokenizeForRetrieval(query);
  const exactTerms = (input.exactTerms ?? []).filter(Boolean);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), MAX_RETRIEVAL_LIMIT);
  const comparable = (text: string) => normalizeChunkText(text).replace(/\s+/gu, " ");
  const coveredText = new Map([...input.promptDocumentText ?? []].map(([id, text]) =>
    [documentChunkSourceKey("project_document", id), comparable(text)],
  ));
  const sourceText = new Map(documents.map((document) =>
    [documentChunkSourceKey("project_document", document.id), comparable(document.raw_text)],
  ));
  const hasUncoveredText = (candidate: RetrievedDocumentSnippet) => {
    const key = documentChunkSourceKey(candidate.sourceType, candidate.sourceId);
    const covered = coveredText.get(key);
    if (!covered) return true;
    const text = comparable(candidate.text);
    // Covered only when the chunk's place in the source is unambiguous: it
    // occurs once there as a whole value ("30%" inside "130%" does not count),
    // and the prompt carries that occurrence. Keep a whole boundary chunk
    // when any of its evidence is outside the prompt.
    const source = sourceText.get(key);
    if (!source || wholeValueOccurrences(source, text) !== 1) return true;
    return wholeValueOccurrences(covered, text) === 0;
  };
  // Prompt-covered hits can fill a bounded stored search: search once more
  // with the widest bound when filtering left too few results.
  const withRefill = async (search: (bound: number) => Promise<RetrievedDocumentSnippet[]>) => {
    const first = await search(limit);
    const kept = first.filter(hasUncoveredText);
    if (kept.length >= limit || kept.length === first.length || limit >= MAX_RETRIEVAL_LIMIT) return kept;
    return (await search(MAX_RETRIEVAL_LIMIT)).filter(hasUncoveredText);
  };
  let usedHybridSearch = false;
  let usedVectorSearch = false;
  let usedMemoryFallback = false;
  const staleFilteredSourceKeys = new Set<string>();
  const gatherCandidates = async (pass: {
    query: string;
    queryTokens: string[];
    exactTerms: string[];
  }) => {
    let hybridCandidates: RetrievedDocumentSnippet[] = [];
    let vectorCandidates: RetrievedDocumentSnippet[] = [];
    let queryEmbeddingFailed = false;
    const getQueryEmbedding = createMemoizedEmbeddingRequest(async () => {
      try {
        return await createQueryEmbedding(pass.query);
      } catch (error) {
        queryEmbeddingFailed = true;
        throw error;
      }
    });

    try {
      hybridCandidates = await withRefill((bound) => storedHybridCandidates({
        query: pass.query,
        getEmbedding: getQueryEmbedding,
        queryTokens: pass.queryTokens,
        exactTerms: pass.exactTerms,
        projectId: input.projectId,
        sourceIds,
        sourceFingerprints,
        staleFilteredSourceKeys,
        limit: bound,
      }));
      usedHybridSearch ||= hybridCandidates.length > 0;
    } catch (error) {
      assertEmbeddingFallbackAllowed(error);
      hybridCandidates = [];
    }

    if (!hybridCandidates.length && !queryEmbeddingFailed) {
      try {
        vectorCandidates = await withRefill((bound) => storedVectorCandidates({
          getEmbedding: getQueryEmbedding,
          queryTokens: pass.queryTokens,
          exactTerms: pass.exactTerms,
          projectId: input.projectId,
          sourceIds,
          sourceFingerprints,
          staleFilteredSourceKeys,
          limit: bound,
        }));
        usedVectorSearch ||= vectorCandidates.length > 0;
      } catch (error) {
        assertEmbeddingFallbackAllowed(error);
        vectorCandidates = [];
      }
    }

    const memoryFallbackSourceKeys = documentSourceKeysForMemoryFallback(
      [...sourceFingerprints.keys()],
      hybridCandidates.length + vectorCandidates.length,
      staleFilteredSourceKeys,
    );
    const fallbackCandidates = memoryCandidates({
      queryTokens: pass.queryTokens,
      exactTerms: pass.exactTerms,
      documents: documents.filter(
        (document) =>
          memoryFallbackSourceKeys.has(
            documentChunkSourceKey("project_document", document.id),
          ),
      ),
      serviceDocuments: serviceDocuments.filter(
        (document) =>
          memoryFallbackSourceKeys.has(
            documentChunkSourceKey("service_document", document.id),
          ),
      ),
    }).filter(hasUncoveredText);
    usedMemoryFallback ||= fallbackCandidates.length > 0;
    return [...hybridCandidates, ...vectorCandidates, ...fallbackCandidates];
  };

  let candidates = await gatherCandidates({ query, queryTokens, exactTerms });
  let rankingQuery = query;
  let rankingTokens = queryTokens;
  let rankingExactTerms = exactTerms;
  let ranked = rerankSnippets({ candidates, queryTokens, exactTerms });
  // Quality is assessed on what is returned: section windows replace their
  // parts and skip parts already inside an earlier window.
  const chunksBySource = new Map<string, SemanticDocumentChunk[]>();
  const returned = (list: RetrievedDocumentSnippet[]) => input.surroundingSections
    ? withSurroundingSections({ snippets: list, documents, serviceDocuments, limit, chunksBySource })
    : list.slice(0, limit);
  let snippets = returned(ranked);
  let quality = assessRetrievalQuality({ snippets, exactTerms });

  // Weak results get one broader search before callers fall back to longer
  // raw document text. Both passes are ranked together.
  let usedBroadenedSearch = false;
  const broaderQuery = normalizeChunkText(input.broaderQuery ?? "");
  if (!quality.sufficient && broaderQuery && broaderQuery !== query) {
    const broaderTokens = tokenizeForRetrieval(broaderQuery);
    rankingQuery = `${query}\n${broaderQuery}`;
    rankingTokens = Array.from(new Set([...queryTokens, ...broaderTokens]));
    rankingExactTerms = (input.broaderExactTerms ?? []).filter(Boolean);
    candidates = [
      ...candidates,
      ...(await gatherCandidates({
        query: broaderQuery,
        queryTokens: broaderTokens,
        exactTerms: rankingExactTerms,
      })),
    ];
    ranked = rerankSnippets({
      candidates,
      queryTokens: rankingTokens,
      exactTerms: rankingExactTerms,
    });
    usedBroadenedSearch = true;
  }

  let usedModelRerank = false;
  if (input.rerank && ranked.length > 1) {
    const pool = ranked.slice(0, MODEL_RERANK_CANDIDATES);
    const order = Array.from(new Set(
      (await input.rerank({ query: rankingQuery, candidates: pool })) ?? [],
    )).filter((index) => Number.isInteger(index) && index >= 0 && index < pool.length);
    if (order.length) {
      const chosen = new Set(order);
      ranked = [
        ...order.map((index) => pool[index]),
        ...pool.filter((_, index) => !chosen.has(index)),
        ...ranked.slice(pool.length),
      ];
      usedModelRerank = true;
    }
  }

  if (usedBroadenedSearch || usedModelRerank) {
    snippets = returned(ranked);
    // The broader terms only add to the first pass terms: judged on them
    // alone, a broader search without IDs would cover "all" terms and mark
    // weak results sufficient.
    quality = assessRetrievalQuality({
      snippets,
      exactTerms: Array.from(new Set([...exactTerms, ...rankingExactTerms])),
    });
  }
  const telemetry = {
    query,
    exactTerms,
    limit,
    sourceCount: snippets.length,
    usedHybridSearch,
    usedVectorSearch,
    usedMemoryFallback,
    usedBroadenedSearch,
    usedModelRerank,
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
      usedBroadenedSearch,
      usedModelRerank,
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
