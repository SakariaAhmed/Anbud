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
const REQUIREMENT_ID_SINGLE = /\b[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4}\b/u;
const QUOTED = /[«“"]([^«»“”"]{12,1500})[»”"]/gu;
const WITHDRAW_VERB =
  /\b(?:utgår|bortfaller|strykes|trekkes(?:\s+tilbake)?|er\s+utgått|slettes)\b|\b(?:fjernes|tas\s+ut)\s+(?:fra|av)\s+(?:kravspesifikasjonen|konkurransegrunnlaget|kravlisten|kravtabellen|tabell)\b/giu;
const CHANGE_VERB = /\b(?:endres|er\s+endret\s+til|erstattes(?!\s+av\s+(?:et\s+)?nytt)|ny\s+tekst|lyder\s+nå|skal\s+(?:nå\s+)?lyde)\b/giu;
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

/** The document without its corrections chapter: source inventories are
 * counted from the original requirement text, then corrected. */
export function withoutCorrectionsSection(rawText: string) {
  const section = findCorrectionsSection(rawText);
  return section ? rawText.replace(section, "") : rawText;
}

/** One statement per table row, list item or ID-led line; wrapped
 * continuation lines stay with their statement. */
function statements(section: string) {
  return tableAwareLines(section.split("\n").slice(1))
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

const TABLE_ROW = /^\s*(?:Rad \d+:\s*|\|)/u;
const QUESTION_COLUMN = /^(?:spørsmål|leverandørens\s+spørsmål|spørsmål\s+fra\s+(?:leverandør|tilbyder)(?:en)?|henvendelse)/iu;
const NEW_TEXT_COLUMN = /^(?:ny\s+tekst|ny\s+kravtekst|endret\s+tekst|ny\s+ordlyd)$/iu;
const OLD_TEXT_COLUMN = /^(?:opprinnelig\s+tekst|gammel\s+tekst|tidligere\s+tekst|opprinnelig\s+kravtekst)$/iu;

function tableCells(line: string) {
  return line
    .replace(/^\s*Rad \d+:\s*/u, "")
    .replace(/^\s*\|\s*|\s*\|\s*$/gu, "")
    .split(/\s*\|\s*/u);
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
      if (NEW_TEXT_COLUMN.test(label) && cell.trim() && !/[«“"]/u.test(cell)) return [`Ny tekst: «${cell.trim()}»`];
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
    .split(/(?<=[.!?])\s+(?=[A-ZÆØÅ«|])|\s+\|\s+|,\s*(?=(?:men|mens|samtidig\s+som|derimot)\b)|;\s*/u)
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
  // Text that also occurs outside the chapter is an original requirement,
  // even when an "Opprinnelig tekst" column repeats it unquoted.
  const outsideSection = normalized(rawText.replace(section, " "));
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
    // "Ny tekst: Leverandøren skal …" without quotation marks: the rest of the
    // cell is the new wording.
    const quotedStatement = statement.replace(
      /\b((?:ny\s+tekst|skal\s+(?:nå\s+)?lyde|er\s+endret\s+til|endres\s+til)\s*:?\s*)(?![«“"])([^|«»“”"]{12,1500}?)(\s*(?:\||$))/giu,
      (_match, lead: string, text: string, tail: string) => `${lead}«${text.trim().replace(/[.\s]+$/u, "")}.»${tail}`,
    );
    const { masked: maskedRaw, quotes } = maskQuotes(quotedStatement);
    const masked = expandIdRanges(maskedRaw);
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
    let context: string[] | undefined;
    let acted = false;
    // A bidder question ("Kan K-4 strykes …?") asks; it never acts.
    // A request ("Vi ber om at K-1 strykes") is not a correction either.
    const isQuestion = (text: string) =>
      /\?\s*$/u.test(text.trim()) ||
      /^\s*spørsmål\b/iu.test(text) ||
      /\b(?:vi\s+ber\s+om|ber\s+om\s+at|ønsker\s+(?:at|å)|foreslår\s+at|anmoder\s+om)\b/iu.test(text);
    if (isQuestion(masked)) continue;
    for (const sentence of sentences(masked)) {
      if (isQuestion(sentence.text)) continue;
      const ids = subjects(sentence, known());
      // A sentence naming no requirement ("Kravene utgår.", "Ny tekst: …")
      // refers back to all requirements named before it in the statement.
      const own = ids.length ? ids : context ?? [];
      if (ids.length) context = ids;

      // "K-6 utgår og erstattes av: «…»" replaces the wording: a change.
      const replacesWording =
        /\berstattes\s+av\s*:?\s*«#\d+»/u.test(sentence.text) &&
        !statementIds.some((id) => !sourceIds.has(id));
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
          for (const id of after) {
            entries = entries.filter((entry) => entry.id !== id);
            report.withdrawn.push(id);
            acted = true;
          }
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
        for (const id of withdrawn.length ? withdrawn : own) {
          entries = entries.filter((entry) => entry.id !== id);
          report.withdrawn.push(id);
          acted = true;
        }
      }

      const renumberMatch = RENUMBERED.exec(sentence.text);
      const renumber =
        renumberMatch && !/\b(?:ikke|aldri)\b/iu.test(sentence.text.slice(Math.max(0, renumberMatch.index - 15), renumberMatch.index))
          ? renumberMatch[1]
          : undefined;
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
