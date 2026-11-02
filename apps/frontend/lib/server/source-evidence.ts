import "server-only";
import { createHash } from "node:crypto";
import type { ChatSourceReference } from "@/lib/types";
import { extractRequirementIdentifiers, isAmbiguousRequirementIdentifier } from "@/lib/server/ai/retrieval-query";

const quotationText = (value: string) => value.replace(/\*\*([^*]+)\*\*/gu, "$1").replace(/__([^_]+)__/gu, "$1");
export function quotedSourcePassages(value: string, includeOrdinaryQuotes = true): string[] {
  return [...value.matchAll(includeOrdinaryQuotes ? /«([^»]+)»|“([^”]+)”|"([^"\n]+)"/gu : /«([^»]+)»/gu)].map(match => match[1] ?? match[2] ?? match[3]);
}
const canonical = (value: string) => value.replace(/[‐‑‒–—]/gu, "-").replace(/\u0000/gu, "").replace(/\s+/gu, " ").trim();
export const sourceQuoteLength = (value: string) => canonical(quotationText(value)).length;
export const isMeaningfulShortSourceQuote = (value: string) => {
  const text = canonical(quotationText(value));
  return text.length > 0 && text.length < 12 && (/^\d/u.test(text) || text.length >= 4 && /\d/u.test(text));
};

export class SourceEvidenceValidationError extends Error {
  constructor(readonly code: "CHAT_SOURCE_REFERENCE_INVALID" | "CHAT_QUOTATION_INVALID" | "CHAT_REQUIREMENT_ID_INVALID", message: string) {
    super(message);
    this.name = "SourceEvidenceValidationError";
  }
}

/** Return original characters, never a reconstructed quotation. */
export class SourceQuoteIndex {
  private projection?: { normalized: string; positions: number[] };
  constructor(private readonly source: string) {}
  find(excerpt: string, options: { tokenBoundaries?: boolean; startAt?: number } = {}): string | null {
    return this.locate(excerpt, options)?.text ?? null;
  }
  locate(excerpt: string, options: { tokenBoundaries?: boolean; startAt?: number } = {}): { text: string; start: number; end: number } | null {
    const source = this.source;
    if (!excerpt.trim()) return null;
    const startAt = options.startAt ?? 0;
    const bounded = (start: number, end: number) => {
      if (!options.tokenBoundaries) return true;
      const before = source.slice(Math.max(0, start - 2), start), after = source.slice(end, end + 5);
      return !/[\p{L}\p{N}]$/u.test(before) && !/^[\p{L}\p{N}]/u.test(after)
        && !( /^\d/u.test(source.slice(start, end)) && /\d[.,]$/u.test(before))
        && !( /\d$/u.test(source.slice(start, end)) && /^[.,]\d/u.test(after))
        && !( /^\d{3}(?!\d)/u.test(source.slice(start, end)) && /\d[ \u00a0\u202f]$/u.test(before))
        && !( /\d$/u.test(source.slice(start, end)) && /^[ \u00a0\u202f]\d{3}(?!\d)/u.test(after));
    };
    const candidates = Array.from(new Set([excerpt, quotationText(excerpt)]));
    for (const candidate of candidates) {
      let at = source.indexOf(candidate, startAt);
      while (at >= 0) {
        if (bounded(at, at + candidate.length)) return { text: candidate, start: at, end: at + candidate.length };
        at = source.indexOf(candidate, at + 1);
      }
    }
    if (!this.projection) {
      const positions: number[] = [];
      const characters: string[] = [];
      for (let at = 0; at < source.length; at++) {
        const character = source[at];
        if (character === "\u0000") continue;
        const next = /\s/u.test(character) ? " " : /[‐‑‒–—]/u.test(character) ? "-" : character;
        if (next === " " && (!characters.length || characters.at(-1) === " ")) continue;
        characters.push(next);
        positions.push(at);
      }
      this.projection = { normalized: characters.join(""), positions };
    }
    const { normalized, positions } = this.projection;
    for (const candidate of candidates) {
      const needle = canonical(candidate);
      if (!needle) continue;
      let at = normalized.indexOf(needle);
      while (at >= 0) {
        const start = positions[at], end = positions[at + needle.length - 1] + 1;
        if (start >= startAt && bounded(start, end)) return { text: source.slice(start, end), start, end };
        at = normalized.indexOf(needle, at + 1);
      }
    }
    return null;
  }
}

/** Preserve actual characters and offsets; a short value needs a unique,
 * bounded occurrence with enough surrounding original context to verify it. */
export function locateSourceEvidenceQuote(source: string, quote: string, index = new SourceQuoteIndex(source)) {
  const short = sourceQuoteLength(quote) < 12;
  if (short && !isMeaningfulShortSourceQuote(quote)) return null;
  const match = index.locate(quote, { tokenBoundaries: true });
  if (!match || !short) return match;
  if (index.locate(quote, { tokenBoundaries: true, startAt: match.end })) return null;
  const lineEnd = source.indexOf("\n", match.end);
  const start = Math.max(source.lastIndexOf("\n", match.start) + 1, match.start - 120);
  const end = Math.min(lineEnd < 0 ? source.length : lineEnd, match.end + 120);
  const text = source.slice(start, end).trim();
  if (sourceQuoteLength(text) < 12) return null;
  const trimmedStart = start + source.slice(start, end).indexOf(text);
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
          excerpts.push(original.slice(Math.max(0, found.start - 160), Math.min(original.length, found.end + 160)));
        }
        if (!excerpts.length) {
          const terms = paragraph.match(/[\p{L}\p{N}]{5,}/gu) ?? [];
          const at = terms.map(term => original.toLocaleLowerCase("nb").indexOf(term.toLocaleLowerCase("nb"))).find(at => at >= 0) ?? 0;
          excerpts.push(original.slice(Math.max(0, at - 600), Math.min(original.length, at + 1800)));
        }
      }
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
