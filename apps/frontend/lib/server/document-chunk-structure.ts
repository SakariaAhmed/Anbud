import type { ProjectDocumentStructureEntry } from "@/lib/types";

const CHUNK_STRUCTURE_ENTRY_KINDS = new Set<
  NonNullable<ProjectDocumentStructureEntry["kind"]>
>([
  "text",
  "table",
  "docling_text",
  "docling_table_row",
  "docling_markdown",
]);

function normalizedStructureInteger(value: unknown, minimum: number) {
  if (
    value == null ||
    typeof value === "boolean" ||
    (typeof value === "string" && !value.trim())
  ) {
    return undefined;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : undefined;
}

function normalizedStructureString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

/**
 * Canonical structure-map contract for chunk construction and fingerprints.
 * It preserves source geometry and parser coordinates while discarding unknown
 * fields that cannot affect persisted chunks.
 */
export function normalizeDocumentChunkStructureMap(
  value: unknown,
): ProjectDocumentStructureEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map<ProjectDocumentStructureEntry | null>((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const reference = String(record.reference ?? "");
      const text = String(record.text ?? "");
      if (!reference && !text) {
        return null;
      }

      const kind = CHUNK_STRUCTURE_ENTRY_KINDS.has(
        record.kind as NonNullable<ProjectDocumentStructureEntry["kind"]>,
      )
        ? (record.kind as NonNullable<ProjectDocumentStructureEntry["kind"]>)
        : undefined;
      const parser = normalizedStructureString(record.parser);
      const page = normalizedStructureInteger(record.page, 1);
      const tableIndex = normalizedStructureInteger(record.table_index, 0);
      const rowIndex = normalizedStructureInteger(record.row_index, 0);
      const columns = Array.isArray(record.columns)
        ? record.columns.map((column) => String(column ?? ""))
        : undefined;
      const cells =
        record.cells &&
        typeof record.cells === "object" &&
        !Array.isArray(record.cells)
          ? Object.fromEntries(
              Object.entries(record.cells).map(([key, cell]) => [
                key,
                String(cell ?? ""),
              ]),
            )
          : undefined;
      const doclingRef = normalizedStructureString(record.docling_ref);

      return {
        reference,
        text,
        ...(kind ? { kind } : {}),
        ...(parser ? { parser } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(tableIndex !== undefined ? { table_index: tableIndex } : {}),
        ...(rowIndex !== undefined ? { row_index: rowIndex } : {}),
        ...(columns?.length ? { columns } : {}),
        ...(cells && Object.keys(cells).length ? { cells } : {}),
        ...(doclingRef ? { docling_ref: doclingRef } : {}),
      };
    })
    .filter(
      (entry): entry is ProjectDocumentStructureEntry => entry !== null,
    );
}
