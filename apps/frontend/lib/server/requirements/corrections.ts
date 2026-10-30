import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

// Tender documents often publish changes in a closing "Rettelser" chapter
// that takes precedence over the original requirement tables, which are left
// unchanged. Without applying it, withdrawn requirements were still answered
// and evaluated, changed requirements were judged on their old wording, and
// the correction rows themselves became requirements.

const CORRECTIONS_HEADING =
  /^(?:(\d{1,2})(?:\.\d{1,2})*\.?\s+)?(?:rettelser?|endringer|presiseringer|korrigeringer|errata)\b[^\n]{0,120}$/imu;
const REQUIREMENT_ID = /\b[A-ZÆØÅ]{1,8}-\d{1,4}(?:\.\d{1,3})?(?:\.[a-z])?\b/gu;
const QUOTED = /[«“"]([^«»“”"]{12,1500})[»”"]/u;
const WITHDRAWN = /\b(?:utgår|bortfaller|strykes|trekkes(?:\s+tilbake)?|slettes|fjernes)\b/iu;
const CHANGED = /\b(?:endres|erstattes|ny\s+tekst|lyder\s+nå|skal\s+nå\s+lyde)\b/iu;
const ADDED = /\b(?:nytt\s+krav|legges\s+til|tilføyes)\b/iu;
const RENUMBERED = /\bny\s+(?:krav-?)?id\s+([A-ZÆØÅ]{1,8}-\d{1,4})\b/iu;
const ANSWER = /^\s*svar\s*:/iu;

function normalized(value: string) {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("nb");
}

/** The last corrections heading that is followed by content (a table of
 * contents also lists it), up to the next top-level chapter or appendix. */
export function findCorrectionsSection(rawText: string) {
  const lines = rawText.split("\n");
  let start = -1;
  let chapter: string | undefined;
  lines.forEach((line, index) => {
    const match = CORRECTIONS_HEADING.exec(line.trim());
    if (match && lines.slice(index + 1, index + 6).some((next) => next.trim().length > 40)) {
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

/** Table rows become one statement each; other text splits on blank lines. */
function statements(section: string) {
  return section
    .split(/\n(?=Rad \d+:)|\n\s*\n/u)
    .map((part) => part.replace(/^Rad \d+:\s*/u, "").replace(/\s*\|\s*/gu, " | ").replace(/\s+/gu, " ").trim())
    .filter((part) => part.length > 0);
}

function idPrefix(id: string) {
  return id.replace(/-\d.*$/u, "");
}

export type RequirementCorrectionReport = {
  changed: string[];
  withdrawn: string[];
  added: string[];
  renumbered: string[];
  clarified: string[];
};

/**
 * Applies a corrections chapter to a document's requirement ledger. Only
 * statements naming a requirement ID that exists in the ledger (or, for new
 * requirements, quoting the new text) are applied; anything ambiguous is
 * attached to the requirement as a note instead of changing it. Original
 * wording is kept in the source excerpt for audit.
 */
export function applyRequirementCorrections(
  ledger: RequirementLedgerEntry[],
  rawText: string,
): { ledger: RequirementLedgerEntry[]; report: RequirementCorrectionReport } {
  const report: RequirementCorrectionReport = { changed: [], withdrawn: [], added: [], renumbered: [], clarified: [] };
  const section = findCorrectionsSection(rawText);
  if (!section) return { ledger, report };
  const sectionText = normalized(section);

  // Correction rows and Q&A text are not requirements of their own.
  let entries = ledger.filter((entry) => {
    const text = normalized(entry.text);
    return !(text.length >= 12 && sectionText.includes(text));
  });
  const known = () => new Set(entries.map((entry) => entry.id));
  const note = (id: string, label: string, statement: string) => {
    entries = entries.map((entry) =>
      entry.id === id
        ? { ...entry, sourceExcerpt: [entry.sourceExcerpt, `${label}: ${statement}`].filter(Boolean).join(" | ") }
        : entry,
    );
  };

  for (const statement of statements(section)) {
    const ids = [...new Set(statement.match(REQUIREMENT_ID) ?? [])];
    const target = ids.find((id) => known().has(id));
    const quote = QUOTED.exec(statement)?.[1]?.trim();

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
      if (occurrences.length >= 2) {
        // "Det andre kravet får ny ID ..."; the first keeps the original ID.
        const renamed = /\bførste\b[^.]*\bny\s+id\b/iu.test(statement) ? occurrences[0]! : occurrences.at(-1)!;
        entries = entries.map((entry) =>
          entry === renamed
            ? { ...entry, id: renumber, sourceExcerpt: [entry.sourceExcerpt, `Ny ID i rettelse (tidligere ${target}): ${statement}`].filter(Boolean).join(" | ") }
            : entry,
        );
        report.renumbered.push(`${target}->${renumber}`);
        continue;
      }
    }

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
    if (WITHDRAWN.test(statement) && !CHANGED.test(statement)) {
      entries = entries.filter((entry) => entry.id !== target);
      report.withdrawn.push(target);
      continue;
    }
    if (CHANGED.test(statement) && quote) {
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
