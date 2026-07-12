import { splitMarkdownTableRow } from "@/lib/markdown-table-row";

function normalizedHeaderCell(value: string) {
  return value
    .toLowerCase()
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function requirementColumnIndex(line: string) {
  const cells = splitMarkdownTableRow(line).map(normalizedHeaderCell);
  const refIndex = cells.findIndex((cell) => cell.includes("kravref"));
  const requirementIndex = cells.findIndex((cell) => cell === "krav");
  const answerIndex = cells.findIndex((cell) => cell === "svar");
  const sourceIndex = cells.findIndex((cell) =>
    /^(?:kildegrunnlag|kilde|source|source reference)$/.test(cell),
  );

  return refIndex >= 0 &&
    requirementIndex >= 0 &&
    answerIndex >= 0 &&
    sourceIndex >= 0
    ? requirementIndex
    : -1;
}

function isMarkdownDivider(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
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
      !isMarkdownDivider(lines[index + 1] ?? "")
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
