import { detectExplicitRequirementIds } from "@/lib/server/requirements/id-detection";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";
import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

type TypedFallbackRequirementKind =
  | "Tabellkrav"
  | "Punktkrav"
  | "Tekstkrav"
  | "Notatkrav"
  | "Avklaringskrav";

type SequentialRequirementId = {
  index: number;
  prefix: string;
  number: number;
  width: number;
};

function canonicalTypedFallbackRequirementKind(
  value: string,
): TypedFallbackRequirementKind | null {
  switch (normalizePageText(value).toLocaleLowerCase("nb")) {
    case "tabellkrav":
      return "Tabellkrav";
    case "punktkrav":
      return "Punktkrav";
    case "tekstkrav":
      return "Tekstkrav";
    case "notatkrav":
      return "Notatkrav";
    case "avklaringskrav":
      return "Avklaringskrav";
    default:
      return null;
  }
}

function isSyntheticRequirementId(value: string) {
  return /^Side\s+\d+\s+krav\s+\d+$/i.test(normalizeRequirementId(value));
}

function isGeneratedRequirementId(value: string) {
  const id = normalizeRequirementId(value);
  return (
    isSyntheticRequirementId(id) ||
    /^(?:Åpent punkt|Leverandørpunkt|Faginnspill|Avklaringspunkt|Huskelistepunkt|Ustrukturert krav)\s+\d+$/i.test(
      id,
    ) ||
    /^(?:DOCX|Docling|Strukturert)\s+tabell\s+\d+\s+rad\s+\d+$/i.test(id)
  );
}

function typedFallbackRequirementIdKind(
  entry: RequirementLedgerEntry,
): TypedFallbackRequirementKind | null {
  const id = normalizeRequirementId(entry.id);
  const existingTyped = id.match(
    /^(Tabellkrav|Punktkrav|Tekstkrav|Notatkrav|Avklaringskrav)-\d+$/i,
  );
  if (existingTyped?.[1]) {
    return canonicalTypedFallbackRequirementKind(existingTyped[1]);
  }

  if (
    detectExplicitRequirementIds(entry.id).length > 0 &&
    !/^(?:Dokumenttekst\s+krav|Side\s+\d+\s+krav|Kundedokument\s+-\s+tabell|DOCX\s+tabell|Docling\s+tabell|Strukturert\s+tabell)/i.test(
      entry.id,
    )
  ) {
    return null;
  }

  const source = normalizePageText(entry.sourceExcerpt ?? "");
  const tableId = normalizePageText(entry.tableId ?? "");
  const isFallbackId =
    isSyntheticRequirementId(entry.id) ||
    /^Dokumenttekst\s+krav\s+\d+$/i.test(entry.id) ||
    /^(?:Kundedokument\s+-\s+tabell|DOCX\s+tabell|Docling\s+tabell|Strukturert\s+tabell)\b/i.test(
      entry.id,
    );
  if (!isFallbackId) {
    return null;
  }

  if (
    /^Krav\s+uten\s+egen\s+tabellrad:/i.test(source) ||
    /^Fra\s+arbeidsnotatet:/i.test(source)
  ) {
    return "Tekstkrav";
  }
  if (/^(?:Notat\s+fra\s+behovsarbeidet|Notat)\s*[:\-]/i.test(source)) {
    return "Notatkrav";
  }
  if (/^(?:Avklaring|Implisitt)\s*:/i.test(source)) {
    return "Avklaringskrav";
  }
  if (/\bAvklaring\/kravnotat\s*:/i.test(source)) {
    return "Avklaringskrav";
  }
  if (
    /\bKravtekst\s*:/i.test(source) ||
    /\bPrioritet\s*:/i.test(source) ||
    /^(?:DOCX|Docling|Strukturert|PDF)\s+(?:krav)?tabell\b/i.test(tableId)
  ) {
    return "Tabellkrav";
  }

  return null;
}

function assignTypedFallbackRequirementIds(
  entries: RequirementLedgerEntry[],
) {
  const counts = new Map<TypedFallbackRequirementKind, number>();

  return entries.map((entry) => {
    const existingTyped = normalizeRequirementId(entry.id).match(
      /^(Tabellkrav|Punktkrav|Tekstkrav|Notatkrav|Avklaringskrav)-(\d+)$/i,
    );
    if (existingTyped?.[1]) {
      const kind = canonicalTypedFallbackRequirementKind(existingTyped[1]);
      if (!kind) {
        return entry;
      }
      counts.set(kind, Math.max(counts.get(kind) ?? 0, Number(existingTyped[2])));
      return entry;
    }

    const kind = typedFallbackRequirementIdKind(entry);
    if (!kind) {
      return entry;
    }

    const next = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, next);
    return {
      ...entry,
      id: `${kind}-${String(next).padStart(2, "0")}`,
    };
  });
}

function parseSequentialRequirementId(
  entry: RequirementLedgerEntry,
  index: number,
): SequentialRequirementId | null {
  const id = normalizeRequirementId(entry.id);
  if (
    isGeneratedRequirementId(id) ||
    !detectExplicitRequirementIds(id).length
  ) {
    return null;
  }

  const match = id.match(/^(.+?)(\d{1,5})$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const number = Number(match[2]);
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }

  return {
    index,
    prefix: match[1],
    number,
    width: match[2].length,
  };
}

function normalizedHeading(entry: RequirementLedgerEntry) {
  return normalizePageText(entry.heading).toLocaleLowerCase("nb");
}

function sameDocument(
  left: RequirementLedgerEntry,
  right: RequirementLedgerEntry,
) {
  return left.documentId === right.documentId;
}

function formatSequentialRequirementId(
  anchor: Pick<SequentialRequirementId, "prefix" | "width">,
  number: number,
) {
  return `${anchor.prefix}${String(number).padStart(anchor.width, "0")}`;
}

function inferBoundedSequentialRequirementIds(
  entries: RequirementLedgerEntry[],
) {
  const anchors = entries
    .map((entry, index) => parseSequentialRequirementId(entry, index))
    .filter((anchor): anchor is SequentialRequirementId => anchor !== null);
  if (anchors.length < 2) {
    return entries;
  }

  const explicitIds = new Set(
    anchors.map((anchor) =>
      normalizeRequirementId(
        formatSequentialRequirementId(anchor, anchor.number),
      ),
    ),
  );
  const result = [...entries];

  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
    const previous = anchors[anchorIndex];
    const next = anchors[anchorIndex + 1];
    const previousEntry = entries[previous.index];
    const nextEntry = entries[next.index];
    const candidates = entries.slice(previous.index + 1, next.index);
    const gap = next.number - previous.number - 1;

    if (
      previous.prefix !== next.prefix ||
      previous.width !== next.width ||
      gap <= 0 ||
      candidates.length !== gap ||
      !sameDocument(previousEntry, nextEntry) ||
      normalizedHeading(previousEntry) !== normalizedHeading(nextEntry) ||
      candidates.some(
        (entry) =>
          !/^Tekstkrav-\d+$/i.test(normalizeRequirementId(entry.id)) ||
          !sameDocument(previousEntry, entry) ||
          normalizedHeading(entry) !== normalizedHeading(previousEntry),
      )
    ) {
      continue;
    }

    const inferredIds = candidates.map((_entry, offset) =>
      formatSequentialRequirementId(previous, previous.number + offset + 1),
    );
    if (
      inferredIds.some((id) => explicitIds.has(normalizeRequirementId(id)))
    ) {
      continue;
    }

    candidates.forEach((_entry, offset) => {
      result[previous.index + offset + 1] = {
        ...result[previous.index + offset + 1],
        id: inferredIds[offset],
      };
    });
  }

  return result;
}

/**
 * Assigns readable fallback IDs and only promotes them when two explicit,
 * document-local anchors prove the complete intervening numeric sequence.
 * Ambiguous, unbounded, or colliding cases retain their fallback IDs.
 */
export function assignGeneratedRequirementFallbackIds(
  entries: RequirementLedgerEntry[],
) {
  return inferBoundedSequentialRequirementIds(
    assignTypedFallbackRequirementIds(entries),
  );
}
