import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

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
const QUOTED = /[«“"]([^«»“”"]{12,1500})[»”"]/gu;
const WITHDRAW_VERB =
  /\b(?:utgår|bortfaller|strykes|trekkes(?:\s+tilbake)?)\b|\b(?:slettes|fjernes|tas\s+ut)\s+(?:fra|av)\s+(?:kravspesifikasjonen|konkurransegrunnlaget|kravlisten|kravtabellen|tabell)\b/giu;
const CHANGE_VERB = /\b(?:endres|erstattes(?!\s+av\s+(?:et\s+)?nytt)|ny\s+tekst|lyder\s+nå|skal\s+nå\s+lyde)\b/giu;
const ADDED = /\b(?:nytt\s+krav|legges\s+til|tilføyes)\b/iu;
const RENUMBERED = /\bny\s+(?:krav-?)?id\s+([A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4})\b/iu;
const ANSWER = /^\s*svar\s*:/iu;
// An ID named as context rather than as the subject of the action.
const CONTEXT_BEFORE_ID =
  /(?:endringen\s+i|jf\.?|jfr\.?|i\s+henhold\s+til|se|som\s+følge\s+av|nytt\s+krav|erstattes\s+av|i\s+stedet\s+for|kontrollene\s+i|som\s+i)\s*$/iu;
// A new statement starts at a table row, a blank line, a bullet or numbered
// line, a Markdown table row, or a line led by a requirement ID.
const STATEMENT_START =
  /\n(?=Rad \d+:)|\n\s*\n|\n(?=[ \t]*(?:[-•*–]|\d{1,2}[.)])\s)|\n(?=[ \t]*\|)|\n(?=[ \t]*(?:(?:nytt\s+)?krav(?:et|ene)?\s+|for\s+)?[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4}\b)/iu;

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

/** The last corrections heading (a table of contents also lists it) up to
 * the next top-level chapter or appendix. */
export function findCorrectionsSection(rawText: string) {
  const lines = rawText.split("\n");
  let start = -1;
  let chapter: string | undefined;
  lines.forEach((line, index) => {
    const match = CORRECTIONS_HEADING.exec(line.trim());
    if (match && lines.slice(index + 1).some((next) => next.trim())) {
      start = index;
      chapter = match[1];
    }
  });
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    const topLevel = /^(\d{1,2})\s+[A-ZÆØÅ]/u.exec(line);
    if (/^vedlegg\s+[A-Z0-9]\b/iu.test(line) || (topLevel && topLevel[1] !== chapter)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** One statement per table row, list item or ID-led line; wrapped
 * continuation lines stay with their statement. */
function statements(section: string) {
  return section
    .split("\n")
    .slice(1)
    .join("\n")
    .split(STATEMENT_START)
    .map((part) =>
      part
        .replace(/^\s*Rad \d+:\s*/u, "")
        .replace(/^\s*(?:[-•*–]|\d{1,2}[.)])\s+/u, "")
        .replace(/^\s*\|\s*|\s*\|\s*$/gu, "")
        .replace(/\s*\|\s*/gu, " | ")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter((part) => part.length > 0);
}

function idPrefix(id: string) {
  return id.replace(/-\d.*$/u, "");
}

/** Sentences of a masked statement, each with its IDs and their positions. */
function sentences(masked: string) {
  return masked
    .split(/(?<=[.!?])\s+(?=[A-ZÆØÅ«|])|\s+\|\s+/u)
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
): { ledger: RequirementLedgerEntry[]; report: RequirementCorrectionReport } {
  const report: RequirementCorrectionReport = { changed: [], withdrawn: [], added: [], renumbered: [], clarified: [] };
  const section = findCorrectionsSection(rawText);
  if (!section) return { ledger, report };

  // Rows extracted from the chapter itself (the change rows, bidder
  // questions, a "K-1 får ny ID" fragment) are not requirements; they are
  // set aside before any action, so they are never its target. They are
  // found outside quoted text, so an original requirement whose old wording
  // a correction quotes is never mistaken for one.
  // Compared with a uniform placeholder: quote numbering differs between
  // the section and a row extracted from it.
  const unquoted = (text: string) => normalized(maskQuotes(text).masked.replace(/«#\d+»/gu, "«»"));
  const maskedSection = unquoted(section);
  const isCorrectionRow = (entry: RequirementLedgerEntry) => {
    const text = unquoted(entry.text);
    if (text.length >= 12) return maskedSection.includes(text);
    return (
      text.length > 0 &&
      maskedSection.includes(entry.id.toLocaleLowerCase("nb")) &&
      ledger.filter((other) => other.id === entry.id).length > 1
    );
  };
  let entries =
    options.removeCorrectionRows === false ? ledger : ledger.filter((entry) => !isCorrectionRow(entry));
  const known = () => new Set(entries.map((entry) => entry.id));
  const sourceIds = new Set(ledger.map((entry) => entry.id));
  const note = (id: string, label: string, statement: string) => {
    entries = entries.map((entry) =>
      entry.id === id
        ? { ...entry, sourceExcerpt: [entry.sourceExcerpt, `${label}: ${statement}`].filter(Boolean).join(" | ") }
        : entry,
    );
  };
  let applied = 0;

  for (const statement of statements(section)) {
    const { masked, quotes } = maskQuotes(statement);
    if (ANSWER.test(masked)) {
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
    let context: string | undefined;
    let acted = false;
    for (const sentence of sentences(masked)) {
      const ids = subjects(sentence, known());
      // A sentence naming no requirement ("Kravet utgår.", "Ny tekst: …")
      // refers back to the one named before it in the same statement.
      const own = ids.length ? ids : context ? [context] : [];
      if (ids.length) context = ids.at(-1);

      for (const verb of sentence.text.matchAll(WITHDRAW_VERB)) {
        if (negatedAt(sentence.text, verb.index!, verb[0].length)) continue;
        for (const id of own) {
          entries = entries.filter((entry) => entry.id !== id);
          report.withdrawn.push(id);
          acted = true;
        }
      }

      const renumber = RENUMBERED.exec(sentence.text)?.[1];
      const renumberTarget = own.find((id) => id !== renumber);
      if (renumber && renumberTarget && !known().has(renumber)) {
        const occurrences = entries.filter((entry) => entry.id === renumberTarget);
        // A repeated ID: "Det andre kravet får ny ID ..." renames that one.
        const renamed =
          occurrences.length >= 2
            ? /\bførste\b[^.]*\bny\s+id\b/iu.test(sentence.text) ? occurrences[0]! : occurrences.at(-1)!
            : occurrences[0]!;
        entries = entries.map((entry) =>
          entry === renamed
            ? { ...entry, id: renumber, sourceExcerpt: [entry.sourceExcerpt, `Ny ID i rettelse (tidligere ${renumberTarget}): ${statement}`].filter(Boolean).join(" | ") }
            : entry,
        );
        report.renumbered.push(`${renumberTarget}->${renumber}`);
        acted = true;
      }

      const placeholders = [...sentence.text.matchAll(/«#(\d+)»/gu)];
      if (ADDED.test(sentence.text) && placeholders.length) {
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
        const quote = quotes[Number((marked ?? placeholders.at(-1))![1])]!;
        // The change belongs to the subject named last before its verb.
        const target =
          subjects({ text: sentence.text, ids: sentence.ids.filter(({ at }) => at < verb.index!) }, known()).at(-1) ??
          own[0];
        if (!target || !known().has(target)) continue;
        entries = entries.map((entry) =>
          entry.id === target
            ? {
                ...entry,
                text: quote,
                sourceExcerpt: [`Endret ved rettelse: ${statement}`, `Opprinnelig tekst: ${entry.text}`].join(" | "),
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
      for (const id of subjects({ text: masked, ids: sentences(masked).flatMap((sentence) => sentence.ids) }, known())) {
        note(id, "Rettelse", statement);
      }
    }
  }

  // Without a single applied correction this is not a corrections chapter
  // for this ledger: leave it untouched.
  if (!applied && !report.clarified.length) return { ledger, report };

  return { ledger: entries, report };
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
