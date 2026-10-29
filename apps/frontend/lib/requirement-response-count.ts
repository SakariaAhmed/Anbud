import { isMarkdownTableDivider, splitMarkdownTableRow } from "@/lib/markdown-table-row";
import { requirementResponseTableColumns } from "@/lib/requirement-response-table";

function requirementColumnIndex(line: string) {
  const columns = requirementResponseTableColumns(splitMarkdownTableRow(line));
  return columns.refIndex >= 0 &&
    columns.requirementIndex >= 0 &&
    columns.answerIndex >= 0 &&
    columns.sourceIndex >= 0
    ? columns.requirementIndex
    : -1;
}

export function requirementResponseRequirementCount(
  content: string,
  fallbackCount?: number,
) {
  const lines = content.split("\n");
  let renderedCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const requirementIndex = requirementColumnIndex(lines[index] ?? "");
    if (
      requirementIndex < 0 ||
      !isMarkdownTableDivider(lines[index + 1] ?? "")
    ) {
      continue;
    }

    index += 2;
    while (index < lines.length && /^\s*\|/.test(lines[index] ?? "")) {
      const cells = splitMarkdownTableRow(lines[index] ?? "");
      if ((cells[requirementIndex] ?? "").trim()) {
        renderedCount += 1;
      }
      index += 1;
    }
    index -= 1;
  }

  if (renderedCount > 0) {
    return renderedCount;
  }

  return typeof fallbackCount === "number" &&
    Number.isFinite(fallbackCount) &&
    fallbackCount >= 0
    ? Math.round(fallbackCount)
    : undefined;
}
