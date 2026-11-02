import type { ChatSourceReference } from "@/lib/types";

const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("nb");

/** Recognized precision claims must come from source-derived locators. A
 * literal quote alone never proves a page, and a generated draft has none. */
export function unsupportedSourceLocators(text: string, sources: ChatSourceReference[]): string[] {
  const primary = sources.filter(source => source?.classification === "documented" && source.source_type !== "generated_artifact");
  const unsupported: string[] = [];
  for (const match of text.matchAll(/\b(?:side(?:ne|r)?|s\.)\s*(\d+)(?:\s*[-–—]\s*(\d+))?(?!\d)/giu)) {
    const from = Number(match[1]), to = Number(match[2] ?? match[1]);
    if (!(from > 0 && to >= from && primary.some(source => Number.isSafeInteger(source.page_start) && Number.isSafeInteger(source.page_end) && source.page_start! <= from && source.page_end! >= to))) unsupported.push(match[0]);
  }
  for (const match of text.matchAll(/\b(?:kapittel|avsnitt|seksjon|overskrift(?:en)?)\s+(?:[«“"]([^»”"\n]+)[»”"]|(\d+(?:\.\d+)*))(?!\d)/giu)) {
    const heading = normalized(match[1] ?? match[2]);
    if (!primary.some(source => source.heading_path.some(value => normalized(value) === heading || (!match[1] && normalized(value).startsWith(`${heading} `))))) unsupported.push(match[0]);
  }
  return [...new Set(unsupported)];
}

export function withholdSourceLocators(text: string, unsupported: string[]): string {
  return unsupported.reduce((result, locator) => result.replaceAll(locator, "[nøyaktig plassering ikke bekreftet]"), text);
}
