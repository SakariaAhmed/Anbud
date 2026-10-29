import "server-only";

// Project rows and stored-document helpers shared by the project, document and
// service-description repositories.
import { decryptString } from "@/lib/server/crypto";
import { createServiceClient } from "@/lib/server/data-api";
import { buildStoredFilePrefix } from "@/lib/server/file-storage-azure";

export type Json =
  | Record<string, unknown>
  | Array<unknown>
  | string
  | number
  | boolean
  | null;

export interface ProjectRow {
  source_revision?: number;
  snapshot_revision?: number;
  id: string;
  name: string;
  customer_name: string | null;
  description: string | null;
  industry: string | null;
  context_keywords: string[];
  customer_document_uploaded: boolean;
  customer_analysis_generated: boolean;
  solution_document_uploaded: boolean;
  solution_evaluation_generated: boolean;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

export function fromUnknownProjectRow(row: Record<string, unknown>): ProjectRow {
  const createdAt = String(row.created_at ?? new Date().toISOString());
  const updatedAt = String(row.updated_at ?? createdAt);
  const lastActivityAt = String(row.last_activity_at ?? updatedAt ?? createdAt);

  return {
    id: String(row.id ?? ""),
    source_revision: row.source_revision == null ? undefined : Number(row.source_revision),
    snapshot_revision: row.snapshot_revision == null ? undefined : Number(row.snapshot_revision),
    name: String(row.name ?? row.title ?? "Nytt prosjekt"),
    customer_name:
      row.customer_name == null && row.client_name == null
        ? null
        : String(row.customer_name ?? row.client_name ?? ""),
    description: row.description == null ? null : String(row.description),
    industry: row.industry == null ? null : String(row.industry),
    context_keywords: Array.isArray(row.context_keywords)
      ? row.context_keywords.map(String)
      : [],
    customer_document_uploaded: Boolean(
      row.customer_document_uploaded ?? false,
    ),
    customer_analysis_generated: Boolean(
      row.customer_analysis_generated ?? false,
    ),
    solution_document_uploaded: Boolean(
      row.solution_document_uploaded ?? false,
    ),
    solution_evaluation_generated: Boolean(
      row.solution_evaluation_generated ?? false,
    ),
    last_activity_at: lastActivityAt,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function pageCountFromStructureMap(
  structureMap: unknown,
  fileFormat: string,
): number | null {
  if (fileFormat !== "pdf" || !Array.isArray(structureMap)) {
    return null;
  }

  const pageNumbers = structureMap
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const reference = String(
        (entry as { reference?: unknown }).reference ?? "",
      );
      const match = reference.match(/\bside\s+(\d{1,5})\b/i);
      return match ? Number(match[1]) : null;
    })
    .filter((value): value is number => Number.isFinite(value));

  return pageNumbers.length ? Math.max(...pageNumbers) : null;
}

export function pageCountFromRawText(rawText: string | undefined, fileFormat: string) {
  if (fileFormat !== "pdf" || !rawText) {
    return null;
  }

  const pageNumbers = [...rawText.matchAll(/\[\[SIDE:(\d{1,5})\]\]/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));

  return pageNumbers.length ? Math.max(...pageNumbers) : null;
}

export function decryptOptionalString(value: string | undefined) {
  if (!value) {
    return "";
  }

  try {
    return decryptString(value);
  } catch {
    return "";
  }
}

export function storedFileDeletionPrefixes(input: {
  scope: "projects" | "services";
  ownerId: string;
  fileId?: string | null;
  files: Array<{ file_storage_bucket?: string | null }>;
}) {
  const buckets = new Set<string | null>([null]);
  for (const file of input.files) {
    if (file.file_storage_bucket) buckets.add(file.file_storage_bucket);
  }
  const prefix = buildStoredFilePrefix(input);
  return [...buckets].map((bucket) => ({ bucket, prefix }));
}

export function keywordsFromText(value: string, limit = 64) {
  const stopWords = new Set([
    "eller",
    "ikke",
    "skal",
    "med",
    "som",
    "for",
    "til",
    "det",
    "den",
    "dette",
    "har",
    "kan",
    "ved",
    "fra",
    "over",
    "under",
    "innen",
    "kunden",
    "tjeneste",
    "tjenester",
    "beskrivelse",
  ]);
  const counts = new Map<string, number>();
  for (const word of value
    .toLowerCase()
    .replace(/[^a-zæøå0-9\s-]/gi, " ")
    .split(/\s+/)) {
    if (word.length < 4 || stopWords.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "nb"))
    .slice(0, limit)
    .map(([word]) => word);
}

export function mergeKeywords(...lists: Array<Array<string | null | undefined>>) {
  return Array.from(
    new Set(
      lists
        .flat()
        .filter((word): word is string => Boolean(word?.trim()))
        .map((word) => word.toLowerCase().trim()),
    ),
  ).slice(0, 96);
}

export async function queryProjectRow(projectId: string) {
  const dataApi = createServiceClient();
  const first = await dataApi
    .from("projects")
    // Projects contain metadata, not document or artifact bodies. Read the row
    // once so current title/client_name and alternate name/customer_name schemas
    // both work, including deployments containing both sets of columns.
    .select("*")
    .eq("id", projectId)
    .single<Record<string, unknown>>();

  if (!first.error && first.data) {
    return fromUnknownProjectRow(first.data);
  }

  throw new Error("Fant ikke prosjektet.");
}
