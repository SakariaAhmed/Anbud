import "server-only";
import { createHash } from "node:crypto";
import type { ChatSourceReference } from "@/lib/types";
import { unsupportedSourceLocators } from "@/lib/source-locators";
import { extractRequirementIdentifiers, isAmbiguousRequirementIdentifier } from "@/lib/server/ai/retrieval-query";

const quotationText = (value: string) => value.replace(/\*\*([^*]+)\*\*/gu, "$1").replace(/__([^_]+)__/gu, "$1");
export function quotedSourcePassages(value: string, includeOrdinaryQuotes = true): string[] {
  return [...value.matchAll(includeOrdinaryQuotes ? /«([^»]+)»|“([^”]+)”|"([^"\n]+)"/gu : /«([^»]+)»/gu)].map(match => match[1] ?? match[2] ?? match[3]);
}
const canonical = (value: string) => value.replace(/[‐‑‒–—]/gu, "-").replace(/\u0000/gu, "").replace(/\s+/gu, " ").trim();
export const sourceQuoteLength = (value: string) => canonical(quotationText(value)).length;
export const isMeaningfulShortSourceQuote = (value: string) => {
  const text = canonical(quotationText(value));
  return text.length > 0 && text.length < 12 && (/^[^\p{L}]*\d/u.test(text) || text.length >= 4 && /\d/u.test(text));
};

export class SourceEvidenceValidationError extends Error {
  constructor(readonly code: "CHAT_SOURCE_REFERENCE_INVALID" | "CHAT_QUOTATION_INVALID" | "CHAT_REQUIREMENT_ID_INVALID", message: string) {
    super(message);
    this.name = "SourceEvidenceValidationError";
  }
}

// These same boundaries validate quotations and produce excerpts. Spaces in
// a numeric group are Unicode space separators; a tab can separate table cells.
function sourceSpanBoundaries(source: string, start: number, end: number) {
  const before = source.slice(Math.max(0, start - 2), start), after = source.slice(end, end + 5);
  const text = source.slice(start, end);
  return [
    !/[\p{L}\p{N}]$/u.test(before)
      && !(/^\d/u.test(text) && /\d[.,]$/u.test(before))
      && !(/^\d{3}(?!\d)/u.test(text) && /\d\p{Zs}$/u.test(before)),
    !/^[\p{L}\p{N}]/u.test(after)
      && !(/\d$/u.test(text) && /^[.,]\d/u.test(after))
      && !(/\d$/u.test(text) && /^\p{Zs}\d{3}(?!\d)/u.test(after)),
  ];
}

/** Expand a character window to complete words and numeric values. The bound
 * matches the read endpoint, so saved evidence can be verified again there. */
export function sourceEvidenceExcerpt(source: string, from: number, to: number): string | null {
  let start = Math.max(0, from), end = Math.min(source.length, to);
  while (start < end && /\s/u.test(source[start])) start++;
  while (end > start && /\s/u.test(source[end - 1])) end--;
  if (start >= end || end - start > 8000) return null;
  for (;;) {
    const before = start, after = end;
    while (start > 0 && !sourceSpanBoundaries(source, start, end)[0]) { start--; if (end - start > 8000) return null; }
    while (end < source.length && !sourceSpanBoundaries(source, start, end)[1]) { end++; if (end - start > 8000) return null; }
    if (end - start > 8000) return null;
    if (before === start && after === end) break;
  }
  return source.slice(start, end);
}

/** Return original characters, never a reconstructed quotation. */
export class SourceQuoteIndex {
  private projection?: { normalized: string; positions: number[] };
  constructor(private readonly source: string) {}
  find(excerpt: string, options: { tokenBoundaries?: boolean; startAt?: number; normalized?: boolean } = {}): string | null {
    return this.locate(excerpt, options)?.text ?? null;
  }
  locate(excerpt: string, options: { tokenBoundaries?: boolean; startAt?: number; normalized?: boolean } = {}): { text: string; start: number; end: number } | null {
    const source = this.source;
    if (!excerpt.trim()) return null;
    const startAt = options.startAt ?? 0;
    const bounded = (start: number, end: number) => !options.tokenBoundaries || sourceSpanBoundaries(source, start, end).every(Boolean);
    const candidates = Array.from(new Set([excerpt, quotationText(excerpt)]));
    for (const candidate of options.normalized ? [] : candidates) {
      let at = source.indexOf(candidate, startAt);
      while (at >= 0) {
        if (bounded(at, at + candidate.length)) return { text: candidate, start: at, end: at + candidate.length };
        at = source.indexOf(candidate, at + 1);
      }
    }
    if (!this.projection) {
      const positions: number[] = [];
      const characters: string[] = [];
      const emphasis = new Set<number>();
      // Only balanced emphasis is typography. Keep original offsets and
      // characters in every returned span, including interior delimiters.
      for (const match of source.matchAll(/\*\*([^*]+)\*\*|__([^_]+)__/gu)) {
        for (const offset of [0, 1, match[0].length - 2, match[0].length - 1]) emphasis.add(match.index + offset);
      }
      for (let at = 0; at < source.length; at++) {
        const character = source[at];
        if (character === "\u0000" || emphasis.has(at)) continue;
        const next = /\s/u.test(character) ? " " : /[‐‑‒–—]/u.test(character) ? "-" : character;
        if (next === " " && (!characters.length || characters.at(-1) === " ")) continue;
        characters.push(next);
        positions.push(at);
      }
      this.projection = { normalized: characters.join(""), positions };
    }
    const { normalized, positions } = this.projection;
    let first: { text: string; start: number; end: number } | null = null;
    for (const candidate of candidates) {
      const needle = canonical(candidate);
      if (!needle) continue;
      let at = normalized.indexOf(needle);
      while (at >= 0) {
        const start = positions[at], end = positions[at + needle.length - 1] + 1;
        if (start >= startAt && bounded(start, end)) {
          if (!options.normalized) return { text: source.slice(start, end), start, end };
          if (!first || start < first.start) first = { text: source.slice(start, end), start, end };
          break;
        }
        at = normalized.indexOf(needle, at + 1);
      }
    }
    return first;
  }
}

/** Preserve actual characters and offsets; a short value needs a unique,
 * bounded occurrence with enough surrounding original context to verify it. */
export function locateSourceEvidenceQuote(source: string, quote: string, index = new SourceQuoteIndex(source)) {
  const short = sourceQuoteLength(quote) < 12;
  if (short && !isMeaningfulShortSourceQuote(quote)) return null;
  const match = index.locate(quote, { tokenBoundaries: true, normalized: short });
  if (!match || !short) return match;
  if (index.locate(quote, { tokenBoundaries: true, startAt: match.end, normalized: true })) return null;
  const lineEnd = source.indexOf("\n", match.end);
  const start = Math.max(source.lastIndexOf("\n", match.start) + 1, match.start - 120);
  const end = Math.min(lineEnd < 0 ? source.length : lineEnd, match.end + 120);
  const text = sourceEvidenceExcerpt(source, start, end);
  if (!text || sourceQuoteLength(text) < 12) return null;
  const trimmedStart = source.indexOf(text, Math.max(0, match.start - 8000));
  return { text, start: trimmedStart, end: trimmedStart + text.length };
}

export function evidenceIdentity(input: { sourceType: string; sourceId: string; revision: number; fingerprint: string; reference: string; text: string }) {
  return `E-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24)}`;
}

/** Validate the references the answer actually uses before persistence.
 * Membership proves a locator/quotation exists, not that an interpretation is
 * correct; groundedness remains a separate release evaluation. */
export function validateChatEvidence(answer: string, available: ChatSourceReference[], options: { userText?: string; authoritativeRequirementIds?: string[] } = {}) {
  const passages = new Map<number, string[]>();
  const registeredIds = new Set([...(options.authoritativeRequirementIds ?? []), ...available.flatMap(source => source?.source_type === "project_document" && source.requirement_id ? extractRequirementIdentifiers(source.requirement_id) : [])]);
  const registeredShapes = new Set([...registeredIds].map(id => id.replace(/\d+/gu, "#")));
  if ((answer.match(/\[Kilde/giu) ?? []).length !== [...answer.matchAll(/\[Kilde\s+(\d+)\]/giu)].length) throw new SourceEvidenceValidationError("CHAT_SOURCE_REFERENCE_INVALID", "Svaret har en ugyldig kildehenvisning.");
  const indexes = [...answer.matchAll(/\[Kilde\s+(\d+)\]/giu)].map(match => Number(match[1]) - 1);
  if (indexes.some(index => index < 0 || index >= available.length || !available[index].evidence_id || !canonical(available[index].original_quote ?? ""))) {
    throw new SourceEvidenceValidationError("CHAT_SOURCE_REFERENCE_INVALID", "Svaret har en kildehenvisning som ikke kan bekreftes. Prøv meldingen på nytt.");
  }
  for (const paragraph of answer.split(/\n\s*\n/u)) {
    const sources = [...paragraph.matchAll(/\[Kilde\s+(\d+)\]/giu)].map(match => available[Number(match[1]) - 1]);
    const invalidLocators = unsupportedSourceLocators(paragraph, sources);
    if (invalidLocators.some(locator => sources.length > 0 || !options.userText?.includes(locator))) {
      throw new SourceEvidenceValidationError("CHAT_SOURCE_REFERENCE_INVALID", "En side- eller kapittelhenvisning kan ikke bekreftes i den oppgitte kilden. Fjern den usikre plasseringen og behold bare dokumenterte opplysninger.");
    }
    // The prompt reserves «…» for source quotations. Ordinary quotation marks
    // without citations also support conversation such as Svar "Ja" eller "Nei".
    const quotes = quotedSourcePassages(paragraph, sources.length > 0);
    for (const quote of quotes) {
      // Repeating user-supplied wording is conversation, never document proof.
      // Cited quotations still require membership in the actual cited source.
      if (!sources.length && options.userText?.includes(quote)) continue;
      if (!sources.some(source => source?.original_quote && new SourceQuoteIndex(source.original_quote).find(quote, { tokenBoundaries: true }) !== null)) {
        throw new SourceEvidenceValidationError("CHAT_QUOTATION_INVALID", "Et sitat i svaret finnes ikke i den oppgitte kilden. Prøv meldingen på nytt.");
      }
    }
    const ids = extractRequirementIdentifiers(paragraph).filter(id => !isAmbiguousRequirementIdentifier(id) || registeredIds.has(id) || registeredShapes.has(id.replace(/\d+/gu, "#")));
    for (const id of ids) {
      if (!sources.some(source => source?.original_quote && extractRequirementIdentifiers(source.original_quote).includes(id))) {
        throw new SourceEvidenceValidationError("CHAT_REQUIREMENT_ID_INVALID", "En krav-ID i svaret kan ikke bekreftes i den oppgitte kilden. Prøv meldingen på nytt.");
      }
    }
    for (const match of paragraph.matchAll(/\[Kilde\s+(\d+)\]/giu)) {
      const index = Number(match[1]) - 1;
      const source = available[index];
      const original = source.original_quote!;
      const indexer = new SourceQuoteIndex(original);
      const needles = quotes.concat(ids);
      const excerpts = passages.get(index) ?? [];
      if (original.length <= 4800) excerpts.push(original);
      else {
        for (const needle of needles) {
          const found = indexer.locate(needle, { tokenBoundaries: true });
          if (!found) continue;
          const excerpt = sourceEvidenceExcerpt(original, found.start - 160, found.end + 160);
          if (excerpt) excerpts.push(excerpt);
        }
        if (!excerpts.length) {
          const terms = paragraph.match(/[\p{L}\p{N}]{5,}/gu) ?? [];
          const at = terms.map(term => original.toLocaleLowerCase("nb").indexOf(term.toLocaleLowerCase("nb"))).find(at => at >= 0) ?? 0;
          const excerpt = sourceEvidenceExcerpt(original, at - 600, at + 1800);
          if (excerpt) excerpts.push(excerpt);
        }
      }
      if (!excerpts.length) throw new SourceEvidenceValidationError("CHAT_SOURCE_REFERENCE_INVALID", "Kildeutdraget kunne ikke avgrenses sikkert. Presiser kilde eller krav-ID.");
      passages.set(index, Array.from(new Set(excerpts)));
    }
  }
  return Array.from(new Set(indexes)).map(index => {
    const excerpts = passages.get(index) ?? [];
    return { ...available[index], citation_number: index + 1, original_quote: excerpts[0],
      ...(excerpts.length > 1 ? { quotation_excerpts: excerpts } : {}),
    };
  });
}
