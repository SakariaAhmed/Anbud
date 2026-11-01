import "server-only";
import { createHash } from "node:crypto";
import type { ChatSourceReference } from "@/lib/types";

const canonical = (value: string) => value.replace(/[‐‑‒–—]/gu, "-").replace(/\u0000/gu, "").replace(/\s+/gu, " ").trim();

/** Return original characters, never a reconstructed quotation. */
export class SourceQuoteIndex {
  private projection?: { normalized: string; positions: number[] };
  constructor(private readonly source: string) {}
  find(excerpt: string): string | null {
    const source = this.source;
    if (!excerpt.trim()) return null;
    if (source.includes(excerpt)) return excerpt;
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
    const needle = canonical(excerpt);
    const at = normalized.indexOf(needle);
    if (at < 0) return null;
    return source.slice(positions[at], positions[at + needle.length - 1] + 1);
  }
}

export function evidenceIdentity(input: { sourceType: string; sourceId: string; revision: number; fingerprint: string; reference: string; text: string }) {
  return `E-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24)}`;
}

/** Validate the references the answer actually uses before persistence.
 * Membership proves a locator/quotation exists, not that an interpretation is
 * correct; groundedness remains a separate release evaluation. */
export function validateChatEvidence(answer: string, available: ChatSourceReference[]) {
  const indexes = [...answer.matchAll(/\[Kilde\s+(\d+)\]/giu)].map(match => Number(match[1]) - 1);
  if (indexes.some(index => index < 0 || index >= available.length || !available[index].evidence_id || !available[index].original_quote)) {
    throw new Error("Svaret har en kildehenvisning som ikke kan bekreftes. Prøv meldingen på nytt.");
  }
  for (const paragraph of answer.split(/\n\s*\n/u)) {
    const sources = [...paragraph.matchAll(/\[Kilde\s+(\d+)\]/giu)].map(match => available[Number(match[1]) - 1]);
    for (const quote of paragraph.matchAll(/«([^»]+)»/gu)) {
      if (!sources.some(source => source?.original_quote && canonical(source.original_quote).includes(canonical(quote[1])))) {
        throw new Error("Et sitat i svaret finnes ikke i den oppgitte kilden. Prøv meldingen på nytt.");
      }
    }
    const ids = [...paragraph.matchAll(/\b[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,5}(?:\.\d+)*(?:\.[a-z])?\b/gu)].map(match => match[0]);
    for (const id of ids) {
      if (!sources.some(source => source?.original_quote && new RegExp(`(^|[^\\p{L}\\p{N}.-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}.-])`, "u").test(canonical(source.original_quote)))) {
        throw new Error("En krav-ID i svaret kan ikke bekreftes i den oppgitte kilden. Prøv meldingen på nytt.");
      }
    }
  }
  return Array.from(new Set(indexes)).map(index => available[index]);
}
