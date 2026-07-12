import "server-only";

import type { GeneratedArtifactType, ProjectDocumentDetail } from "@/lib/types";

export type DocumentLedgerConfidence = "high" | "medium" | "low";

export type DocumentLedgerRequirement = {
  ref: string;
  text: string;
  page?: number;
  heading?: string;
  source: string;
  kind: "table" | "explicit" | "section";
};

export type DocumentLedger = {
  documentId: string;
  title: string;
  fileName: string;
  fileFormat: string;
  toc: string[];
  sections: Array<{ ref: string; title: string; page?: number }>;
  tables: Array<{ title: string; page?: number; rows: number }>;
  requirements: DocumentLedgerRequirement[];
  pageEvidence: Array<{ page: number; signalCount: number; excerpt: string }>;
  confidence: DocumentLedgerConfidence;
  confidenceScore: number;
  signals: string[];
};

const REQUIREMENT_WORD_PATTERN =
  /\b(skal|må|must|shall|required|requirement|krav|leverandør(?:en)?\s+skal|supplier\s+shall)\b/i;
const DOT_LEADER_PATTERN = /\.{4,}\s*\d{1,4}\s*$/;
const SECTION_PATTERN =
  /^(?<ref>(?:\d{1,3}\.)+\d{1,3}|[A-ZÆØÅ]{1,6}-?\d{1,4}(?:\.\d{1,3})?|ID\s*\d+(?:\.\d+)*|Krav\s*\d+(?:\.\d+)*)\s+(?<title>\S.{2,})$/i;
const TABLE_ID_PATTERN =
  /^(?<ref>(?:\d{1,3}\.)+\d{1,3}|ID\s*\d+(?:\.\d+)*|Krav\s*\d+(?:\.\d+)*|[A-ZÆØÅ]{1,6}-?\d{1,4}(?:\.\d{1,3})?)$/i;

function normalizeLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function getPages(rawText: string) {
  const pages: Array<{ page: number; text: string }> = [];
  const pattern = /\[\[SIDE:(\d+)\]\]/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let lastPage = 1;

  while ((match = pattern.exec(rawText))) {
    if (match.index > lastIndex) {
      pages.push({
        page: lastPage,
        text: rawText.slice(lastIndex, match.index),
      });
    }
    lastPage = Number(match[1]) || lastPage + 1;
    lastIndex = pattern.lastIndex;
  }

  pages.push({ page: lastPage, text: rawText.slice(lastIndex) });
  return pages.filter((page) => page.text.trim());
}

function isTocLine(line: string) {
  const normalized = normalizeLine(line);
  return (
    /^table of contents$/i.test(normalized) ||
    /^innholdsfortegnelse$/i.test(normalized) ||
    DOT_LEADER_PATTERN.test(normalized)
  );
}

function cleanRequirementText(value: string) {
  return normalizeLine(value)
    .replace(/\s+\.{4,}\s*\d{1,4}\s*$/, "")
    .replace(/\s+Side\s+\d+\s*$/i, "")
    .trim();
}

function requirementKey(requirement: DocumentLedgerRequirement) {
  return `${requirement.ref.toLowerCase()}::${requirement.text.toLowerCase()}`;
}

function extractTableRequirements(input: {
  document: ProjectDocumentDetail;
  page: number;
  lines: string[];
  heading?: string;
}) {
  const requirements: DocumentLedgerRequirement[] = [];
  const tableHeaders = new Set(["req.", "no.", "requirement text", "type", "krav", "kravtekst"]);

  for (let index = 0; index < input.lines.length; index += 1) {
    const refLine = normalizeLine(input.lines[index] ?? "");
    if (!TABLE_ID_PATTERN.test(refLine) || isTocLine(refLine)) continue;

    const windowLines = input.lines
      .slice(index + 1, Math.min(input.lines.length, index + 10))
      .map(normalizeLine)
      .filter(Boolean)
      .filter((line) => !tableHeaders.has(line.toLowerCase()));
    const requirementParts: string[] = [];

    for (const line of windowLines) {
      if (TABLE_ID_PATTERN.test(line) || isTocLine(line)) break;
      if (/^(mandatory|optional|required|yes|no|m|o)$/i.test(line)) break;
      requirementParts.push(line);
      if (REQUIREMENT_WORD_PATTERN.test(line) || requirementParts.join(" ").length > 120) {
        break;
      }
    }

    const text = cleanRequirementText(requirementParts.join(" "));
    if (text.length < 12 || !REQUIREMENT_WORD_PATTERN.test(text)) continue;

    requirements.push({
      ref: refLine,
      text,
      page: input.page,
      heading: input.heading,
      source: `${input.document.title}, side ${input.page}, ${refLine}`,
      kind: "table",
    });
  }

  return requirements;
}

type DocumentLedgerAccumulator = Pick<
  DocumentLedger,
  "toc" | "sections" | "tables" | "requirements" | "pageEvidence"
> & {
  currentHeading: string;
  seenRequirements: Set<string>;
};

function createDocumentLedgerAccumulator(): DocumentLedgerAccumulator {
  return {
    toc: [],
    sections: [],
    tables: [],
    requirements: [],
    pageEvidence: [],
    currentHeading: "",
    seenRequirements: new Set<string>(),
  };
}

function splitDocumentLines(text: string) {
  return text
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);
}

function addRequirementIfNew(
  state: DocumentLedgerAccumulator,
  requirement: DocumentLedgerRequirement,
) {
  const key = requirementKey(requirement);
  if (state.seenRequirements.has(key)) {
    return false;
  }

  state.seenRequirements.add(key);
  state.requirements.push(requirement);
  return true;
}

function collectPageStructure(
  state: DocumentLedgerAccumulator,
  page: { page: number; text: string },
) {
  const lines = splitDocumentLines(page.text);
  let signalCount = 0;

  for (const line of lines) {
    if (isTocLine(line)) {
      state.toc.push(line);
      continue;
    }

    if (REQUIREMENT_WORD_PATTERN.test(line)) {
      signalCount += 1;
    }

    const section = line.match(SECTION_PATTERN);
    if (section?.groups) {
      const title = cleanRequirementText(section.groups.title);
      if (!DOT_LEADER_PATTERN.test(line) && title.length >= 3) {
        state.currentHeading = `${section.groups.ref} ${title}`;
        state.sections.push({
          ref: section.groups.ref,
          title,
          page: page.page,
        });
      }
    }

    if (/^(req\.?|no\.?|requirement text|krav|kravtekst|type)$/i.test(line)) {
      state.tables.push({
        title: state.currentHeading || `Tabell side ${page.page}`,
        page: page.page,
        rows: 0,
      });
    }
  }

  return { lines, signalCount };
}

function collectTableRequirements(
  state: DocumentLedgerAccumulator,
  document: ProjectDocumentDetail,
  page: number,
  lines: string[],
) {
  for (const requirement of extractTableRequirements({
    document,
    page,
    lines,
    heading: state.currentHeading,
  })) {
    if (addRequirementIfNew(state, requirement) && state.tables.length) {
      state.tables[state.tables.length - 1].rows += 1;
    }
  }
}

function explicitRequirementFromSectionLine(input: {
  document: ProjectDocumentDetail;
  page: number;
  line: string;
  heading: string;
}): DocumentLedgerRequirement | null {
  const match = input.line.match(SECTION_PATTERN);
  if (!match?.groups || isTocLine(input.line)) {
    return null;
  }

  const text = cleanRequirementText(match.groups.title);
  if (text.length < 16 || !REQUIREMENT_WORD_PATTERN.test(text)) {
    return null;
  }

  return {
    ref: match.groups.ref,
    text,
    page: input.page,
    heading: input.heading,
    source: `${input.document.title}, side ${input.page}, ${match.groups.ref}`,
    kind: "explicit",
  };
}

function collectExplicitRequirements(
  state: DocumentLedgerAccumulator,
  document: ProjectDocumentDetail,
  page: number,
  lines: string[],
) {
  for (const line of lines) {
    const requirement = explicitRequirementFromSectionLine({
      document,
      page,
      line,
      heading: state.currentHeading,
    });
    if (requirement) {
      addRequirementIfNew(state, requirement);
    }
  }
}

function collectPageEvidence(
  state: DocumentLedgerAccumulator,
  page: number,
  lines: string[],
  signalCount: number,
) {
  if (signalCount <= 0) {
    return;
  }

  state.pageEvidence.push({
    page,
    signalCount,
    excerpt: cleanRequirementText(
      lines.find((line) => REQUIREMENT_WORD_PATTERN.test(line)) ?? "",
    ).slice(0, 220),
  });
}

function ledgerSignals(
  document: ProjectDocumentDetail,
  state: DocumentLedgerAccumulator,
) {
  const metadataSignals = `${document.title} ${document.file_name} ${document.supporting_subtype ?? ""}`;
  const signals: string[] = [];

  if (/krav|requirement/i.test(metadataSignals)) signals.push("metadata_requirement");
  if (state.requirements.length >= 5) signals.push("requirement_rows");
  if (state.tables.some((table) => table.rows > 0)) signals.push("requirement_tables");
  if (state.pageEvidence.length >= 2) signals.push("requirement_language");
  if (state.toc.length) signals.push("toc_detected");

  return signals;
}

function ledgerConfidenceScore(
  signals: string[],
  state: DocumentLedgerAccumulator,
) {
  return (
    (signals.includes("metadata_requirement") ? 25 : 0) +
    (state.requirements.length >= 5 ? 45 : state.requirements.length * 7) +
    (state.tables.some((table) => table.rows > 0) ? 20 : 0) +
    Math.min(10, state.pageEvidence.length * 2)
  );
}

function ledgerConfidence(confidenceScore: number): DocumentLedgerConfidence {
  return confidenceScore >= 70
    ? "high"
    : confidenceScore >= 35
      ? "medium"
      : "low";
}

export function buildDocumentLedger(
  document: ProjectDocumentDetail,
): DocumentLedger {
  const pages = getPages(document.raw_text || "");
  const state = createDocumentLedgerAccumulator();

  for (const page of pages) {
    const { lines, signalCount } = collectPageStructure(state, page);
    collectTableRequirements(state, document, page.page, lines);
    collectExplicitRequirements(state, document, page.page, lines);
    collectPageEvidence(state, page.page, lines, signalCount);
  }

  const signals = ledgerSignals(document, state);
  const confidenceScore = ledgerConfidenceScore(signals, state);

  return {
    documentId: document.id,
    title: document.title,
    fileName: document.file_name,
    fileFormat: document.file_format,
    toc: state.toc.slice(0, 60),
    sections: state.sections.slice(0, 160),
    tables: state.tables,
    requirements: state.requirements,
    pageEvidence: state.pageEvidence.slice(0, 80),
    confidence: ledgerConfidence(confidenceScore),
    confidenceScore,
    signals,
  };
}

function artifactLedgerLabel(artifactType: GeneratedArtifactType) {
  switch (artifactType) {
    case "bilag1_rekonstruksjon":
      return "Seksjonsledger for Bilag 1";
    case "losningsutkast":
      return "Krav-til-løsning-matrise";
    case "gjennomforing_og_risiko":
      return "Evaluerings- og risikoleger";
    case "forbedret_kravsvar":
      return "Kravledger";
    default:
      return "Dokumentledger";
  }
}

export function buildDocumentLedgerContext(input: {
  artifactType: GeneratedArtifactType;
  ledgers: DocumentLedger[];
  maxRequirementsPerLedger?: number;
  maxSectionsPerLedger?: number;
}) {
  if (!input.ledgers.length) return "";

  const lines = input.ledgers.flatMap((ledger) => [
    `Dokument: ${ledger.title}`,
    `Tillit: ${ledger.confidence} (${ledger.confidenceScore})`,
    `Krav: ${ledger.requirements.length}`,
    `Seksjoner: ${ledger.sections
      .slice(0, input.maxSectionsPerLedger ?? 12)
      .map((section) => `${section.ref} ${section.title}`)
      .join(" | ")}`,
    `Kravutdrag: ${ledger.requirements
      .slice(0, input.maxRequirementsPerLedger ?? 20)
      .map((requirement) => `${requirement.ref}: ${requirement.text}`)
      .join(" | ")}`,
  ]);

  return [
    `### ${artifactLedgerLabel(input.artifactType)}`,
    "Bruk denne ledgeren som strukturert fasit for dokumentrekkefølge, krav-ID-er, kravtitler, tabeller og kildeindikasjoner. Ikke bruk innholdsfortegnelse som innhold.",
    ...lines,
  ].join("\n");
}

export function summarizeDocumentLedgers(ledgers: DocumentLedger[]) {
  return ledgers.map((ledger) => ({
    document_id: ledger.documentId,
    title: ledger.title,
    file_name: ledger.fileName,
    file_format: ledger.fileFormat,
    confidence: ledger.confidence,
    confidence_score: ledger.confidenceScore,
    requirement_count: ledger.requirements.length,
    section_count: ledger.sections.length,
    table_count: ledger.tables.length,
    toc_line_count: ledger.toc.length,
    signals: ledger.signals,
  }));
}
