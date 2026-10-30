import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

// Tender documents often publish changes in a closing "Rettelser" chapter
// that takes precedence over the original requirement tables, which are left
// unchanged. Without applying it, withdrawn requirements were still answered
// and evaluated, changed requirements were judged on their old wording, and
// the correction rows themselves became requirements.

// Only a real heading: a capitalised title (optionally numbered) naming a
// corrections chapter. A wrapped table line such as "endringer relatert til"
// must not open a section.
const CORRECTIONS_HEADING =
  /^(?:(\d{1,2})(?:\.\d{1,2})*\.?\s+)?(?:Rettelser?|RETTELSER?|Errata|Endringer i (?:konkurransegrunnlaget|kravspesifikasjonen|kravene|bilag\s*\d+))\b[^\n]{0,80}(?<![.!?:;,])$/u;
const REQUIREMENT_ID = /\b[A-ZÆØÅ]{1,8}-\d{1,4}(?:\.\d{1,3})?(?:\.[a-z])?\b/gu;
const QUOTED = /[«“"]([^«»“”"]{12,1500})[»”"]/gu;
// Stateless twin of QUOTED for `.test()`; a global regex keeps lastIndex.
const HAS_QUOTE = /[«“"][^«»“”"]{12,1500}[»”"]/u;
const WITHDRAWN = /\b(?:utgår|bortfaller|strykes|trekkes(?:\s+tilbake)?|slettes|fjernes)\b/iu;
const WITHDRAWN_NEGATED =
  /\b(?:utgår|bortfaller|strykes|trekkes|slettes|fjernes)\s+(?:likevel\s+)?ikke\b|\bikke\s+(?:utgå|bortfalle|strykes|trekkes|slettes|fjernes)\b/iu;
const CHANGED = /\b(?:endres|erstattes|ny\s+tekst|lyder\s+nå|skal\s+nå\s+lyde)\b/iu;
const CHANGED_NEGATED = /\b(?:endres|erstattes)\s+ikke\b|\bikke\s+(?:endres|erstattes)\b/iu;
const ADDED = /\b(?:nytt\s+krav|legges\s+til|tilføyes)\b/iu;
const RENUMBERED = /\bny\s+(?:krav-?)?id\s+([A-ZÆØÅ]{1,8}-\d{1,4})\b/iu;
const ANSWER = /^\s*svar\s*:/iu;
// A new statement starts at a table row or at a line led by a requirement ID.
const STATEMENT_START = /\n(?=Rad \d+:)|\n\s*\n|\n(?=[ \t]*(?:(?:nytt\s+)?krav\s+)?[A-ZÆØÅ]{1,8}-\d{1,4}\b)/iu;

function normalized(value: string) {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("nb");
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

/** Table rows and ID-led lines become one statement each; wrapped
 * continuation lines stay with their statement. */
function statements(section: string) {
  return section
    .split(STATEMENT_START)
    .map((part) => part.replace(/^Rad \d+:\s*/u, "").replace(/\s*\|\s*/gu, " | ").replace(/\s+/gu, " ").trim())
    .filter((part) => part.length > 0);
}

function idPrefix(id: string) {
  return id.replace(/-\d.*$/u, "");
}

/** The new wording of a change: the quote after "til"/"ny tekst"/"lyder",
 * else the last quote ("endres fra «gammel» til «ny»"). */
function replacementQuote(statement: string) {
  const quotes = [...statement.matchAll(QUOTED)];
  if (!quotes.length) return undefined;
  const marked = quotes.find((quote) =>
    /\b(?:til|ny\s+tekst|lyder(?:\s+nå)?|skal\s+nå\s+lyde)\s*:?\s*$/iu.test(statement.slice(0, quote.index)),
  );
  return (marked ?? quotes.at(-1))![1]!.trim();
}

const withdraws = (statement: string) => WITHDRAWN.test(statement) && !WITHDRAWN_NEGATED.test(statement);
const changes = (statement: string) => CHANGED.test(statement) && !CHANGED_NEGATED.test(statement);

export type RequirementCorrectionReport = {
  changed: string[];
  withdrawn: string[];
  added: string[];
  renumbered: string[];
  clarified: string[];
};

/**
 * Applies a corrections chapter to a document's requirement ledger. Only
 * affirmative statements naming a requirement ID that exists in the ledger
 * (or, for new requirements, quoting the new text) are applied; negated or
 * ambiguous statements are attached to the requirement as notes instead.
 * Original wording is kept in the source excerpt for audit.
 */
export function applyRequirementCorrections(
  ledger: RequirementLedgerEntry[],
  rawText: string,
): { ledger: RequirementLedgerEntry[]; report: RequirementCorrectionReport } {
  const report: RequirementCorrectionReport = { changed: [], withdrawn: [], added: [], renumbered: [], clarified: [] };
  const section = findCorrectionsSection(rawText);
  if (!section) return { ledger, report };
  const ledgerIds = new Set(ledger.map((entry) => entry.id));
  const sectionStatements = statements(section);
  const correctionStatements = sectionStatements.filter((statement) => {
    const ids = statement.match(REQUIREMENT_ID) ?? [];
    return (
      (ids.some((id) => ledgerIds.has(id)) &&
        (withdraws(statement) || changes(statement) || RENUMBERED.test(statement) || ANSWER.test(statement))) ||
      (ADDED.test(statement) && HAS_QUOTE.test(statement))
    );
  });
  // Without a single statement that corrects a known requirement this is
  // not a corrections chapter for this ledger.
  if (!correctionStatements.length) return { ledger, report };
  const sectionText = normalized(section);

  // Rows extracted from the corrections chapter itself (the change rows and
  // bidder questions) are not requirements. Original requirement rows stay,
  // even when a correction quotes their old wording.
  let entries = ledger.filter((entry) => {
    const text = normalized(entry.text);
    if (text.length < 12 || !sectionText.includes(text)) return true;
    const isCorrectionRow =
      WITHDRAWN.test(text) || CHANGED.test(text) || ADDED.test(text) || RENUMBERED.test(text) ||
      /\bny\s+id\b|\?$/u.test(text);
    return !isCorrectionRow;
  });
  const known = () => new Set(entries.map((entry) => entry.id));
  const note = (id: string, label: string, statement: string) => {
    entries = entries.map((entry) =>
      entry.id === id
        ? { ...entry, sourceExcerpt: [entry.sourceExcerpt, `${label}: ${statement}`].filter(Boolean).join(" | ") }
        : entry,
    );
  };

  // The section qualified through a real correction, so other statements
  // naming a requirement may be attached to it as notes.
  for (const statement of sectionStatements) {
    const ids = [...new Set(statement.match(REQUIREMENT_ID) ?? [])];
    const target = ids.find((id) => known().has(id));

    if (ANSWER.test(statement)) {
      // Answers to bidder questions clarify, they do not rewrite requirements.
      for (const id of ids.filter((candidate) => known().has(candidate))) {
        note(id, "Presisering i rettelse", statement);
        report.clarified.push(id);
      }
      continue;
    }

    const renumber = RENUMBERED.exec(statement)?.[1];
    if (target && renumber && !known().has(renumber)) {
      const occurrences = entries.filter((entry) => entry.id === target);
      // A repeated ID: "Det andre kravet får ny ID ..." renames that one;
      // the first keeps the original ID unless the statement says otherwise.
      const renamed =
        occurrences.length >= 2
          ? /\bførste\b[^.]*\bny\s+id\b/iu.test(statement) ? occurrences[0]! : occurrences.at(-1)!
          : occurrences[0]!;
      entries = entries.map((entry) =>
        entry === renamed
          ? { ...entry, id: renumber, sourceExcerpt: [entry.sourceExcerpt, `Ny ID i rettelse (tidligere ${target}): ${statement}`].filter(Boolean).join(" | ") }
          : entry,
      );
      report.renumbered.push(`${target}->${renumber}`);
      continue;
    }

    const quote = replacementQuote(statement);
    if (ADDED.test(statement) && quote) {
      const newId = ids.find((id) => !known().has(id));
      if (newId) {
        const siblings = entries.filter((entry) => idPrefix(entry.id) === idPrefix(newId));
        const anchor = siblings.at(-1);
        const added: RequirementLedgerEntry = {
          id: newId,
          text: quote,
          pages: anchor?.pages ?? [],
          heading: anchor?.heading ?? "",
          ...(anchor?.documentId ? { documentId: anchor.documentId } : {}),
          ...(anchor?.documentTitle ? { documentTitle: anchor.documentTitle } : {}),
          sourceExcerpt: `Nytt krav i rettelse: ${statement}`,
        };
        const at = anchor ? entries.indexOf(anchor) + 1 : entries.length;
        entries = [...entries.slice(0, at), added, ...entries.slice(at)];
        report.added.push(newId);
        continue;
      }
    }

    if (!target) continue;
    if (withdraws(statement) && !changes(statement)) {
      entries = entries.filter((entry) => entry.id !== target);
      report.withdrawn.push(target);
      continue;
    }
    if (changes(statement) && quote) {
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
      continue;
    }
    note(target, "Rettelse", statement);
  }

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
  ).ledger.map((entry) => entry.id);
}
