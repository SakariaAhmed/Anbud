import { isRecord } from "@/lib/unknown-values";
export type RequirementRegenerationSelection = { artifactId: string; artifactVersion: number; rows: Array<{ index: number; rowHash: string }> };
export function parseRequirementRegeneration(value: unknown): RequirementRegenerationSelection | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.artifactId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value.artifactId) || !Number.isSafeInteger(value.artifactVersion) || Number(value.artifactVersion) < 1 || !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 100) throw new Error("Velg mellom 1 og 100 krav fra en gjeldende kravbesvarelse.");
  const rows = value.rows.map((row: unknown) => {
    if (!isRecord(row) || !Number.isSafeInteger(row.index) || Number(row.index) < 0 || typeof row.rowHash !== "string" || !/^[a-f0-9]{64}$/u.test(row.rowHash)) throw new Error("Kravutvalget mangler en gyldig radidentitet. Last inn på nytt.");
    return { index: Number(row.index), rowHash: row.rowHash };
  }).sort((a, b) => a.index - b.index);
  if (new Set(rows.map(row => row.index)).size !== rows.length) throw new Error("Det samme kravet er valgt flere ganger.");
  return { artifactId: value.artifactId, artifactVersion: Number(value.artifactVersion), rows };
}
