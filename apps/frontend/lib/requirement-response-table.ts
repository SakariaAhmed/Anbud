// The requirement response is stored as a Markdown table. The server writes
// these headings and both server and client locate columns with the same
// rules, so renaming a heading happens here only.
export const REQUIREMENT_RESPONSE_TABLE_HEADINGS = [
  "Kravref.",
  "Krav",
  "Svar",
  "Svargrunnlag",
  "Kildegrunnlag",
] as const;

function normalizedHeading(value: string) {
  return value
    .toLowerCase()
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Column positions in a requirement table header row; -1 marks a missing column. */
export function requirementResponseTableColumns(headerCells: readonly string[]) {
  const headings = headerCells.map(normalizedHeading);
  return {
    refIndex: headings.findIndex((heading) => heading.includes("kravref")),
    requirementIndex: headings.findIndex((heading) => heading === "krav"),
    answerIndex: headings.findIndex((heading) => heading === "svar"),
    evidenceIndex: headings.findIndex((heading) =>
      /^(?:svargrunnlag|answer evidence|evidence|bevis)$/.test(heading),
    ),
    sourceIndex: headings.findIndex(
      (heading) =>
        heading.includes("kildegrunnlag") ||
        /^(?:kilde|source|source reference)$/.test(heading),
    ),
  };
}
