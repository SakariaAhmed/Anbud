import "server-only";

import type { PostgrestClient } from "@/lib/server/postgrest-client";

export type ProjectDashboardCounts = {
  document_count: number;
  supporting_document_count: number;
  artifact_count: number;
};

const INVALID_COUNTS = "Kunne ikke lese gyldige prosjekttellinger.";

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function countValue(value: unknown): number {
  // PostgreSQL bigint values may be encoded as strings by an API adapter.
  const count = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(INVALID_COUNTS);
  return count;
}

export function parseProjectDashboardCounts(
  value: unknown,
  projectIds: readonly string[],
): Map<string, ProjectDashboardCounts> {
  const expected = new Set(projectIds);
  if (!Array.isArray(value) || expected.size !== projectIds.length) {
    throw new Error(INVALID_COUNTS);
  }
  const counts = new Map<string, ProjectDashboardCounts>();
  for (const item of value) {
    const row = objectRecord(item);
    if (!row || typeof row.project_id !== "string" || !expected.has(row.project_id) || counts.has(row.project_id)) {
      throw new Error(INVALID_COUNTS);
    }
    const documentCount = countValue(row.document_count);
    const supportingCount = countValue(row.supporting_document_count);
    if (supportingCount > documentCount) throw new Error(INVALID_COUNTS);
    counts.set(row.project_id, {
      document_count: documentCount,
      supporting_document_count: supportingCount,
      artifact_count: countValue(row.artifact_count),
    });
  }
  if (counts.size !== expected.size) throw new Error(INVALID_COUNTS);
  return counts;
}

export async function fetchProjectDashboardCounts(
  dataApi: Pick<PostgrestClient, "rpc">,
  projectIds: readonly string[],
): Promise<Map<string, ProjectDashboardCounts>> {
  if (!projectIds.length) return new Map();
  const { data, error } = await dataApi.rpc<unknown>("get_project_dashboard_counts", {
    p_project_ids: projectIds,
  });
  if (error) {
    throw new Error("Kunne ikke hente prosjekttellingene.", { cause: error });
  }
  return parseProjectDashboardCounts(data, projectIds);
}

export function parseProjectEvaluationCurrentness(
  value: unknown,
  projectIds: readonly string[],
): Record<string, boolean> {
  const row = objectRecord(value);
  const expected = new Set(projectIds);
  if (!row || Object.keys(row).length !== expected.size ||
    Object.entries(row).some(([id, current]) => !expected.has(id) || typeof current !== "boolean")) {
    throw new Error("Kunne ikke lese gyldig vurderingsstatus for prosjektene.");
  }
  return row as Record<string, boolean>;
}
