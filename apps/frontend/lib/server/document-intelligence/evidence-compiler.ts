import { createHash } from "node:crypto";

import { normalizeDocumentChunkStructureMap } from "@/lib/server/document-chunk-structure";
import { chooseDocumentParserRoute } from "@/lib/server/document-intelligence/quality-router";
import {
  DOCUMENT_INTELLIGENCE_COMPILER_VERSION,
  DOCUMENT_INTELLIGENCE_SCHEMA_VERSION,
  type DocumentEvidenceKind,
  type DocumentEvidenceUnit,
  type DocumentIntelligenceArtifact,
} from "@/lib/server/document-intelligence/types";
import { normalizeNorwegianTextForSearch } from "@/lib/server/document-intelligence/norwegian-language";
import type { ProjectDocumentStructureEntry } from "@/lib/types";

const MAX_EVIDENCE_UNITS = 240;
const EVIDENCE_CATEGORY_RESERVE = 6;
const COVERAGE_TEXT_CHARS = 140;
const COVERAGE_REFERENCE_CHARS = 80;
const DEFAULT_ANALYSIS_CONTEXT_CHARS = 18_000;

const EVIDENCE_RULES: Array<{
  kind: DocumentEvidenceKind;
  pattern: RegExp;
  signal: string;
}> = [
  {
    kind: "evaluation_criterion",
    pattern: /\b(?:evalueringskriter|tildelingskriter|award criteria|evaluation criteria|vekting|poengscore)\b/iu,
    signal: "evaluation-language",
  },
  {
    kind: "deadline",
    pattern: /\b(?:frist|deadline|tilbudsfrist|leveringsdato|oppstart|senest)\b/iu,
    signal: "deadline-language",
  },
  {
    kind: "commercial_term",
    pattern: /\b(?:pris|kostnad|budsjett|faktur|betaling|vederlag|opsjon|price|cost|commercial)\b/iu,
    signal: "commercial-language",
  },
  {
    kind: "risk",
    pattern: /\b(?:risiko|usikkerhet|konsekvens|sårbarhet|avvik|risk|threat)\b/iu,
    signal: "risk-language",
  },
  {
    kind: "dependency",
    pattern: /\b(?:avhengig|forutsetning|betinget av|integrasjon mot|dependency|prerequisite)\b/iu,
    signal: "dependency-language",
  },
  {
    kind: "architecture",
    pattern: /\b(?:arkitektur|plattform|integrasjon|grensesnitt|api|infrastruktur|sikkerhet|architecture)\b/iu,
    signal: "architecture-language",
  },
  {
    kind: "goal",
    pattern: /\b(?:mål|hensikt|formål|gevinst|effektmål|objective|outcome|benefit)\b/iu,
    signal: "goal-language",
  },
  {
    kind: "decision",
    pattern: /\b(?:beslutning|valgt|vedtatt|skal benytte|decision|selected)\b/iu,
    signal: "decision-language",
  },
  {
    kind: "requirement",
    pattern: /\b(?:krav|skal|må|shall|must|required|requirement)\b/iu,
    signal: "requirement-language",
  },
];

function normalizedEvidenceText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function evidenceSegments(text: string, preserveRow: boolean) {
  const normalized = normalizedEvidenceText(text);
  if (!normalized) return [];
  if (preserveRow || normalized.length <= 900) return [normalized];

  const sentences = normalized.match(/[^.!?;]+(?:[.!?;]+|$)/gu) ?? [normalized];
  const segments: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = [current, sentence.trim()].filter(Boolean).join(" ");
    if (candidate.length > 1_200 && current) {
      segments.push(current);
      current = sentence.trim();
    } else {
      current = candidate;
    }
  }
  if (current) segments.push(current);
  return segments;
}

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function analysisContextLimit() {
  const configured = Number(process.env.DOCUMENT_INTELLIGENCE_CONTEXT_CHARS);
  return Number.isFinite(configured) && configured >= 4_000
    ? Math.min(40_000, Math.floor(configured))
    : DEFAULT_ANALYSIS_CONTEXT_CHARS;
}

function classifyEvidence(text: string, isTable: boolean) {
  const matches = EVIDENCE_RULES.filter((rule) => rule.pattern.test(text));
  if (!matches.length && isTable) {
    return [{ kind: "table" as const, signal: "structured-table" }];
  }
  return matches;
}

function evidencePriority(kind: DocumentEvidenceKind) {
  return {
    evaluation_criterion: 10,
    requirement: 9,
    deadline: 8,
    commercial_term: 7,
    risk: 6,
    dependency: 5,
    architecture: 4,
    goal: 3,
    decision: 2,
    table: 1,
  }[kind];
}

function orderEvidenceUnits(evidence: DocumentEvidenceUnit[]) {
  return [...evidence].sort((left, right) => {
    const priority = evidencePriority(right.kind) - evidencePriority(left.kind);
    if (priority !== 0) return priority;
    return (left.provenance.page ?? Number.MAX_SAFE_INTEGER) -
      (right.provenance.page ?? Number.MAX_SAFE_INTEGER);
  });
}

function selectEvidenceWithCategoryCoverage(
  evidence: DocumentEvidenceUnit[],
) {
  const ordered = orderEvidenceUnits(evidence);
  const selectedIds = new Set<string>();
  const kinds = [...new Set(ordered.map((unit) => unit.kind))].sort(
    (left, right) => evidencePriority(right) - evidencePriority(left),
  );

  for (const kind of kinds) {
    let reserved = 0;
    for (const unit of ordered) {
      if (unit.kind !== kind || selectedIds.has(unit.id)) continue;
      selectedIds.add(unit.id);
      reserved += 1;
      if (reserved >= EVIDENCE_CATEGORY_RESERVE) break;
    }
  }

  for (const unit of ordered) {
    if (selectedIds.size >= MAX_EVIDENCE_UNITS) break;
    selectedIds.add(unit.id);
  }

  return ordered.filter((unit) => selectedIds.has(unit.id));
}

function compactCoverageValue(value: string, limit: number) {
  const normalized = normalizedEvidenceText(value);
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function buildAnalysisContext(input: {
  title: string;
  fileName: string;
  parserUsed: string;
  qualityScore: number;
  recommendVisionReview: boolean;
  evidence: DocumentEvidenceUnit[];
}) {
  const groups = new Map<
    string,
    {
      text: string;
      provenance: DocumentEvidenceUnit["provenance"];
      kinds: Set<DocumentEvidenceKind>;
    }
  >();
  for (const unit of input.evidence) {
    const key = `${unit.normalizedText}\n${unit.provenance.reference}\n${unit.provenance.page ?? ""}`;
    const group = groups.get(key) ?? {
      text: unit.text,
      provenance: unit.provenance,
      kinds: new Set<DocumentEvidenceKind>(),
    };
    group.kinds.add(unit.kind);
    groups.set(key, group);
  }

  const lines = [
    `DOKUMENT: ${input.title} (${input.fileName})`,
    `PARSER: ${input.parserUsed}; KVALITET: ${input.qualityScore.toFixed(3)}`,
    input.recommendVisionReview
      ? "VERIFIKASJON: Dokumentet viser til visuelle elementer som bør granskes separat."
      : "VERIFIKASJON: Ingen uløste visuelle referanser ble prioritert.",
  ];

  const orderedGroups = [...groups.values()].sort((left, right) => {
    const leftPriority = Math.max(...[...left.kinds].map(evidencePriority));
    const rightPriority = Math.max(...[...right.kinds].map(evidencePriority));
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return (left.provenance.page ?? Number.MAX_SAFE_INTEGER) -
      (right.provenance.page ?? Number.MAX_SAFE_INTEGER);
  });
  const evidenceKinds = [...new Set(input.evidence.map((unit) => unit.kind))].sort(
    (left, right) => evidencePriority(right) - evidencePriority(left),
  );
  const coverageGroups = evidenceKinds.flatMap((kind) => {
    const group = orderedGroups.find((candidate) => candidate.kinds.has(kind));
    return group ? [group] : [];
  });
  const uniqueCoverageGroups = [...new Set(coverageGroups)];
  if (uniqueCoverageGroups.length) {
    lines.push("KATEGORIDEKNING:");
    for (const group of uniqueCoverageGroups) {
      const page = group.provenance.page ? `, side ${group.provenance.page}` : "";
      const kinds = [...group.kinds]
        .sort((left, right) => evidencePriority(right) - evidencePriority(left))
        .map((kind) => kind.toUpperCase())
        .join(", ");
      lines.push(
        `- [${kinds}] ${compactCoverageValue(group.text, COVERAGE_TEXT_CHARS)} (kilde: ${compactCoverageValue(group.provenance.reference, COVERAGE_REFERENCE_CHARS)}${page})`,
      );
    }
    lines.push("PRIORITERT EVIDENS:");
  }

  for (const group of orderedGroups) {
    const page = group.provenance.page ? `, side ${group.provenance.page}` : "";
    const kinds = [...group.kinds]
      .sort((left, right) => evidencePriority(right) - evidencePriority(left))
      .map((kind) => kind.toUpperCase())
      .join(", ");
    lines.push(
      `- [${kinds}] ${group.text} (kilde: ${group.provenance.reference}${page})`,
    );
  }

  const joined = lines.join("\n");
  const limit = analysisContextLimit();
  return joined.length <= limit
    ? joined
    : `${joined.slice(0, Math.max(0, limit - 72)).trimEnd()}\n[avkortet evidenskontekst]`;
}

export function compileDocumentIntelligenceArtifact(input: {
  documentId: string;
  projectId: string;
  title: string;
  fileName: string;
  fileFormat: string;
  fileSizeBytes: number;
  sourceRevision: number;
  parserUsed: string;
  rawText: string;
  structureMap: unknown;
  isHighImpactDocument: boolean;
  azureAvailable?: boolean;
  doclingAvailable?: boolean;
  compiledAt?: string;
}): DocumentIntelligenceArtifact {
  const structureMap = normalizeDocumentChunkStructureMap(input.structureMap);
  const routing = chooseDocumentParserRoute({
    rawText: input.rawText,
    sourceMap: structureMap,
    fileFormat: input.fileFormat,
    fileSizeBytes: input.fileSizeBytes,
    parserUsed: input.parserUsed,
    isHighImpactDocument: input.isHighImpactDocument,
    azureAvailable: input.azureAvailable ?? false,
    doclingAvailable: input.doclingAvailable ?? false,
  });
  const sources: ProjectDocumentStructureEntry[] = structureMap.length
    ? structureMap
    : input.rawText
        .split(/\n{2,}/u)
        .map((text, index) => ({
          reference: `${input.title} avsnitt ${index + 1}`,
          text,
          kind: "text" as const,
          parser: input.parserUsed,
        }));
  const evidenceByFingerprint = new Map<string, DocumentEvidenceUnit>();

  for (const entry of sources) {
    const isTable =
      entry.kind === "table" || entry.kind?.includes("table") === true;
    for (const text of evidenceSegments(entry.text, isTable)) {
      if (text.length < 12) continue;
      const normalizedText = normalizeNorwegianTextForSearch(text);
      const classifications = classifyEvidence(normalizedText, isTable);
      for (const classification of classifications) {
      const fingerprint = stableHash(
        `${classification.kind}\n${normalizedText.toLocaleLowerCase("nb-NO")}\n${entry.reference}`,
      );
      if (evidenceByFingerprint.has(fingerprint)) continue;
      const id = `ev_${fingerprint.slice(0, 16)}`;
      evidenceByFingerprint.set(fingerprint, {
        id,
        kind: classification.kind,
        text: text.slice(0, 1_800),
        normalizedText: normalizedText.slice(0, 1_800),
        provenance: {
          reference: entry.reference || input.title,
          page: entry.page ?? null,
          parser: entry.parser ?? input.parserUsed,
          sourceKind: entry.kind ?? "raw_text",
          ...(entry.source_id ? { sourceId: entry.source_id } : {}),
          ...(entry.role ? { role: entry.role } : {}),
          ...(entry.confidence != null ? { confidence: entry.confidence } : {}),
          ...(entry.polygon?.length ? { polygon: entry.polygon } : {}),
          ...(entry.heading_path?.length
            ? { headingPath: entry.heading_path }
            : {}),
        },
        signals: [classification.signal],
      });
      }
    }
  }

  const evidence = selectEvidenceWithCategoryCoverage([
    ...evidenceByFingerprint.values(),
  ]);
  const evidenceCounts = evidence.reduce<
    DocumentIntelligenceArtifact["evidenceCounts"]
  >((counts, unit) => {
    counts[unit.kind] = (counts[unit.kind] ?? 0) + 1;
    return counts;
  }, {});
  const analysisContext = buildAnalysisContext({
    title: input.title,
    fileName: input.fileName,
    parserUsed: input.parserUsed,
    qualityScore: routing.quality.score,
    recommendVisionReview: routing.recommendVisionReview,
    evidence,
  });

  return {
    schemaVersion: DOCUMENT_INTELLIGENCE_SCHEMA_VERSION,
    compilerVersion: DOCUMENT_INTELLIGENCE_COMPILER_VERSION,
    documentId: input.documentId,
    projectId: input.projectId,
    title: input.title,
    fileName: input.fileName,
    sourceRevision: input.sourceRevision,
    contentHash: stableHash(
      `${input.rawText}\n${JSON.stringify(structureMap)}\n${DOCUMENT_INTELLIGENCE_COMPILER_VERSION}`,
    ),
    compiledAt: input.compiledAt ?? new Date().toISOString(),
    parserUsed: input.parserUsed,
    routing,
    evidence,
    evidenceCounts,
    analysisContext,
  };
}
