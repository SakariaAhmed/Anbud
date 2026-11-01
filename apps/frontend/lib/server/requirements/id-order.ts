import { normalizeRequirementId } from "@/lib/server/requirements/normalization";

const idCollator = new Intl.Collator("nb", { numeric: true, sensitivity: "base" });

/** Place an addition within its numbering series without reordering source rows. */
export function requirementAdditionPosition<T extends { id: string }>(rows: readonly T[], id: string) {
  const normalized = normalizeRequirementId(id);
  const prefix = normalized.match(/^\D+/u)?.[0];
  const sameSeries = rows.flatMap((row, index) =>
    prefix && normalizeRequirementId(row.id).match(/^\D+/u)?.[0] === prefix
      ? [{ row, index }]
      : [],
  );
  const preceding = sameSeries.filter(({ row }) =>
    idCollator.compare(normalizeRequirementId(row.id), normalized) < 0,
  ).at(-1);
  return {
    index: preceding ? preceding.index + 1 : sameSeries[0]?.index ?? rows.length,
    anchor: preceding?.row ?? sameSeries[0]?.row,
  };
}
