import { isRecord } from "@/lib/unknown-values";
import type { ProjectRequirementRegister } from "@/lib/types";

export function parseProjectRequirementRegister(value: unknown): ProjectRequirementRegister {
  if (!isRecord(value) || !Number.isSafeInteger(value.source_revision) || !Array.isArray(value.documents)) throw new Error("Kravregisteret har et ugyldig format.");
  const documents: ProjectRequirementRegister["documents"] = value.documents.map((document: unknown) => {
    if (!isRecord(document) || typeof document.id !== "string" || typeof document.title !== "string" || !Number.isSafeInteger(document.source_revision) ||
      typeof document.document_ready !== "boolean" || typeof document.register_available !== "boolean" || !Array.isArray(document.rows)) throw new Error("Kravregisteret har et ugyldig dokument.");
    const rows: ProjectRequirementRegister["documents"][number]["rows"] = document.rows.map((row: unknown) => {
      if (!isRecord(row) || typeof row.id !== "string" || typeof row.text !== "string" || typeof row.heading !== "string" || !Array.isArray(row.pages) ||
        row.pages.some(page => !Number.isSafeInteger(page) || Number(page) <= 0) || !["source", "inferred", "generated"].includes(String(row.id_origin))) throw new Error("En kravrad kunne ikke leses.");
      if (row.text_origin !== undefined && !["observed", "reconstructed", "unknown"].includes(String(row.text_origin))) throw new Error("Kravtekstens opprinnelse kunne ikke leses.");
      if (row.text_origin === "observed" && (typeof row.original_text !== "string" || !row.original_text.trim())) throw new Error("Kravtekstens kildeutdrag mangler.");
      return { id: row.id, text: row.text, heading: row.heading, pages: row.pages as number[], id_origin: row.id_origin as "source" | "inferred" | "generated", ...(typeof row.original_id === "string" ? { original_id: row.original_id } : {}),
        ...(row.text_origin !== undefined ? { text_origin: row.text_origin as "observed" | "reconstructed" | "unknown" } : {}),
        ...(row.text_origin === "observed" ? { original_text: String(row.original_text) } : {}) };
    });
    return { id: document.id, title: document.title, source_revision: Number(document.source_revision), document_ready: document.document_ready, register_available: document.register_available, rows };
  });
  return { source_revision: Number(value.source_revision), documents };
}
