import "server-only";

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
