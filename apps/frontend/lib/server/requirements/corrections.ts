import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import { WorkflowPreconditionError } from "@/lib/server/workflow-errors";

// Tender documents often publish changes in a closing "Rettelser" chapter
// that takes precedence over the original requirement tables, which are left
// unchanged. Without applying it, withdrawn requirements were still answered
// and evaluated, changed requirements were judged on their old wording, and
// the correction rows themselves became requirements.

// Only a standalone chapter title naming tender corrections, optionally
// numbered and with a parenthetical ("9 Rettelser og presiseringer (Rettelse
// nr. 1 av 15.10.2026)"). "4.3 Rettelse av feil", contract-phase change
// chapters and wrapped table lines do not open a section.
const CORRECTIONS_HEADING =
  /^(?:(\d{1,2})(?:\.\d{1,2})*\.?\s+)?(?:Rettelser(?:\s+og\s+(?:presiseringer|tillegg|endringer))?|RETTELSER|Rettelse\s+nr\.?\s*\d+|Errata|Endringer\s+i\s+(?:konkurransegrunnlaget|kravspesifikasjonen|kravene|bilag\s*\d+))(?:\s*\([^)\n]{0,80}\))?\s*$/u;
const REQUIREMENT_ID = /\b[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4}(?:\.\d{1,3})?(?:\.[a-z])?\b/gu;
const REQUIREMENT_ID_SINGLE = /\b[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4}\b/u;
const QUOTED = /[«“"]([^«»“”"]{1,1500})[»”"]/gu;
const WITHDRAW_VERB =
  /\b(?:utgår|bortfaller|strykes|trekkes(?:\s+tilbake)?|er\s+utgått|slettes|frafalles|annulleres)\b|\b(?:fjernes|tas\s+ut)\s+(?:fra|av)\s+(?:kravspesifikasjonen|konkurransegrunnlaget|kravlisten|kravtabellen|tabell)\b/giu;
const CHANGE_VERB = /\b(?:endres|er\s+endret\s+til|erstattes(?!\s+av\s+(?:et\s+)?nytt)|ny\s+tekst|lyder\s+nå|skal\s+(?:nå\s+)?lyde)(?![\p{L}\p{N}])/giu;
// A sentence limiting where a requirement applies, with or without a modal.
const SCOPE_STATEMENT =
  /(?<![\p{L}\p{N}])(?:(?:gjelder|omfatter)\s+(?:kun|bare|ikke|også|heller\s+ikke)|(?:skal|må|vil)\s+(?:kun|bare|ikke|også)\s+(?:gjelde|omfatte))(?![\p{L}\p{N}])/iu;
// "må" and "bør" end in letters JavaScript's \b does not treat as word letters.
const OBLIGATION = /(?<![\p{L}\p{N}])(?:skal|må|bør)(?![\p{L}\p{N}])/iu;
const ADDED = /\b(?:nytt\s+krav|legges(?:\s+ikke)?\s+til|tilføyes)\b/iu;
const RENUMBERED = /\bny\s+(?:krav-?)?id\s*:?\s+([A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4})\b/iu;
const ANSWER = /^\s*svar\s*:/iu;
// An ID named as context rather than as the subject of the action.
const CONTEXT_BEFORE_ID =
  /(?:endringen\s+i|jf\.?|jfr\.?|i\s+henhold\s+til|se|som\s+følge\s+av(?:\s+at)?|nytt\s+krav|erstattes\s+av|i\s+stedet\s+for|kontrollene\s+i|som\s+i|dersom\s+vi\s+oppfyller)\s*$/iu;
// A withdrawal verb belongs to the subject right before it ("K-4 utgår",
// "Kravene K-4 og K-5 utgår", "Kravet utgår", a cell "Utgår"), not to a
// relative or subordinate clause ("Data som utgår av arkivet").
const WITHDRAW_BINDING_GAP = /^[\s,:;()–-]*(?:(?:og|samt|eller)\s+[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4}[\s,]*|\([^)]{0,40}\)\s*|(?:skal|må|vil)\s+)*$/iu;
// A paragraph, list item or table row starts a separate correction block.
// ID-led continuation lines remain in that block's bidder-request context.
const BLOCK_START = /\n(?=Rad \d+:)|\n\s*\n|\n(?=[ \t]*(?:[-•*–]|\d{1,2}[.)])\s)|\n(?=[ \t]*\|)/iu;
const ID_LINE_START = /\n(?=[ \t]*(?:(?:nytt\s+)?krav(?:et|ene)?\s+|for\s+)?[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4}\b)/iu;

/** A line without Markdown heading or bold markers: Docling writes
 * "## 9 Rettelser og presiseringer" and "**Vedlegg A**". */
function headingText(line: string) {
  return line
    .trim()
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^\*\*(.+)\*\*$/u, "$1")
    .trim();
}

function normalized(value: string) {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("nb");
}

/** Replaces quoted spans with placeholders, so old wording or IDs inside a
 * quote never decide which action applies to which requirement. */
function maskQuotes(text: string) {
  const quotes: string[] = [];
  const masked = text.replace(QUOTED, (_match, quote: string) => {
    quotes.push(quote.trim());
    return `«#${quotes.length - 1}»`;
  });
  return { masked, quotes };
}

/**
 * Every corrections section in document order ("Rettelse nr. 1", later
 * "Rettelse nr. 2"), each from its heading up to the next top-level
 * chapter, appendix or corrections heading. A table-of-contents entry ends
 * at the next chapter with no content of its own and is skipped.
 */
export function findCorrectionsSections(rawText: string) {
  const lines = rawText.split("\n");
  const sections: string[] = [];
  lines.forEach((line, start) => {
    const match = CORRECTIONS_HEADING.exec(headingText(line));
    if (!match) return;
    const chapter = match[1];
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      const next = headingText(lines[index]!);
      const topLevel = /^(\d{1,2})\s+[A-ZÆØÅ]/u.exec(next);
      if (
        /^vedlegg\s+[A-Z0-9]\b/iu.test(next) ||
        (topLevel && topLevel[1] !== chapter) ||
        CORRECTIONS_HEADING.test(next)
      ) {
        end = index;
        break;
      }
    }
    const body = lines.slice(start + 1, end).join("\n").trim();
    if (body.length > 0) sections.push(lines.slice(start, end).join("\n"));
  });
  return sections;
}

/** All corrections sections joined in order, or null without any. */
export function findCorrectionsSection(rawText: string) {
  const sections = findCorrectionsSections(rawText);
  return sections.length ? sections.join("\n\n") : null;
}

/** The document without its corrections chapters: source inventories are
 * counted from the original requirement text, then corrected. */
export function withoutCorrectionsSection(rawText: string) {
  return findCorrectionsSections(rawText).reduce((text, section) => text.replace(section, ""), rawText);
}

/** One statement per ID-led line within a structural correction block;
 * wrapped continuation lines stay with their statement. */
function statements(section: string) {
  return tableAwareLines(section.split("\n").slice(1))
    .join("\n")
    .split(BLOCK_START)
    .flatMap((block, scope) => block.split(ID_LINE_START).map((part) => ({
      scope,
      text: part
        .replace(/^\s*Rad \d+:\s*/u, "")
        .replace(/^\s*(?:[-•*–]|\d{1,2}[.)])\s+/u, "")
        .replace(/^\s*\|\s*|\s*\|\s*$/gu, "")
        .replace(/\s*\|\s*/gu, " | ")
        .replace(/\s+/gu, " ")
        .trim(),
    })))
    .filter(({ text }) => text.length > 0);
}

const TABLE_ROW = /^\s*(?:Rad \d+:\s*|\|)/u;
const QUESTION_COLUMN = /^(?:spørsmål|leverandørens\s+spørsmål|spørsmål\s+fra\s+(?:leverandør|tilbyder)(?:en)?|henvendelse)/iu;
const NEW_TEXT_COLUMN = /^(?:ny\s+tekst|ny\s+kravtekst|endret\s+tekst|ny\s+ordlyd)$/iu;
const OLD_TEXT_COLUMN = /^(?:opprinnelig\s+tekst|gammel\s+tekst|tidligere\s+tekst|opprinnelig\s+kravtekst)$/iu;

function tableCells(line: string) {
  return line
    .replace(/^\s*Rad \d+:\s*/u, "")
    .replace(/^\s*\|\s*|\s*\|\s*$/gu, "")
    .split(/\s*\|\s*/u)
    .map((cell) => cell.replace(/^\*\*(.*)\*\*$/u, "$1"));
}

/**
 * Rewrites correction-table rows by their header: a supplier-question
 * column is dropped (a bidder's request never acts), an old-text column is
 * dropped, and a new-text column becomes "Ny tekst: «…»".
 */
function tableAwareLines(lines: string[]) {
  let header: string[] | null = null;
  return lines.map((line) => {
    if (!TABLE_ROW.test(line)) {
      header = null;
      return line;
    }
    // A Markdown separator row ("|---|---|") carries no statement.
    if (/^\s*\|[\s:|-]+\|\s*$/u.test(line)) return "";
    const cells = tableCells(line);
    const isHeader =
      !REQUIREMENT_ID_SINGLE.test(line) &&
      cells.some((cell) => QUESTION_COLUMN.test(cell) || NEW_TEXT_COLUMN.test(cell) || OLD_TEXT_COLUMN.test(cell) || /^(?:nr\.?|gjelder|krav|endring)$/iu.test(cell));
    if (isHeader) {
      header = cells;
      return line;
    }
    if (!header) return line;
    const columns = header;
    const kept = cells.flatMap((cell, index) => {
      const label = columns[index] ?? "";
      if (QUESTION_COLUMN.test(label) || OLD_TEXT_COLUMN.test(label)) return [];
      if (NEW_TEXT_COLUMN.test(label) && cell.trim()) {
        // "Utgår" or "Kravet utgår." in the new-text column withdraws.
        if (/^(?:kravet\s+)?(?:utgår|bortfaller|strykes|frafalles|annulleres|slettes)\b/iu.test(cell.trim())) return [cell];
        if (/^(?:kravet\s+)?(?:fjernes|tas\s+ut)\s*\.?$/iu.test(cell.trim())) return ["Utgår"];
        return [/^[«“"]/u.test(cell.trim()) ? `Ny tekst: ${cell.trim()}` : `Ny tekst: «${cell.trim()}»`];
      }
      return [cell];
    });
    return `| ${kept.join(" | ")} |`;
  });
}

function idPrefix(id: string) {
  return id.replace(/-\d.*$/u, "");
}

/** Expands an ID range with a shared prefix ("K-4 til K-6") into all IDs. */
function expandIdRanges(text: string) {
  return text.replace(
    /\b([A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*)-(\d{1,4})\s+(?:til|–|-)\s+\1-(\d{1,4})\b/gu,
    (match, prefix: string, from: string, to: string) => {
      const start = Number(from);
      const end = Number(to);
      if (!(end > start && end - start <= 50)) return match;
      const width = from.length;
      return Array.from({ length: end - start + 1 }, (_, index) => `${prefix}-${String(start + index).padStart(width, "0")}`).join(", ");
    },
  );
}

/** Sentences of a masked statement, each with its IDs and their positions. */
function sentences(masked: string) {
  // Sentences, table cells and contrasting clauses ("K-1 beholdes, mens K-2
  // utgår") each carry their own subjects; a list ("K-4, K-6 og K-7") stays.
  return masked
    .split(/(?<=[.!?])\s+(?=[A-ZÆØÅ«])|\s+\|\s+|,\s*(?=(?:men|mens|samtidig\s+som|derimot)\b)|;\s*/u)
    .map((text) => ({
      text,
      ids: [...text.matchAll(REQUIREMENT_ID)].map((match) => ({ id: match[0], at: match.index! })),
    }));
}

/** Whether the verb at `at` is negated ("utgår ikke", "skal ikke tas ut",
 * "utgår heller ikke", "utgår likevel ikke"). */
function negatedAt(text: string, at: number, length: number) {
  const before = text.slice(Math.max(0, at - 25), at);
  const after = text.slice(at + length, at + length + 25);
  return /\b(?:ikke|aldri)\s+(?:\w+\s+)?$/iu.test(before) || /^\s+(?:(?:heller|likevel|lenger)\s+)?(?:ikke|aldri)\b/iu.test(after);
}

/** Known IDs a verb applies to: the subjects named in its sentence, not IDs
 * mentioned as context ("som følge av endringen i K-3 utgår K-7"). */
function subjects(sentence: { text: string; ids: Array<{ id: string; at: number }> }, known: Set<string>) {
  return sentence.ids
    .filter(({ id, at }) => known.has(id) && !CONTEXT_BEFORE_ID.test(sentence.text.slice(Math.max(0, at - 30), at)))
    .map(({ id }) => id);
}

/**
 * The requirement text after a wording change, or null when the change
 * cannot be placed. A quote reads as the whole new requirement when it
 * states an obligation or is most of the old text; otherwise it replaces
 * only the quoted old phrase ("«fem virkedager» til «tre virkedager»").
 */
function correctedWording(original: string, quote: string, replaced: string | undefined) {
  const old = normalized(original);
  const obligation = (text: string) => OBLIGATION.test(text);
  if (replaced) {
    if (normalized(replaced) === old) return quote;
    const at = original.toLocaleLowerCase("nb").indexOf(replaced.trim().toLocaleLowerCase("nb"));
    if (at >= 0) return `${original.slice(0, at)}${quote}${original.slice(at + replaced.trim().length)}`;
    // Whole old and new sentences that differ from the parsed text only in
    // layout (hyphenation, spacing) still replace the requirement.
    return obligation(replaced) && obligation(quote) ? quote : null;
  }
  // Without an obligation, a long replacement must read as a sentence
  // restating the requirement, not a value ("99,9 % målt per
  // kalendermåned.") or a clarification ("Gjelder kun produksjonsmiljøet.").
  const sentence = /^[A-ZÆØÅ]/u.test(quote.trim()) && /[.!]$/u.test(quote.trim());
  const words = (text: string) => new Set(normalized(text).match(/\p{L}{4,}/gu) ?? []);
  const oldWords = words(original);
  const newWords = [...words(quote)];
  const restates = newWords.length > 0 && newWords.filter((word) => oldWords.has(word)).length >= newWords.length / 2;
  // A scope statement ("Kryptert lagring gjelder kun produksjonsmiljøet.",
  // "Kravet skal kun gjelde …") qualifies the requirement; replacing it
  // would drop the obligation. New wording applies when a sentence that is
  // not a scope statement carries the obligation.
  const parts = quote.split(/(?<=[.!])\s+(?=[A-ZÆØÅ])/u);
  const obliges = parts.some((part) => obligation(part) && !SCOPE_STATEMENT.test(part));
  if (!old || obliges) return quote;
  if (parts.some((part) => SCOPE_STATEMENT.test(part)) || obligation(original)) return null;
  return sentence && restates && normalized(quote).length >= old.length * 0.6 ? quote : null;
}

// Stems shared by most tender sentences; they say nothing about continuity.
const GENERIC_STEMS = new Set(["lever", "løsni", "kunde", "tilbu", "oppdr", "krave", "kravs", "tjene", "gjeld"]);

/** Unquoted new wording: the first sentence, and each following one that
 * continues it (a back-reference such as "Rapporten …"/"Kravet …"/"Dette …",
 * or a specific word stem of the wording so far), up to an explicit
 * rationale ("Bakgrunnen er …"). Null when a following sentence is neither
 * ("Responstiden er maksimalt 30 minutter.", "Svarfristen forlenges …"):
 * an incomplete rewrite would silently drop a condition. */
function unquotedWording(text: string) {
  const parts = text.trim().split(/(?<=[.!])\s+(?=[A-ZÆØÅ])/u);
  const stems = (value: string) =>
    (normalized(value).match(/\p{L}{5,}/gu) ?? []).map((word) => word.slice(0, 5)).filter((stem) => !GENERIC_STEMS.has(stem));
  let kept = 1;
  while (kept < parts.length) {
    const part = parts[kept]!;
    if (/^(?:bakgrunn(?:en)?|begrunnelse(?:n)?|årsak(?:en)?|grunnen|hensikten|formålet|endringen|rettelsen|(?:dette|kravet|kravteksten)\s+(?:skyldes|(?:er|ble)\s+(?:gjort|endret|justert|presisert|oppdatert|korrigert|omformulert))|det\s+vises\s+til|jf\.)(?![\p{L}\p{N}])/iu.test(part)) break;
    // A substring match, so "Rapporten" continues "driftsrapport".
    const wording = normalized(parts.slice(0, kept).join(" "));
    const continues =
      /^(?:den|denne|dette|disse|kravet)(?![\p{L}\p{N}])/iu.test(part) ||
      stems(part).some((stem) => wording.includes(stem));
    if (!continues) return null;
    kept += 1;
  }
  return {
    wording: `${parts.slice(0, kept).join(" ").replace(/[.\s]+$/u, "")}.`,
    rest: parts.slice(kept).join(" "),
  };
}

export type RequirementCorrectionReport = {
  changed: string[];
  withdrawn: string[];
  added: string[];
  renumbered: string[];
  clarified: string[];
};

/**
 * Applies a corrections chapter to a document's requirement ledger. Actions
 * are read per sentence with quoted text masked, applied only when
 * affirmative and bound to a requirement in the ledger (or, for new
 * requirements, carrying the new wording); negated or unbound statements
 * are attached to the requirement as notes. Original wording is kept in the
 * source excerpt for audit.
 */
export function applyRequirementCorrections(
  ledger: RequirementLedgerEntry[],
  rawText: string,
  options: { removeCorrectionRows?: boolean } = {},
): { ledger: RequirementLedgerEntry[]; originalLedger: RequirementLedgerEntry[]; report: RequirementCorrectionReport } {
  const report: RequirementCorrectionReport = { changed: [], withdrawn: [], added: [], renumbered: [], clarified: [] };
  const section = findCorrectionsSection(rawText);
  if (!section) return { ledger, originalLedger: ledger, report };

  // Rows extracted from the chapter itself (the change rows, bidder
  // questions, a "K-1 får ny ID" fragment) are not requirements; they are
  // set aside before any action, so they are never its target. They are
  // found outside quoted text, so an original requirement whose old wording
  // a correction quotes is never mistaken for one.
  // Compared with a uniform placeholder: quote numbering differs between
  // the section and a row extracted from it.
  const unquoted = (text: string) => normalized(maskQuotes(text).masked.replace(/«#\d+»/gu, "«»"));
  const maskedSection = unquoted(section);
  // Text that also occurs outside the chapter is an original requirement,
  // even when an "Opprinnelig tekst" column repeats it unquoted.
  const outsideSection = normalized(withoutCorrectionsSection(rawText));
  const isCorrectionRow = (entry: RequirementLedgerEntry) => {
    const plain = normalized(entry.text);
    if (plain.length >= 12 && outsideSection.includes(plain)) return false;
    const text = unquoted(entry.text);
    if (text.length >= 12) return maskedSection.includes(text);
    // A fragment such as ": «…»" or "." left from a correction line.
    if (/«#?\d*»/u.test(text) && plain.length >= 12) return normalized(section).includes(plain);
    return (
      text.length > 0 &&
      maskedSection.includes(entry.id.toLocaleLowerCase("nb")) &&
      ledger.filter((other) => other.id === entry.id).length > 1
    );
  };
  let entries =
    options.removeCorrectionRows === false ? ledger : ledger.filter((entry) => !isCorrectionRow(entry));
  const originalLedger = entries;
  const known = () => new Set(entries.map((entry) => entry.id));
  const sourceIds = new Set(entries.map((entry) => entry.id));
  const note = (id: string, label: string, statement: string) => {
    entries = entries.map((entry) =>
      entry.id === id
        ? { ...entry, sourceExcerpt: [entry.sourceExcerpt, `${label}: ${statement}`].filter(Boolean).join(" | ") }
        : entry,
    );
  };
  const assertUniqueTargets = (ids: string[]) => {
    const ambiguous = [...new Set(ids)].filter((id) => entries.filter((entry) => entry.id === id).length > 1);
    if (ambiguous.length) {
      // An ID-only inventory cannot distinguish two rows with the same ID,
      // even when a parenthetical qualifier names just one obligation. Stop
      // both extraction and completeness validation before either drops rows.
      throw new WorkflowPreconditionError(
        `Kravrettelsen kan ikke brukes entydig: ${ambiguous.join(", ")} brukes av flere krav. Avklar hvilke krav rettelsen gjelder, og last opp et kravgrunnlag med entydige krav-ID-er.`,
      );
    }
  };
  const withdraw = (ids: string[]) => {
    assertUniqueTargets(ids);
    const targets = new Set(ids);
    entries = entries.filter((entry) => !targets.has(entry.id));
    report.withdrawn.push(...targets);
  };
  let applied = 0;
  // Unapplied statements that name an action (a change the code could not
  // place safely): kept as notes even when nothing else applies.
  const pendingNotes: Array<{ id: string; statement: string }> = [];

  let requestScope: number | undefined;
  for (const { text: statement, scope } of statements(section)) {
    // "Ny tekst: Leverandøren skal …" without quotation marks: the rest of the
    // cell is the new wording.
    const quotedStatement = statement.replace(
      /\b((?:ny\s+tekst|skal\s+(?:nå\s+)?lyde)\s*:?\s*)(?![«“"])([^|«»“”"]{12,1500}?)(\s*(?:\||$))/giu,
      (_match, lead: string, text: string, tail: string) => {
        const segmented = unquotedWording(text);
        // Where the wording ends is unclear: no rewrite, the statement stays
        // a note on the unchanged requirement.
        if (!segmented) return `${lead}${text}${tail}`;
        const { wording, rest } = segmented;
        return `${lead}«${wording}»${rest ? ` ${rest}` : ""}${tail}`;
      },
    );
    const { masked: maskedRaw, quotes } = maskQuotes(quotedStatement);
    const masked = expandIdRanges(maskedRaw);
    if (ANSWER.test(masked)) {
      requestScope = undefined;
      // Answers to bidder questions clarify, they do not rewrite requirements.
      for (const { id } of sentences(masked).flatMap((sentence) => sentence.ids)) {
        if (known().has(id)) {
          note(id, "Presisering i rettelse", statement);
          report.clarified.push(id);
        }
      }
      continue;
    }

    const statementIds = sentences(masked).flatMap((sentence) => sentence.ids.map(({ id }) => id));
    let context: string[] | undefined;
    let acted = false;
    // Requirements this statement already noted (an unplaced change).
    const noted = new Set<string>();
    // A bidder question ("Kan K-4 strykes …?") asks; it never acts.
    // A request ("Vi ber om at K-1 strykes") is not a correction either.
    const isQuestion = (text: string) =>
      /\?\s*$/u.test(text.trim()) ||
      /^\s*spørsmål\b/iu.test(text) ||
      /(?<![\p{L}\p{N}])(?:vi\s+ber\s+om|ber\s+om\s+at|ønsker\s+(?:at|å)|foreslår\s+at|anmoder\s+om)(?![\p{L}\p{N}])/iu.test(text);
    const affirmative = [];
    for (const sentence of sentences(masked)) {
      if (isQuestion(sentence.text)) requestScope = scope;
      // "Vi ber om følgende endring. K-4 utgår." is one request, including
      // an ID-led continuation on the next line. Earlier corrections in the
      // block still apply; later independent blocks start with fresh context.
      if (requestScope === scope) {
        // A closing question ends the request before a later affirmative
        // correction ("Kan K-4 strykes? K-7 utgår.").
        if (/\?\s*$/u.test(sentence.text.trim())) requestScope = undefined;
        continue;
      }
      affirmative.push(sentence);
      const ids = subjects(sentence, known());
      // A sentence naming no requirement ("Kravene utgår.", "Ny tekst: …")
      // refers back to all requirements named before it in the statement.
      const own = ids.length ? ids : context ?? [];
      if (ids.length) context = ids;

      // "K-6 utgår og erstattes av: «…»" replaces the wording: a change.
      // An unknown ID after "erstattes av" is a new requirement, not new
      // wording; a row number ("R-1") elsewhere does not count.
      const replacement = /\berstattes\s+av\s*:?\s*«#\d+»/u.exec(sentence.text);
      const replacesWording =
        replacement !== null &&
        ![...sentence.text.slice(replacement.index).matchAll(REQUIREMENT_ID)].some((match) => !sourceIds.has(match[0]));
      for (const verb of replacesWording ? [] : sentence.text.matchAll(WITHDRAW_VERB)) {
        if (negatedAt(sentence.text, verb.index!, verb[0].length)) continue;
        // Bound to the subject right before the verb, or opening the cell.
        const before = sentence.text.slice(0, verb.index!);
        const lastId = [...before.matchAll(REQUIREMENT_ID)].at(-1);
        const gap = lastId ? before.slice(lastId.index! + lastId[0].length) : before;
        const bound =
          (lastId && WITHDRAW_BINDING_GAP.test(gap)) ||
          // "For K-5 gjelder følgende: Kravet utgår."
          (lastId && /[:;]\s*(?:kravet|kravene)\s*$/iu.test(gap)) ||
          /^\s*(?:kravet|kravene)?\s*(?:\([^)]{0,40}\)\s*)?$/iu.test(lastId ? gap : before);
        // Subjects right after the verb ("... utgår K-7", "utgår også K-7 og K-8").
        const following = /^\s*(?:også\s+|dermed\s+)?((?:[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4}(?:\s*,\s*|\s+og\s+)?)+)/u
          .exec(sentence.text.slice(verb.index! + verb[0].length))?.[1];
        const after = [...(following ?? "").matchAll(REQUIREMENT_ID)].map((match) => match[0]).filter((id) => own.includes(id));
        if (after.length && !(lastId && own.includes(lastId[0]) && WITHDRAW_BINDING_GAP.test(gap))) {
          withdraw(after);
          acted = true;
          continue;
        }
        // Bound to a context ID ("som følge av at K-3 utgår"): no subject.
        if (!bound || (lastId && !own.includes(lastId[0]))) continue;
        // Only the subject list right before the verb ("K-4, K-6 og K-7"),
        // not a subject of an earlier predicate ("K-1 beholdes og K-2 utgår").
        const listIds: string[] = [];
        if (lastId) {
          const before = [...sentence.text.slice(0, verb.index!).matchAll(REQUIREMENT_ID)];
          for (let index = before.length - 1; index >= 0; index -= 1) {
            const match = before[index]!;
            const end = index === before.length - 1 ? verb.index! : before[index + 1]!.index!;
            const between = sentence.text.slice(match.index! + match[0].length, end);
            if (index < before.length - 1 && !/^\s*(?:,|og|samt|eller)\s*$/iu.test(between)) break;
            listIds.unshift(match[0]);
          }
        }
        const withdrawn = lastId ? own.filter((id) => listIds.includes(id)) : own;
        const targets = withdrawn.length ? withdrawn : own;
        if (targets.length) {
          withdraw(targets);
          acted = true;
        }
      }

      const renumberMatch = RENUMBERED.exec(sentence.text);
      const renumber =
        renumberMatch && !/\b(?:ikke|aldri)\b/iu.test(sentence.text.slice(Math.max(0, renumberMatch.index - 15), renumberMatch.index))
          ? renumberMatch[1]
          : undefined;
      const renumberTarget = renumberMatch
        ? subjects({ text: sentence.text, ids: sentence.ids.filter(({ at }) => at < renumberMatch.index) }, known()).at(-1) ?? own.find((id) => id !== renumber)
        : undefined;
      if (renumberMatch && renumber && renumberTarget && !known().has(renumber)) {
        const occurrences = entries.filter((entry) => entry.id === renumberTarget);
        // An explicit ordinal can disambiguate a renumbering. Without it,
        // choosing the last occurrence would silently rename the wrong row.
        const ordinal = [...sentence.text.slice(0, renumberMatch.index).matchAll(/\b(første|andre|tredje|siste)\b/giu)]
          .at(-1)?.[1]?.toLocaleLowerCase("nb");
        if (occurrences.length > 1 && !ordinal) assertUniqueTargets([renumberTarget]);
        const at = ordinal === "første" ? 0 : ordinal === "andre" ? 1 : ordinal === "tredje" ? 2 : occurrences.length - 1;
        const renamed = occurrences[at];
        if (!renamed) {
          throw new WorkflowPreconditionError(
            `Kravrettelsen for ${renumberTarget} viser til en forekomst som ikke finnes. Avklar rekkefølgen før du bruker ny krav-ID.`,
          );
        }
        entries = entries.map((entry) =>
          entry === renamed
            ? { ...entry, id: renumber, sourceExcerpt: [entry.sourceExcerpt, `Ny ID i rettelse (tidligere ${renumberTarget}): ${statement}`].filter(Boolean).join(" | ") }
            : entry,
        );
        report.renumbered.push(`${renumberTarget}->${renumber}`);
        acted = true;
      }

      const placeholders = [...sentence.text.matchAll(/«#(\d+)»/gu)];
      const addition = ADDED.exec(sentence.text);
      const additionNegated =
        addition && /\b(?:ikke|aldri)\b/iu.test(sentence.text.slice(Math.max(0, addition.index - 20), addition.index + addition[0].length));
      if (addition && !additionNegated && placeholders.length) {
        // The ID after "nytt krav", else one that never was in the source.
        const named = /\bnytt\s+krav\s+([A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4})\b/iu.exec(masked)?.[1];
        const newId = [named, ...statementIds].find((id) => id && !sourceIds.has(id) && !known().has(id));
        if (newId) {
          const anchor = entries.filter((entry) => idPrefix(entry.id) === idPrefix(newId)).at(-1);
          const added: RequirementLedgerEntry = {
            id: newId,
            text: quotes[Number(placeholders.at(-1)![1])]!,
            pages: anchor?.pages ?? [],
            heading: anchor?.heading ?? "",
            ...(anchor?.documentId ? { documentId: anchor.documentId } : {}),
            ...(anchor?.documentTitle ? { documentTitle: anchor.documentTitle } : {}),
            sourceExcerpt: `Nytt krav i rettelse: ${statement}`,
          };
          const at = anchor ? entries.indexOf(anchor) + 1 : entries.length;
          entries = [...entries.slice(0, at), added, ...entries.slice(at)];
          report.added.push(newId);
          acted = true;
        }
      }

      for (const verb of sentence.text.matchAll(CHANGE_VERB)) {
        if (negatedAt(sentence.text, verb.index!, verb[0].length) || !placeholders.length) continue;
        // The new wording: the quote after "til"/"ny tekst"/"lyder", else
        // the last one ("endres fra «gammel» til «ny»").
        const marked = placeholders.find((placeholder) =>
          /\b(?:til|ny\s+tekst|lyder(?:\s+nå)?|skal\s+nå\s+lyde)\s*:?\s*$/iu.test(sentence.text.slice(0, placeholder.index)),
        );
        const markedIndex = marked ?? placeholders.at(-1)!;
        const quote = quotes[Number(markedIndex[1])]!;
        // "endres fra «fem virkedager» til «tre virkedager»": the quote before
        // the new one names the wording it replaces.
        const previous = placeholders[placeholders.indexOf(markedIndex) - 1];
        const replaced =
          previous &&
          /^\s*(?:(?:endres|erstattes)\s+)?(?:til|med)\s*:?\s*$/iu.test(
            sentence.text.slice(previous.index! + previous[0].length, markedIndex.index),
          )
            ? quotes[Number(previous[1])]
            : undefined;
        // The change belongs to the subject named last before its verb.
        const target =
          subjects({ text: sentence.text, ids: sentence.ids.filter(({ at }) => at < verb.index!) }, known()).at(-1) ??
          own[0];
        if (!target || !known().has(target)) continue;
        const original = entries.find((entry) => entry.id === target)?.text ?? "";
        // "Andre setning endres til «…»" rewrites a part of the requirement:
        // without the old wording to replace, it stays a note.
        const namesPart = /\b(?:setning(?:en)?|ledd(?:et)?|avsnitt(?:et)?|kulepunkt(?:et)?|punkt(?:et)?|første|andre|tredje|siste)\b/iu.test(
          sentence.text.slice(0, verb.index!),
        );
        const text = namesPart && !replaced ? null : correctedWording(original, quote, replaced);
        // A fragment ("Fristen endres til «tre virkedager»") whose place in
        // the requirement is unknown stays a note on the original wording.
        if (text === null) {
          // Kept as a note even when another part of the statement applied
          // ("OPS-2 utgår. OPS-1 endres til: «30 minutter».").
          if (!noted.has(target)) {
            note(target, "Rettelse", statement);
            pendingNotes.push({ id: target, statement });
            noted.add(target);
          }
          continue;
        }
        assertUniqueTargets([target]);
        entries = entries.map((entry) =>
          entry.id === target
            ? {
                ...entry,
                text,
                sourceExcerpt: [entry.sourceExcerpt, `Endret ved rettelse: ${statement}`, `Opprinnelig tekst: ${entry.text}`].filter(Boolean).join(" | "),
              }
            : entry,
        );
        report.changed.push(target);
        acted = true;
        break;
      }
    }

    if (acted) {
      applied += 1;
    } else {
      // Statements naming a requirement without an affirmative action.
      // A change, a withdrawal or a scope clarification ("OPS-1 gjelder kun
      // produksjonsmiljøet.") is kept even when nothing else applies.
      const affirmativeText = affirmative.map((sentence) => sentence.text).join(" ");
      const namesAction =
        affirmativeText.search(CHANGE_VERB) >= 0 || affirmativeText.search(WITHDRAW_VERB) >= 0 || SCOPE_STATEMENT.test(affirmativeText);
      for (const id of subjects({ text: affirmativeText, ids: sentences(affirmativeText).flatMap((sentence) => sentence.ids) }, known())) {
        if (noted.has(id)) continue;
        note(id, "Rettelse", statement);
        if (namesAction) pendingNotes.push({ id, statement });
      }
    }
  }

  // Without a single applied correction this may not be a corrections
  // chapter for this ledger: rows stay as they are, and only statements
  // naming an action on a requirement are attached, so an unplaced change
  // is never lost without a trace.
  if (!applied && !report.clarified.length) {
    if (!pendingNotes.length) return { ledger, originalLedger, report };
    return {
      ledger: ledger.map((entry) => {
        const statements = pendingNotes.filter((pending) => pending.id === entry.id).map((pending) => `Rettelse: ${pending.statement}`);
        return statements.length
          ? { ...entry, sourceExcerpt: [entry.sourceExcerpt, ...statements].filter(Boolean).join(" | ") }
          : entry;
      }),
      originalLedger,
      report,
    };
  }

  return { ledger: entries, originalLedger, report };
}

/**
 * The requirement IDs a document should yield after its corrections chapter
 * is applied, in order and with multiplicity: completeness checks compare
 * against this, so an intended withdrawal or renumbering is not reported as
 * a lost row.
 */
export function correctedRequirementIds(ids: string[], rawText: string) {
  return applyRequirementCorrections(
    ids.map((id) => ({ id, text: "", pages: [], heading: "" })),
    rawText,
    { removeCorrectionRows: false },
  ).ledger.map((entry) => entry.id);
}
