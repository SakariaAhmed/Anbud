import { reviewStructuredOutputEvidence } from "@/lib/server/output-source-evidence";
import { selectRequirementRegenerationLedger, mergeRegeneratedRequirementRows } from "@/lib/server/ai/requirement-response-regeneration";
import "server-only";

import { isRequirementDocument } from "@/lib/document-processing";
import { isMarkdownTableDivider } from "@/lib/markdown-table-row";
import { formatJobProgress } from "@/lib/project-job-progress";

import { narrativeAnswerEvidence } from "@/lib/server/requirements/narrative-answer-evidence";

import {
  createJsonCompletion,
  createJsonCompletionWithFileInputs,
  getClient,
  supportsCustomTemperature,
} from "@/lib/server/ai/completion";
import {
  compactText,
  documentContext,
  retrievedSnippetContext,
  summarizeCustomerAnalysis,
  summarizeSolutionEvaluation,
  solutionEvaluationRetrievalTerms,
} from "@/lib/server/ai/context";

import { stripCustomerAnalysisHistory } from "@/lib/customer-analysis-history";

import { isAiCallTimeoutError, runStructuredJsonResponse } from "@/lib/server/ai/json-completion";
import {
  ANALYSIS_MODEL,
  ANALYSIS_REASONING_EFFORT,
  DOCUMENT_ANALYSIS_MODEL,
  EVALUATION_REASONING_EFFORT,
  FAST_MODEL,
  FAST_REASONING_EFFORT,
  solutionEvaluationReasoningEffort,
} from "@/lib/server/ai/model-config";
import { extractExactRetrievalTerms } from "@/lib/server/ai/retrieval-query";
import { documentedMigrationControl } from "@/lib/server/ai/verified-foundation-controls";
import { buildImmutableRequirementRowManifest } from "@/lib/server/artifact-validation";
import { retrieveDocumentSnippetsWithMetadata } from "@/lib/server/document-chunks";
import { customerAnalysisPipeline } from "@/lib/server/document-intelligence/config";
import {
  resolveCustomerAnalysisContexts,
} from "@/lib/server/document-intelligence/customer-analysis-contexts";
import {
  customerAnalysisRegenerationContract,
  mergeCustomerAnalysisSectionPatch,
} from "@/lib/server/document-intelligence/customer-analysis-fields";
import {
  normalizeCustomerAnalysisResult,
  normalizeMermaidDiagram,
  selectServiceRecommendationCandidates,
} from "@/lib/server/document-intelligence/customer-analysis-postprocess";
import {
  buildCustomerAnalysisV3SystemPrompt,
  buildCustomerAnalysisV3UserPrompt,
  CUSTOMER_ANALYSIS_V3_JSON_SCHEMA,
  customerAnalysisV3ContextUsage,
  enrichCustomerAnalysisWithCriticalFacts,
} from "@/lib/server/document-intelligence/customer-analysis-v3";
import {
  stringFields,
  stringList,
  stringOr,
  type Untrusted,
  untrustedObject,
  untrustedRows,
} from "@/lib/unknown-values";

import { recordDocumentIntelligenceEvent } from "@/lib/server/document-intelligence/repository";

import {
  capNormalizedList,
  dedupeSummary,
  escapeRegExp,
  isNearDuplicate,
  normalizeComparableText,
  splitIntoSentences,
  tokenizeComparableText,
} from "@/lib/server/document-intelligence/text-normalization";
import { normalizeValueOpportunities } from "@/lib/server/document-intelligence/value-normalization";
import { buildOfferCoverageContext, buildOfferCoverageRetrievalSeed } from "@/lib/server/offer-coverage";

import {
  assertProjectWorkflowActive,
  boundedByProjectWorkflowDeadline,
} from "@/lib/server/project-workflow-cancellation";
import {
  buildCustomerAnalysisPrompt,
  buildDelimitedContext,
  buildGeneratorPrompt,
  buildHighLevelDesignPrompt,
  buildPromptTemplate,
  buildSolutionEvaluationPrompt,
} from "@/lib/server/prompts";
import { requirementCoverageSystemPrompt } from "@/lib/server/prompts/requirements";
import { WorkflowIncompleteError } from "@/lib/server/workflow-errors";

import { assertRequirementCoverageIntegrity } from "@/lib/server/requirements/evaluation-coverage-integrity";
import { criterionCoverageLostGoodRating, normalizeCriterionCoverage, reconcileCriterionCoverage } from "@/lib/server/ai/criterion-coverage";

import { assertRequirementLedgerQualityForEvaluation } from "@/lib/server/requirements/ledger-quality";
import { splitMarkdownTableRow } from "@/lib/server/requirements/markdown-table";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";
import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";

import {
  ArtifactFoundationFact,
  GeneratedArtifactDraft,
  ProjectArtifactGenerationInput,
  RequirementArtifactContext,
} from "@/lib/server/ai/artifact-generation-types";
import { buildDocumentTextChunks, MAX_DOCUMENT_CHUNKS } from "@/lib/server/ai/document-chunk-context";
import { boundedIntegerEnv, runWithProgressHeartbeat } from "@/lib/server/ai/generation-runtime";
import {
  assertRequirementCoverageBatchesSucceeded,
  assertRequirementCoverageItemsAreReviewable,
  bindVerifiedSolutionQuote,
  buildRequirementCoverageBatchRegistry,
  buildRequirementCoverageEvaluationContext,
  buildRequirementCoverageLedger,
  buildRequirementCoverageLedgerFromDocuments,
  buildRequirementCoverageRetrievalContext,
  buildRequirementCoverageSummary,
  coverageConfidenceFromLedger,
  coverageItemFromBatchRow,
  emptyRequirementCoverage,
  mapWithConcurrency,
  mergeRequirementCoverageLedgerWithSolutionAnswers,
  normalizedCoverageRef,
  normalizeSolutionRequirementCoverage,
  parsePositiveIntegerEnv,
  type RequirementCoverage,
  type RequirementCoverageBatchAnswer,
  requirementCoverageIdentityRef,
  type RequirementCoverageItem,
  requirementGenericStems,
  retryRequirementCoverageBatches,
  selectRequirementsForSolutionCoverage,
  solutionDocumentContainsQuote,
  suppressDuplicatedDocumentLedgerContext,
  validateRequirementCoverageBatchRows,
} from "@/lib/server/ai/requirement-coverage";
import { coverageEvidenceLinkTokens } from "@/lib/server/ai/requirement-evidence-tokens";
import { assessRequirementLedgerConfidence } from "@/lib/server/ai/requirement-ledger-confidence";
import {
  buildRequirementAnswerFoundation,
  buildRequirementArtifactContext,
  generateRequirementResponseFromLedger,
  withAlignedRequirementResponse,
} from "@/lib/server/ai/requirement-response";
import {
  REQUIREMENT_COVERAGE_FULL_SOLUTION_MAX_CHARS,
  solutionDocumentFitsRequirementPrompt,
} from "@/lib/server/ai/solution-document-context";
import {
  dedupeRequirementLedger,
  normalizeCoverageEvidenceText,
} from "@/lib/server/requirements/pdf-layout-ledger";
import { sortRequirementLedgerInDocumentOrder } from "@/lib/server/requirements/presentation";
import { canonicalRequirementSourceDocuments } from "@/lib/server/requirements/source-readiness";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import { productionSafeErrorMessage, safeErrorTelemetry } from "@/lib/server/safe-errors";
import { buildSolutionEvaluationProvenance } from "@/lib/server/workflow-boundaries";
import type {
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  GeneratedArtifactType,
  ProjectDocumentDetail,
  ProjectServiceDescription,
  ServiceDocumentDetail,
  SolutionEvaluationResult,
} from "@/lib/types";

type DocumentInsightDigest = {
  document_summary: string;
  important_requirements: string[];
  implicit_needs: string[];
  risks: string[];
  evaluation_criteria: string[];
  architecture_and_solution_signals: string[];
  technologies_and_standards: string[];
  value_signals: string[];
  visual_or_table_notes: string[];
  source_references: string[];
};

type DocumentInsightCache = Map<string, Promise<string | null>>;

function parseRequirementCoverageBatchRows(
  value: unknown,
): RequirementCoverageBatchAnswer[] {
  return untrustedRows<RequirementCoverageBatchAnswer>(value).map((row) => ({
    ...(typeof row.nr === "number" ? { nr: row.nr } : {}),
    ...stringFields(row, [
      "ref",
      "assessment",
      "vurdering",
      "rationale",
      "begrunnelse",
      "evidence",
      "bevis",
      "recommendation",
      "anbefaling",
    ]),
  }));
}
declare global {
  var __anbudDocumentInsightCache: DocumentInsightCache | undefined;
}

const LARGE_DOCUMENT_ANALYSIS_THRESHOLD = 18000;
const DOCUMENT_INSIGHT_CACHE_MAX_ENTRIES = 200;
const CHUNK_CONCURRENCY = 3;
const REQUIREMENT_RESPONSE_FULL_DOCUMENT_TIMEOUT_MS = 220_000;
const REQUIREMENT_RESPONSE_FILE_INPUT_TIMEOUT_MS = 240_000;
// Coverage batches of 17-18 rows took 54-73 s against a 60 s timeout.
const REQUIREMENT_COVERAGE_BATCH_TIMEOUT_MS = boundedIntegerEnv(
  process.env,
  "REQUIREMENT_COVERAGE_BATCH_TIMEOUT_MS",
  150_000,
  30_000,
  600_000,
);
const REQUIREMENT_COVERAGE_RETRY_CONCURRENCY = boundedIntegerEnv(
  process.env,
  "REQUIREMENT_COVERAGE_RETRY_CONCURRENCY",
  3,
  1,
  6,
);
// Retries and the holistic call need time left after the first pass.
const REQUIREMENT_COVERAGE_BATCH_DEADLINE_RESERVE_MS = 420_000;
const REQUIREMENT_COVERAGE_RETRY_DEADLINE_RESERVE_MS = 240_000;
const SOLUTION_EVALUATION_DEADLINE_RESERVE_MS = 45_000;
const SOLUTION_EVALUATION_TIMEOUT_MS = boundedIntegerEnv(
  process.env,
  "SOLUTION_EVALUATION_TIMEOUT_MS",
  180_000,
  30_000,
  600_000,
);
const CUSTOMER_ANALYSIS_FULL_DOCUMENT_MAX_CHARS = boundedIntegerEnv(
  process.env,
  "CUSTOMER_ANALYSIS_FULL_DOCUMENT_MAX_CHARS",
  60_000,
  12_000,
  150_000,
);
const CUSTOMER_ANALYSIS_SUPPORTING_FULL_BUDGET_CHARS = 30_000;
const CUSTOMER_ANALYSIS_TIMEOUT_MS = boundedIntegerEnv(
  process.env,
  "CUSTOMER_ANALYSIS_TIMEOUT_MS",
  300_000,
  60_000,
  840_000,
);
const REQUIREMENT_COVERAGE_BATCH_SIZE = parsePositiveIntegerEnv(
  "REQUIREMENT_COVERAGE_BATCH_SIZE",
  10,
);
const REQUIREMENT_COVERAGE_BATCH_CHAR_BUDGET = parsePositiveIntegerEnv(
  "REQUIREMENT_COVERAGE_BATCH_CHAR_BUDGET",
  18_000,
);
const REQUIREMENT_COVERAGE_BATCH_CONCURRENCY = parsePositiveIntegerEnv(
  "REQUIREMENT_COVERAGE_BATCH_CONCURRENCY",
  4,
);

function getDocumentInsightCache() {
  if (!globalThis.__anbudDocumentInsightCache) {
    globalThis.__anbudDocumentInsightCache = new Map();
  }

  return globalThis.__anbudDocumentInsightCache;
}

export function rememberDocumentInsight(
  key: string,
  value: Promise<string | null>,
) {
  const cache = getDocumentInsightCache();
  cache.set(key, value);
  // A transient model failure must not be replayed for an unchanged document.
  value.catch(() => {
    if (cache.get(key) === value) {
      cache.delete(key);
    }
  });

  if (cache.size > DOCUMENT_INSIGHT_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  return value;
}

function serviceRecommendationContext(
  services: ProjectServiceDescription[] | undefined,
) {
  const candidates = selectServiceRecommendationCandidates(services);

  if (!candidates.length) {
    return buildDelimitedContext(
      "Tjenestekandidater",
      "Ingen tjenestekatalog er valgt eller tilgjengelig for prosjektet. Returner recommended_services som en tom liste.",
    );
  }

  return buildDelimitedContext(
    "Tjenestekandidater",
    JSON.stringify(
      candidates.map((service) => ({
        service_id: service.id,
        service_name: service.name,
        description: compactText(service.description, 900),
        selected_in_project: service.selected,
        heuristic_match_percent: service.recommendation_score,
        heuristic_reason: service.recommendation_reason,
        service_documents: service.documents.slice(0, 4).map((document) => ({
          document_id: document.id,
          title: document.title,
          file_name: document.file_name,
          ai_summary: compactText(document.ai_summary ?? "", 900),
        })),
      })),
    ),
  );
}

function serviceDocumentAsProjectDocument(
  document: ServiceDocumentDetail,
): ProjectDocumentDetail {
  return {
    id: document.id,
    project_id: "global-service-description",
    role: "supporting_document",
    supporting_subtype: null,
    title: document.title,
    file_name: document.file_name,
    file_format: document.file_format,
    content_type: document.content_type,
    file_size_bytes: document.file_size_bytes,
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: null,
    indexed_at: null,
    chunk_source_revision: document.chunk_source_revision,
    file_base64: document.file_base64,
    raw_text: document.raw_text,
    structure_map: document.structure_map,
    created_at: document.created_at,
    updated_at: document.updated_at,
  };
}

function requirementCoverageBatchModel(model?: string) {
  const normalized = model?.trim();
  if (!normalized || /(?:mini|nano)$/i.test(normalized)) {
    return ANALYSIS_MODEL;
  }

  return normalized;
}

const ARTIFACT_FOUNDATION_FACT_PATTERNS = [
  {
    label: "Omfang og migrering",
    pattern:
      /\b(hybrid|migration|migrat|moderni|applications|applikasjoner|waves?|bølger?|billing|outage|analytics|archive|on-?premise|on-?prem|landing zone|legacy|ERP|WMS|CRM|lager|logistikk|transport|distribusjon|filbaserte|integrasjoner|lokal infrastruktur|Microsoft|M365|Microsoft 365|Active Directory|\bAD\b|IaC|Infrastructure as Code)\b/i,
  },
  {
    label: "SLA og kontinuitet",
    pattern:
      /\b(RTO|RPO|failover|disaster recovery|beredskap|gjenoppretting(?:stid)?|tilgjengelighet)\b/i,
  },
  {
    label: "Leveransekrav og frister",
    pattern:
      /\b(deliverable|leveranse|frist|deadline|due|D[1-9]|april|mai|may|juni|june|september|desember|december|20\d{2})\b/i,
  },
  {
    label: "Kommersielle rammer",
    pattern:
      /\b(EUR|NOK|budget|budsjett|Net\s*\d+|payment terms|betaling|pris|pricing|fixed price|fastpris|managed service fee|currency|index)\b/i,
  },
  {
    label: "Sikkerhet og etterlevelse",
    pattern:
      /\b(Microsoft|Azure|Entra|M365|Microsoft 365|Active Directory|\bAD\b|MFA|flerfaktor|RBAC|rollebasert|conditional access|customer-managed|kundestyrt|CIS|SOC|OT|encryption|kryptering|compliance|vulnerability|sårbarhet|herding|sikkerhet|logging|sporbarhet|policy|governance|backup|overvåkning|IaC|Infrastructure as Code)\b/i,
  },
  {
    label: "Avklaringer og risiko",
    pattern:
      /\b(clarification|avklaring|TBD|unclear|risiko|risk|penalty|sanksjon|dependency|avhengighet|ansvar|responsibility|database|workload|refactor|rehost|priority|scope|API|renewal)\b/i,
  },
] as const;

const ARTIFACT_FOUNDATION_FACT_STOP_WORDS = new Set([
  "skal",
  "must",
  "shall",
  "with",
  "from",
  "this",
  "that",
  "the",
  "and",
  "eller",
  "for",
  "med",
  "til",
  "som",
  "det",
  "den",
  "kunden",
  "leverandor",
  "leverandoren",
]);

function factCandidateFragments(value: string) {
  // A wrapped PDF line continues the sentence above it when it starts in
  // lower case or carries on a number ("ISO/IEC" / "27001:2022."). Other
  // lines (a timetable entry, "Avtalens maksimale verdi er NOK 18 400 000"),
  // table rows and page markers stand alone, so no fact runs into the next.
  const logicalLines: string[] = [];
  for (const raw of value.slice(0, 80_000).replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const previous = logicalLines.at(-1) ?? "";
    const numberedTitle = /^\d{1,3}(?:\.\d{1,3})*\.?\s+(\p{Lu}.*)$/u.exec(line)?.[1];
    const isNumberedHeading = numberedTitle !== undefined &&
      numberedTitle.length <= 100 && numberedTitle.split(/\s+/u).length <= 10 &&
      !/[,.;:!?]/u.test(numberedTitle) &&
      !/^\d{1,2}\.\s+(?:januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)\s+\d{4}\b/iu.test(line);
    if (!line || /^\[\[SIDE:\d+\]\]$/u.test(line)) {
      logicalLines.push("");
    } else if (
      previous &&
      !/^(?:Rad\s+\d+:|\|)/u.test(line) &&
      !/^(?:Rad\s+\d+:|\|)/u.test(previous) &&
      (/^\p{Ll}/u.test(line) || (/^\d/u.test(line) && /\p{L}$/u.test(previous) && !isNumberedHeading))
    ) {
      logicalLines[logicalLines.length - 1] = `${previous} ${line}`;
    } else {
      logicalLines.push(line);
    }
  }
  const lineFragments = logicalLines.filter((line) => line.length >= 18 && line.length <= 800);
  const sentenceFragments = logicalLines
    .flatMap((line) => splitIntoSentences(line))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 18 && sentence.length <= 800);

  return [...lineFragments, ...sentenceFragments];
}

function selectDistributedFacts(
  facts: ArtifactFoundationFact[],
  limit: number,
) {
  if (facts.length <= limit) return facts;
  if (limit <= 1) return facts.slice(0, Math.max(0, limit));

  const indexes = Array.from({ length: limit }, (_, index) =>
    Math.round((index * (facts.length - 1)) / (limit - 1)),
  );
  return indexes.map((index) => facts[index]);
}

export function collectArtifactFoundationFacts(input: {
  documents: ProjectDocumentDetail[];
  serviceDocuments: ProjectDocumentDetail[];
}) {
  const facts: ArtifactFoundationFact[] = [];
  const seen = new Set<string>();

  for (const document of [...input.documents, ...input.serviceDocuments]) {
    if (!document.raw_text.trim()) {
      continue;
    }

    for (const fragment of factCandidateFragments(document.raw_text).slice(0, 260)) {
      const match = ARTIFACT_FOUNDATION_FACT_PATTERNS.find((item) =>
        item.pattern.test(fragment),
      );
      if (!match) {
        continue;
      }

      const normalized = normalizeComparableText(fragment);
      const dedupeKey = `${match.label}:${normalized}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      facts.push({
        label: match.label,
        text: fragment,
        source: document.title,
      });
    }
  }

  const selected: ArtifactFoundationFact[] = [];
  for (const { label } of ARTIFACT_FOUNDATION_FACT_PATTERNS) {
    const limit =
      label === "Avklaringer og risiko"
        ? 8
        : label === "Omfang og migrering"
          ? 4
        : label === "Leveransekrav og frister" || label === "Kommersielle rammer"
          ? label === "Leveransekrav og frister"
            ? 8
            : 6
          : 3;
    selected.push(
      ...selectDistributedFacts(
        facts.filter((fact) => fact.label === label),
        limit,
      ),
    );
  }

  return selected.slice(0, 28);
}

function foundationFactTokens(value: string) {
  return tokenizeComparableText(value)
    .filter((token) => token.length >= 3 || /\d/.test(token))
    .filter((token) => !ARTIFACT_FOUNDATION_FACT_STOP_WORDS.has(token))
    .slice(0, 14);
}

function isFoundationFactRepresented(
  normalizedContent: string,
  fact: ArtifactFoundationFact,
) {
  const tokens = foundationFactTokens(fact.text);
  if (!tokens.length) {
    return false;
  }

  const hits = tokens.filter((token) => normalizedContent.includes(token)).length;
  return hits >= Math.min(4, Math.ceil(tokens.length * 0.55));
}

function buildProjectDesignFactsContext(facts: ArtifactFoundationFact[]) {
  if (!facts.length) {
    return "";
  }

  return buildDelimitedContext(
    "Dokumenterte design- og gjennomføringsføringer",
    [
      "Bruk disse føringene aktivt når de påvirker high-level design, operasjonsmodell eller gjennomføringsrisiko. Ikke legg dem i diagrammet hvis de bare er kommersielle eller kontraktuelle.",
      ...facts.map(
        (fact) => `- ${fact.label}: ${fact.text} (Kilde: ${fact.source})`,
      ),
    ].join("\n"),
  );
}

function buildCustomerAnalysisFactsContext(facts: ArtifactFoundationFact[]) {
  if (!facts.length) {
    return "";
  }

  return buildDelimitedContext(
    "Dokumenterte anskaffelsesføringer for kundeanalyse",
    [
      "Bruk disse føringene som sjekkliste for kundeanalyse, risiko, avklaringer, evalueringssignaler og operativ konklusjon. Ikke gjør dem om til en full kravtabell.",
      ...facts.map(
        (fact) => `- ${fact.label}: ${fact.text} (Kilde: ${fact.source})`,
      ),
    ].join("\n"),
  );
}

function buildSolutionEvaluationFactsContext(facts: ArtifactFoundationFact[]) {
  if (!facts.length) {
    return "";
  }

  return buildDelimitedContext(
    "Dokumenterte krav, føringer og avklaringer for løsningsvurdering",
    [
      "Bruk disse punktene som kildekontroll når du vurderer løsningens dekning. Skille strengt mellom eksplisitte krav, kommersielle føringer og avklarings-/risikopunkter.",
      "Punkter merket Avklaringer og risiko skal omtales som avklaringsbehov eller risikodrivere, ikke som etablerte kundekrav med mindre teksten selv bruker skal/must/shall.",
      ...facts.map(
        (fact) => `- ${fact.label}: ${fact.text} (Kilde: ${fact.source})`,
      ),
    ].join("\n"),
  );
}

function factsText(facts: ArtifactFoundationFact[]) {
  return facts.map((fact) => fact.text).join("\n");
}

function factsInclude(facts: ArtifactFoundationFact[], pattern: RegExp) {
  return pattern.test(factsText(facts));
}

function documentedContinuityControlText(facts: ArtifactFoundationFact[]) {
  const source = documentedFactText(
    facts,
    /\b(SLA|RTO|RPO|failover|disaster recovery|beredskap|backup|gjenoppretting(?:stid)?|tilgjengelighet|nedetid|tjenestenivå)\b/i,
  );
  // Keep each target with its scope instead of combining the first RTO and
  // RPO from unrelated systems or inventing an unspecified-target warning.
  return source ? `Kontinuitetskrav fra kildene: ${source}` : "";
}

function hasDocumentedCommercialTerms(facts: ArtifactFoundationFact[]) {
  return factsInclude(
    facts,
    /\b((?:EUR|NOK)\s*\d|(?:\d+[,.]\d+|\d+)\s*(?:million|mill\.|m\b)|budget ceiling|budsjettak|Net\s*\d+|payment terms|betalingsvilkår|fixed price|fastpris|monthly fee|månedspris)\b/i,
  );
}

function documentedFactText(facts: ArtifactFoundationFact[], pattern: RegExp) {
  return facts
    .filter((fact) => pattern.test(fact.text))
    .map((fact) => fact.text)
    .slice(0, 6)
    .join(" ");
}

function documentedDeliverableControlText(facts: ArtifactFoundationFact[]) {
  const source = documentedFactText(
    facts,
    /\b(D\d+|deliverable|leveranse|milestone|milepæl|frist|deadline)\b/i,
  );
  if (!source) {
    return "";
  }

  return `Dokumenterte leveransekrav og rammer må styre plan og evalueringsbevis: ${source}`;
}

function documentedCommercialControlText(facts: ArtifactFoundationFact[]) {
  if (!factsInclude(facts, /\b(EUR|NOK|budget|budsjett|Net\s*\d+|payment terms|betalingsvilkår|pricing|pris|fixed price|fastpris|monthly fee|månedspris)\b/i)) {
    return "";
  }

  const controls = documentedFactText(
    facts,
    /\b(EUR|NOK|budget|budsjett|Net\s*\d+|payment terms|betalingsvilkår|pricing|pris|fixed price|fastpris|monthly fee|månedspris)\b/i,
  );

  if (controls && hasDocumentedCommercialTerms(facts)) {
    return `Kommersielt må tilbudet være evaluerbart mot dokumenterte kildefakta: ${controls}`;
  }

  return "Kommersielle rammer som budsjett, betalingsvilkår, bindende prisstruktur og eventuelle frister er ikke dokumentert presist i grunnlaget og må håndteres som avklaringer/forutsetninger.";
}

function documentedRiskControlText(facts: ArtifactFoundationFact[]) {
  if (
    !factsInclude(
      facts,
      /\b(SOC|telemetry|telemetri|penalty|sanksjon|database|workload|refactor|refaktor|rehost|replatform|API|renewal|eldre|legacy|teknisk gjeld|filbaserte|nøkkelperson|begrenset intern kapasitet|driftsavbrudd|nedetid)\b/i,
    )
  ) {
    return "";
  }

  const risks = documentedFactText(
    facts,
    /\b(SOC|OT telemetry|penalty|Oracle|refactor|refaktor|rehost|replatform|merger|blackout|meter data|API|renewal|eldre|legacy|teknisk gjeld|filbaserte|nøkkelperson|begrenset intern kapasitet|driftsavbrudd|nedetid)\b/i,
  );

  return risks
    ? `Dokumenterte avklarings- og risikoforhold: ${risks}`
    : "";
}

function appendUniqueTextItems(
  items: string[],
  additions: string[],
  options?: { max?: number },
) {
  const result = [...items];
  for (const addition of additions) {
    const normalizedAddition = addition.replace(/\s+/g, " ").trim();
    if (!normalizedAddition) {
      continue;
    }
    if (
      result.some(
        (existing) =>
          isNearDuplicate(existing, normalizedAddition, 0.76) ||
          isFoundationFactRepresented(
            normalizeComparableText(existing),
            {
              label: "Sjekk",
              text: normalizedAddition,
              source: "",
            },
          ),
      )
    ) {
      continue;
    }
    result.push(normalizedAddition);
  }
  return result.slice(0, options?.max ?? 10);
}
// Source fragments joined into "verified" priorities, criteria or solution
// direction mixed unrelated facts and superseded text ("Tilbudsfrist 3.
// november" after a correction), so the facts reach the analysis as prompt
// context only. Documented risk drivers remain a flagged addition.
export function enrichCustomerAnalysisWithFoundationFacts(
  result: Untrusted<CustomerAnalysisResult>,
  facts: ArtifactFoundationFact[],
): Untrusted<CustomerAnalysisResult> {
  const riskControl = documentedRiskControlText(facts);
  if (!riskControl) {
    return result;
  }

  return {
    ...result,
    risks_for_us: appendUniqueTextItems(stringList(result.risks_for_us), [riskControl], { max: 5 }),
  };
}

export function estimateRequirementCoveragePromptChars(
  entry: RequirementLedgerEntry,
  absoluteIndex = 0,
) {
  const registryChars = JSON.stringify(
    buildRequirementCoverageBatchRegistry([entry], absoluteIndex),
  ).length;
  const exactEvidenceChars = JSON.stringify([
    {
      nr: absoluteIndex + 1,
      ref: requirementCoverageIdentityRef(entry),
      source_document_id: entry.documentId,
      answer_document_id: entry.answerDocumentId,
      source_excerpt: entry.sourceExcerpt
        ? compactText(entry.sourceExcerpt, 1100)
        : undefined,
      answer_excerpt: entry.answerExcerpt
        ? compactText(entry.answerExcerpt, 700)
        : undefined,
    },
  ]).length;

  return registryChars + exactEvidenceChars;
}

export function chunkRequirementCoverage(
  entries: RequirementLedgerEntry[],
  options?: { maxRows?: number; charBudget?: number },
) {
  const maxRows = Math.max(
    1,
    Math.round(options?.maxRows ?? REQUIREMENT_COVERAGE_BATCH_SIZE),
  );
  const charBudget = Math.max(
    1,
    Math.round(options?.charBudget ?? REQUIREMENT_COVERAGE_BATCH_CHAR_BUDGET),
  );
  const chunks: Array<{
    startIndex: number;
    entries: RequirementLedgerEntry[];
    estimatedPromptChars: number;
  }> = [];

  let currentStartIndex = 0;
  let currentEntries: RequirementLedgerEntry[] = [];
  let currentChars = 0;
  const flush = () => {
    if (!currentEntries.length) {
      return;
    }
    chunks.push({
      startIndex: currentStartIndex,
      entries: currentEntries,
      estimatedPromptChars: currentChars,
    });
    currentEntries = [];
    currentChars = 0;
  };

  entries.forEach((entry, absoluteIndex) => {
    const entryChars = estimateRequirementCoveragePromptChars(
      entry,
      absoluteIndex,
    );
    if (
      currentEntries.length > 0 &&
      (currentEntries.length >= maxRows || currentChars + entryChars > charBudget)
    ) {
      flush();
      currentStartIndex = absoluteIndex;
    }
    if (!currentEntries.length) {
      currentStartIndex = absoluteIndex;
    }
    currentEntries.push(entry);
    currentChars += entryChars;
  });
  flush();

  if (chunks.some((chunk) => chunk.entries.length > maxRows)) {
    throw new Error("Kravvurderingens batchinndeling overskred radgrensen.");
  }

  return chunks;
}

// Exported for the coverage orchestration regression test.
// fallow-ignore-next-line unused-export
export async function buildSolutionRequirementCoverage(input: {
  projectName: string;
  solutionDocument: ProjectDocumentDetail;
  solutionRequirementLedger?: RequirementLedgerEntry[];
  sourceRequirementLedger?: RequirementLedgerEntry[];
  requirementDocuments?: ProjectDocumentDetail[];
  customerAnalysis: CustomerAnalysisResult;
  model?: string;
  onProgress?: (message: string) => void;
}) {
  const solutionLedger = input.solutionRequirementLedger?.length
    ? sortRequirementLedgerInDocumentOrder(
        dedupeRequirementLedger(input.solutionRequirementLedger),
      )
    : await buildRequirementCoverageLedger(input.solutionDocument);
  const requirementDocumentCandidates = (input.requirementDocuments ?? []).filter(
    (document) =>
      document.id !== input.solutionDocument.id &&
      isRequirementDocument(document),
  );
  const sourceRequirementDocuments = canonicalRequirementSourceDocuments({
    customerDocument:
      requirementDocumentCandidates.find(
        (document) => document.role === "primary_customer_document",
      ) ?? null,
    documents: requirementDocumentCandidates,
  });
  const sourceLedger = input.sourceRequirementLedger?.length
    ? sortRequirementLedgerInDocumentOrder(
        input.sourceRequirementLedger,
      )
    : sourceRequirementDocuments.length
      ? await buildRequirementCoverageLedgerFromDocuments(sourceRequirementDocuments)
      : [];
  if (sourceRequirementDocuments.length && !sourceLedger.length) {
    // The source builder permits an empty ledger only after validating the
    // original canonical identities and their withdrawal evidence.
    return emptyRequirementCoverage("Alle krav i kravgrunnlaget er trukket tilbake ved rettelse.");
  }
  const proseAnswers = narrativeAnswerEvidence(input.solutionDocument, sourceLedger);
  const proseIds = new Set(proseAnswers.map((entry) => normalizeRequirementId(entry.id)));
  const solutionAnswers = [
    ...solutionLedger.filter((entry) =>
      !proseIds.has(normalizeRequirementId(entry.id)) || Boolean(entry.answerExcerpt?.trim())),
    ...proseAnswers.filter((entry) => !solutionLedger.some((existing) =>
      normalizeRequirementId(existing.id) === normalizeRequirementId(entry.id) && existing.answerExcerpt?.trim())),
  ];
  const ledger = sourceLedger.length
    ? mergeRequirementCoverageLedgerWithSolutionAnswers({
        sourceRequirements: sourceLedger,
        solutionEntries: solutionAnswers,
      })
    : solutionLedger;
  const requirements = selectRequirementsForSolutionCoverage({
    ledger,
    hasExplicitSourceLedger: sourceLedger.length > 0,
  });
  const ledgerConfidence = assessRequirementLedgerConfidence({
    ledger: requirements,
    hasExplicitRequirementDocuments: sourceRequirementDocuments.length > 0,
    requirementDocuments: sourceRequirementDocuments.length
      ? sourceRequirementDocuments
      : [input.solutionDocument],
  });

  if (!requirements.length) {
    return emptyRequirementCoverage(
      "Fant ingen tydelige kravrader i Bilag 2-strukturen.",
    );
  }

  assertRequirementLedgerQualityForEvaluation(requirements, {
    stage: "requirement_coverage",
    documentTitle: input.solutionDocument.title,
  });

  const chunks = chunkRequirementCoverage(requirements);
  const coverageSystemPrompt = requirementCoverageSystemPrompt();
  const coverageModel = requirementCoverageBatchModel(input.model);
  // A solution document that fits is sent whole, once, in the cached shared
  // prefix: answers under other headings or inside tables are then visible
  // for every requirement, and retrieval excerpts would only repeat it.
  const fullSolutionContext =
    input.solutionDocument.raw_text.length <= REQUIREMENT_COVERAGE_FULL_SOLUTION_MAX_CHARS
      ? buildDelimitedContext(
          `Hele Bilag 2: ${input.solutionDocument.title}`,
          input.solutionDocument.raw_text,
        )
      : "";
  const coverageSharedPromptPrefix = [
    "Vurder kravene i JSON. Ikke legg til, fjern eller slå sammen krav.",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    buildDelimitedContext(
      "Kundekontekst for vurdering",
      summarizeCustomerAnalysisForRequirementCoverage(input.customerAnalysis),
    ),
    fullSolutionContext,
  ]
    .filter(Boolean)
    .join("\n\n");
  let completedBatches = 0;
  let completedCoverageRequirements = 0;
  input.onProgress?.(
    formatJobProgress(18, `Fant ${requirements.length} krav. Vurderer kravdekning i ${chunks.length} batcher ...`),
  );

  // Requirements whose answer was bound to a verified Bilag 2 quote; the
  // integrity check compares against these bound entries.
  const verifiedAnswerEntries = new Map<number, RequirementLedgerEntry>();
  const tenderGenericStems = requirementGenericStems(requirements);
  const evaluateCoverageChunk = async (
    chunk: (typeof chunks)[number],
    options: { reserveMs: number; maxRetries: number },
  ) => {
    const krav = buildRequirementCoverageBatchRegistry(
      chunk.entries,
      chunk.startIndex,
    );
    const excerpts = await buildRequirementCoverageRetrievalContext({
      entries: chunk.entries,
      solutionDocument: input.solutionDocument,
      startIndex: chunk.startIndex,
      fullSolutionDocumentIncluded: Boolean(fullSolutionContext),
    });
    // Retrieval time counts against the deadline: size the model call after it.
    const timeoutMs = boundedByProjectWorkflowDeadline(
      REQUIREMENT_COVERAGE_BATCH_TIMEOUT_MS,
      { reserveMs: options.reserveMs },
    );
    if (timeoutMs === null) {
      throw new WorkflowIncompleteError(
        "Kravdekningen stoppet fordi jobbfristen nærmet seg før alle kravbatcher kunne vurderes. Prøv igjen om litt.",
      );
    }
    const generated = await createJsonCompletion<{
      rows?: RequirementCoverageBatchAnswer[];
    }>({
      system: coverageSystemPrompt,
      user: [
        coverageSharedPromptPrefix,
        excerpts,
        buildDelimitedContext("Krav som skal vurderes", JSON.stringify(krav)),
      ]
        .filter(Boolean)
        .join("\n\n"),
      userMessages: [
        coverageSharedPromptPrefix,
        [
          excerpts,
          buildDelimitedContext("Krav som skal vurderes", JSON.stringify(krav)),
        ]
          .filter(Boolean)
          .join("\n\n"),
      ].filter(Boolean),
      temperature: 0,
      model: coverageModel,
      reasoningEffort: EVALUATION_REASONING_EFFORT,
      timeoutMs,
      maxRetries: options.maxRetries,
      promptCacheKey: "requirement-coverage-batch",
    });
    const rows = validateRequirementCoverageBatchRows({
      rows: parseRequirementCoverageBatchRows(generated.rows),
      entries: chunk.entries,
      startIndex: chunk.startIndex,
    });
    // Why rows end up without a bound answer, as counts only: a quote the
    // model did not give, one not found verbatim in Bilag 2, or one found
    // but not tied to the requirement.
    const binding = { model_mangler: 0, no_quote: 0, quote_not_found: 0, quote_unbound: 0, bound: 0, bound_uncertain: 0 };
    const items = chunk.entries.map((entry, localIndex) => {
      const modelRow = rows[localIndex];
      const orderIndex = chunk.startIndex + localIndex;
      const modelQuote = modelRow?.evidence ?? modelRow?.bevis;
      const verified = bindVerifiedSolutionQuote({
        entry,
        quote: modelRow?.evidence ?? modelRow?.bevis,
        assessment: modelRow?.assessment ?? modelRow?.vurdering,
        solutionDocument: input.solutionDocument,
        genericStems: tenderGenericStems,
      });
      if (verified) {
        verifiedAnswerEntries.set(orderIndex, verified.entry);
        binding[verified.uncertain ? "bound_uncertain" : "bound"] += 1;
      } else {
        verifiedAnswerEntries.delete(orderIndex);
        if ((modelRow?.assessment ?? modelRow?.vurdering) === "Mangler") binding.model_mangler += 1;
        else if (!String(modelQuote ?? "").trim()) binding.no_quote += 1;
        else if (!solutionDocumentContainsQuote(modelQuote, input.solutionDocument)) binding.quote_not_found += 1;
        else binding.quote_unbound += 1;
      }
      // An uncertain link (weak overlap or cut context) cannot carry "Godt".
      const row =
        verified?.uncertain &&
        (modelRow?.assessment ?? modelRow?.vurdering) === "Godt"
          ? {
              ...modelRow,
              assessment: "Uklart",
              vurdering: undefined,
              rationale: `Bilag 2-sitatet berører kravet, men koblingen er usikker og må kontrolleres. ${modelRow?.rationale ?? modelRow?.begrunnelse ?? ""}`.trim(),
            }
          : modelRow;
      const item = coverageItemFromBatchRow({
        row,
        entry: verified?.entry ?? entry,
        orderIndex,
      });
      // A quote found in Bilag 2 that could not be tied to the requirement
      // is not evidence that no answer exists; say what was checked.
      if (
        !verified &&
        item.assessment === "Mangler" &&
        (modelRow?.assessment ?? modelRow?.vurdering) !== "Mangler" &&
        solutionDocumentContainsQuote(modelRow?.evidence ?? modelRow?.bevis, input.solutionDocument)
      ) {
        return {
          ...item,
          rationale:
            "AI-vurderingen viste til et sitat som finnes i Bilag 2, men sitatet kunne ikke knyttes til dette kravet. Kontroller om kravet er besvart et annet sted.",
        };
      }
      return item;
    });
    console.info(
      JSON.stringify({
        event: "requirement_coverage_quote_binding",
        start_index: chunk.startIndex,
        count: chunk.entries.length,
        ...binding,
      }),
    );
    assertRequirementCoverageItemsAreReviewable(items);
    return items;
  };

  type CoverageChunk = (typeof chunks)[number];
  type CoverageItems = Awaited<ReturnType<typeof evaluateCoverageChunk>>;
  const evaluateWithinDeadline = (chunk: CoverageChunk, reserveMs: number) =>
    evaluateCoverageChunk(chunk, { reserveMs, maxRetries: 1 });
  const failedFirstPass: Array<{ chunk: CoverageChunk; timedOut: boolean }> = [];

  const batches = await mapWithConcurrency(
    chunks,
    REQUIREMENT_COVERAGE_BATCH_CONCURRENCY,
    async (chunk) => {
      let items: CoverageItems = [];
      try {
        items = await evaluateWithinDeadline(
          chunk,
          REQUIREMENT_COVERAGE_BATCH_DEADLINE_RESERVE_MS,
        );
      } catch (error) {
        assertProjectWorkflowActive();
        failedFirstPass.push({ chunk, timedOut: isAiCallTimeoutError(error) });
        console.info(
          JSON.stringify({
            event: "requirement_coverage_batch_fallback",
            ...safeErrorTelemetry(error),
            start_index: chunk.startIndex,
            count: chunk.entries.length,
            timed_out: isAiCallTimeoutError(error),
          }),
        );
      }
      completedBatches += 1;
      completedCoverageRequirements += chunk.entries.length;
      input.onProgress?.(
        formatJobProgress(
          Math.min(56, 18 + Math.round((completedBatches / chunks.length) * 38)),
          `Vurdert ${Math.min(
            requirements.length,
            completedCoverageRequirements,
          )} av ${requirements.length} krav ...`,
        ),
      );

      return items;
    },
  );

  // Retry each failed batch once, in parallel. A timed-out batch is retried
  // as two halves, which are faster than the original call.
  const retryChunks = failedFirstPass
    .sort((left, right) => left.chunk.startIndex - right.chunk.startIndex)
    .flatMap(({ chunk, timedOut }) => {
      if (!timedOut || chunk.entries.length < 2) return [{ parent: chunk, chunk }];
      const middle = Math.ceil(chunk.entries.length / 2);
      return [
        { parent: chunk, chunk: { ...chunk, entries: chunk.entries.slice(0, middle) } },
        {
          parent: chunk,
          chunk: {
            ...chunk,
            startIndex: chunk.startIndex + middle,
            entries: chunk.entries.slice(middle),
          },
        },
      ];
    });
  if (retryChunks.length) {
    input.onProgress?.(
      formatJobProgress(
        57,
        `Prøver ${failedFirstPass.length} feilede kravbatcher på nytt (${retryChunks.reduce((sum, retry) => sum + retry.chunk.entries.length, 0)} krav) ...`,
      ),
    );
  }
  const retryResults = await retryRequirementCoverageBatches(
    retryChunks,
    (retry) =>
      evaluateWithinDeadline(
        retry.chunk,
        REQUIREMENT_COVERAGE_RETRY_DEADLINE_RESERVE_MS,
      ),
    {
      concurrency: REQUIREMENT_COVERAGE_RETRY_CONCURRENCY,
      assertActive: assertProjectWorkflowActive,
    },
  );
  const recoveredBatches = new Map<number, CoverageItems>();
  const retryFailures: Array<{ startIndex: number; count: number; reason: string }> = [];
  for (const { chunk: parent } of failedFirstPass) {
    const parts = retryResults.filter((result) => result.batch.parent === parent);
    const failedPart = parts.find((result) => !result.ok);
    if (!parts.length || failedPart) {
      retryFailures.push({
        startIndex: parent.startIndex,
        count: parent.entries.length,
        reason: productionSafeErrorMessage(
          failedPart && !failedPart.ok ? failedPart.error : null,
          "Coverage-batch feilet også ved kontrollert nytt forsøk.",
        ),
      });
      for (const result of parts) {
        if (!result.ok) {
          console.info(
            JSON.stringify({
              event: "requirement_coverage_batch_retry_failed",
              ...safeErrorTelemetry(result.error),
              start_index: result.batch.chunk.startIndex,
              count: result.batch.chunk.entries.length,
            }),
          );
        }
      }
      continue;
    }
    recoveredBatches.set(
      parent.startIndex,
      parts
        .sort((left, right) => left.batch.chunk.startIndex - right.batch.chunk.startIndex)
        .flatMap((result) => (result.ok ? result.value : [])),
    );
    console.info(
      JSON.stringify({
        event: "requirement_coverage_batch_retry_succeeded",
        start_index: parent.startIndex,
        count: parent.entries.length,
        split: parts.length > 1,
      }),
    );
  }

  assertRequirementCoverageBatchesSucceeded(retryFailures, chunks.length);
  const items = batches.flatMap((batch, index) => {
    const chunk = chunks[index];
    return chunk
      ? recoveredBatches.get(chunk.startIndex) ?? batch
      : batch;
  });
  assertRequirementCoverageItemsAreReviewable(items);
  const coverage = normalizeSolutionRequirementCoverage({
    total_requirements: requirements.length,
    assessed_requirements: items.length,
    confidence: coverageConfidenceFromLedger(
      ledgerConfidence,
      items.length === requirements.length,
    ),
    coverage_summary: buildRequirementCoverageSummary(items),
    ledger_confidence: ledgerConfidence,
    items,
  });
  assertRequirementCoverageIntegrity({
    sourceLedger: requirements.map(
      (entry, index) => verifiedAnswerEntries.get(index) ?? entry,
    ),
    coverage,
  });
  return coverage;
}

function normalizeDocumentInsightDigest(
  value: Untrusted<DocumentInsightDigest> | null | undefined,
): DocumentInsightDigest {
  const source = value ?? {};
  return {
    document_summary: compactText(source.document_summary, 900),
    important_requirements: capNormalizedList(stringList(source.important_requirements), {
      max: 10,
    }),
    implicit_needs: capNormalizedList(stringList(source.implicit_needs), { max: 8 }),
    risks: capNormalizedList(stringList(source.risks), { max: 8 }),
    evaluation_criteria: capNormalizedList(stringList(source.evaluation_criteria), {
      max: 8,
    }),
    architecture_and_solution_signals: capNormalizedList(stringList(source.architecture_and_solution_signals),
      { max: 10 },
    ),
    technologies_and_standards: capNormalizedList(stringList(source.technologies_and_standards),
      { max: 12 },
    ),
    value_signals: capNormalizedList(stringList(source.value_signals), { max: 8 }),
    visual_or_table_notes: capNormalizedList(stringList(source.visual_or_table_notes), {
      max: 8,
    }),
    source_references: capNormalizedList(stringList(source.source_references), {
      max: 12,
    }),
  };
}

function shouldBuildDocumentInsightDigest(document: ProjectDocumentDetail) {
  return (
    document.raw_text.length > LARGE_DOCUMENT_ANALYSIS_THRESHOLD ||
    document.structure_map.length > 12
  );
}

function buildDocumentCoverageNotes(document: ProjectDocumentDetail) {
  const notes: string[] = [];
  const sparseEntries = document.structure_map.filter(
    (entry) => entry.text.trim().length > 0 && entry.text.trim().length < 180,
  );
  const emptyLikeCount = document.structure_map.filter(
    (entry) => !entry.text.trim(),
  ).length;

  if (sparseEntries.length || emptyLikeCount) {
    notes.push(
      "Noen sider/blokker har lite maskinlesbar tekst. Dersom disse inneholder grafer, bilder, skannede tabeller eller arkitekturfigurer, må funn verifiseres mot originaldokumentet eller OCR/vision legges til.",
    );
  }

  if (/\b(figur|figure|diagram|graf|graph|tabell|table|illustrasjon|arkitekturdiagram)\b/i.test(document.raw_text)) {
    notes.push(
      "Dokumentet refererer til figurer, grafer, diagrammer eller tabeller. Tekstanalysen bruker maskinlesbar tekst rundt disse elementene, ikke visuell tolking av selve bildet.",
    );
  }

  return notes;
}

async function buildDocumentInsightDigestUncached(
  label: string,
  document: ProjectDocumentDetail,
  options?: { force?: boolean; maxChunks?: number },
) {
  if (!options?.force && !shouldBuildDocumentInsightDigest(document)) {
    return null;
  }

  const chunks = buildDocumentTextChunks(document, {
    maxChunks: options?.maxChunks ?? MAX_DOCUMENT_CHUNKS,
  });

  if (!chunks.length) {
    return null;
  }

  const chunkPrompt = buildPromptTemplate({
    role: "Du er en nøyaktig dokumentanalytiker for tilbudsarbeid. Du leser én del av et større dokument og trekker ut bare konkrete, kildebaserte funn.",
    task: [
      "Analyser dokumentdelen og hent ut krav, implisitte behov, risiko, evalueringskriterier, løsningssignaler, teknologier og verdidrivere.",
      "Marker om teksten tyder på tabeller, grafer, figurer, bilder eller diagrammer som kan kreve manuell verifikasjon.",
      "Vær konservativ: ikke finn opp detaljer som ikke står i teksten.",
    ],
    rules: [
      "Returner kun gyldig JSON.",
      "Hold punktene korte, konkrete og kildetette.",
      "Ikke gjenta samme funn med små omskrivinger.",
      "Bruk source_references når funn kan knyttes til side, kapittel eller tekstblokk.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøklene document_summary, important_requirements, implicit_needs, risks, evaluation_criteria, architecture_and_solution_signals, technologies_and_standards, value_signals, visual_or_table_notes og source_references.",
      "Alle felt utenom document_summary skal være lister av strenger.",
    ],
    exampleOutput:
      '{"document_summary":"<tekstnært sammendrag av dokumentdelen>","important_requirements":["<krav eller føring>"],"implicit_needs":["<rimelig tolket behov>"],"risks":["<risiko>"],"evaluation_criteria":["<mulig evalueringskriterium>"],"architecture_and_solution_signals":["<løsningssignal>"],"technologies_and_standards":["<navngitt teknologi eller standard>"],"value_signals":["<verdisignal>"],"visual_or_table_notes":["<observasjon om tabell/figur>"],"source_references":["<kildehenvisning>"]}',
  });

  const chunkDigests = await mapWithConcurrency(
    chunks,
    CHUNK_CONCURRENCY,
    async (chunk) =>
      normalizeDocumentInsightDigest(
        await createJsonCompletion<Partial<DocumentInsightDigest>>({
          system: chunkPrompt,
          user: [
            buildDelimitedContext("Dokument", label),
            buildDelimitedContext("Kildereferanser", chunk.references.join("\n")),
            buildDelimitedContext("Dokumentdel", chunk.text),
          ].join("\n\n"),
          temperature: 0,
          model: FAST_MODEL,
          reasoningEffort: FAST_REASONING_EFFORT,
          promptCacheKey: "document-insight-digest",
        }),
      ),
  );

  const merged = normalizeDocumentInsightDigest({
    document_summary: chunkDigests
      .map((digest, index) => `Del ${index + 1}: ${digest.document_summary}`)
      .join("\n"),
    important_requirements: chunkDigests.flatMap(
      (digest) => digest.important_requirements,
    ),
    implicit_needs: chunkDigests.flatMap((digest) => digest.implicit_needs),
    risks: chunkDigests.flatMap((digest) => digest.risks),
    evaluation_criteria: chunkDigests.flatMap(
      (digest) => digest.evaluation_criteria,
    ),
    architecture_and_solution_signals: chunkDigests.flatMap(
      (digest) => digest.architecture_and_solution_signals,
    ),
    technologies_and_standards: chunkDigests.flatMap(
      (digest) => digest.technologies_and_standards,
    ),
    value_signals: chunkDigests.flatMap((digest) => digest.value_signals),
    visual_or_table_notes: [
      ...chunkDigests.flatMap((digest) => digest.visual_or_table_notes),
      ...buildDocumentCoverageNotes(document),
    ],
    source_references: chunkDigests.flatMap((digest) => digest.source_references),
  });

  return buildDelimitedContext(
    `${label} – bred dokumentdekning`,
    JSON.stringify(merged),
  );
}

async function buildDocumentInsightDigest(
  label: string,
  document: ProjectDocumentDetail,
  options?: { force?: boolean; maxChunks?: number },
) {
  if (!options?.force && !shouldBuildDocumentInsightDigest(document)) {
    return null;
  }

  const cacheKey = [
    label,
    document.id,
    document.updated_at,
    document.raw_text.length,
    options?.maxChunks ?? MAX_DOCUMENT_CHUNKS,
  ].join(":");
  const cache = getDocumentInsightCache();
  const cached = cache.get(cacheKey);

  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }

  return rememberDocumentInsight(
    cacheKey,
    buildDocumentInsightDigestUncached(label, document, options),
  );
}

function summarizeCustomerAnalysisForRequirementCoverage(
  analysis: CustomerAnalysisResult,
) {
  return JSON.stringify({
    customer_profile_summary: compactText(
      analysis.customer_profile_summary,
      240,
    ),
    customer_goals_summary: compactText(analysis.customer_goals_summary, 240),
    executive_summary: compactText(analysis.executive_summary, 280),
    expected_solution_direction: analysis.expected_solution_direction
      .slice(0, 4)
      .map((item) => compactText(item, 150)),
    prioritized_requirements: analysis.prioritized_requirements
      .slice(0, 6)
      .map((item) => ({
        requirement: compactText(item.requirement, 150),
        priority: item.priority,
        reason: compactText(item.reason, 140),
      })),
    implicit_requirements: analysis.implicit_requirements
      .slice(0, 6)
      .map((item) => ({
        title: compactText(item.title, 120),
        description: compactText(item.description, 150),
        importance: item.importance,
        source_reference: compactText(item.source_reference, 120),
      })),
    likely_evaluation_criteria: analysis.likely_evaluation_criteria
      .slice(0, 4)
      .map((item) => compactText(item, 150)),
    risks_for_customer: (analysis.risks_for_customer ?? analysis.risks)
      .slice(0, 4)
      .map((item) => compactText(item, 150)),
  });
}

function normalizeMarkdownText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitParagraphs(value: string) {
  return normalizeMarkdownText(value)
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function normalizeHighLevelDesignText(value: string) {
  const normalized = normalizeHighLevelDesignHeadings(
    normalizeMarkdownText(value),
  );
  if (!normalized) {
    return "";
  }

  if (/^##\s+\S/m.test(normalized)) {
    return normalized;
  }

  const paragraphs = splitParagraphs(normalized);
  const sentences = splitIntoSentences(normalized);
  if (paragraphs.length >= 3) {
    return [
      "## Målarkitektur",
      "",
      paragraphs[0],
      "",
      "## Sikkerhet og styring",
      "",
      paragraphs[1],
      "",
      "## Drift og gjennomføring",
      "",
      paragraphs.slice(2).join("\n\n"),
    ].join("\n");
  }

  if (sentences.length >= 4) {
    const firstCut = Math.max(1, Math.ceil(sentences.length * 0.4));
    const secondCut = Math.max(firstCut + 1, Math.ceil(sentences.length * 0.7));
    return [
      "## Målarkitektur",
      "",
      sentences.slice(0, firstCut).join(" "),
      "",
      "## Sikkerhet og styring",
      "",
      sentences.slice(firstCut, secondCut).join(" "),
      "",
      "## Drift og gjennomføring",
      "",
      sentences.slice(secondCut).join(" "),
    ].join("\n");
  }

  return ["## Målarkitektur", "", normalized].join("\n");
}

function normalizeHighLevelDesignHeadings(value: string) {
  const headings = [
    "Målarkitektur",
    "Sikkerhet og styring",
    "Drift og gjennomføring",
    "Avklaringer og forutsetninger",
  ];

  return headings.reduce((text, heading) => {
    const pattern = new RegExp(
      `(^|\\n)(##\\s+${escapeRegExp(heading)})(?:[ \\t]+)(?=[A-ZÆØÅ0-9])`,
      "g",
    );
    return text.replace(pattern, (_match, prefix: string, marker: string) => {
      return `${prefix}${marker}\n\n`;
    });
  }, value);
}

function highLevelDesignAdditionRepresented(text: string, addition: string) {
  const normalizedText = normalizeComparableText(text);
  const normalizedAddition = normalizeComparableText(addition);
  if (normalizedAddition && normalizedText.includes(normalizedAddition)) {
    return true;
  }

  const tokens = foundationFactTokens(addition);
  if (!tokens.length) {
    return false;
  }

  const hits = tokens.filter((token) => normalizedText.includes(token)).length;
  const requiredHits = Math.min(
    tokens.length,
    Math.max(6, Math.ceil(tokens.length * 0.75)),
  );
  return hits >= requiredHits;
}

function appendHighLevelDesignSection(
  value: string,
  heading: string,
  additions: string[],
) {
  const additionsToAppend = additions
    .map((addition) => addition.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((addition) => !highLevelDesignAdditionRepresented(value, addition));

  if (!additionsToAppend.length) {
    return value;
  }

  const marker = `## ${heading}`;
  const markerIndex = value.indexOf(marker);
  const additionBlock = [
    "",
    ...additionsToAppend.map((addition) => `- ${addition}`),
  ].join("\n");

  if (markerIndex < 0) {
    return `${value.trim()}\n\n${marker}${additionBlock}`;
  }

  const nextHeadingIndex = value
    .slice(markerIndex + marker.length)
    .search(/\n##\s+/);
  if (nextHeadingIndex < 0) {
    return `${value.trim()}${additionBlock}`;
  }

  const insertAt = markerIndex + marker.length + nextHeadingIndex;
  return `${value.slice(0, insertAt).trimEnd()}${additionBlock}\n\n${value
    .slice(insertAt)
    .trimStart()}`;
}

function enrichHighLevelDesignTextWithFoundationFacts(
  value: string,
  facts: ArtifactFoundationFact[],
) {
  let text = normalizeHighLevelDesignText(value);
  if (!facts.length || !text) {
    return text;
  }

  text = appendHighLevelDesignSection(text, "Målarkitektur", [
    documentedMigrationControl(facts),
  ]);
  text = appendHighLevelDesignSection(text, "Drift og gjennomføring", [
    documentedDeliverableControlText(facts),
    documentedContinuityControlText(facts),
  ]);
  text = appendHighLevelDesignSection(text, "Avklaringer og forutsetninger", [
    documentedCommercialControlText(facts),
    documentedRiskControlText(facts),
  ]);

  return normalizeMarkdownText(text);
}
function normalizeHighLevelDesignDiagram(input: {
  rawDiagram: string;
  designText: string;
  facts: ArtifactFoundationFact[];
}) {
  return normalizeMermaidDiagram(input.rawDiagram || "");
}
function coverageItemReferenceLabels(item: RequirementCoverageItem): string[] {
  const labels = [
    item.reference,
    item.full_reference,
    item.source_reference,
    item.requirement_subtitle,
    item.table_id ?? "",
  ]
    .map((value) => value?.replace(/\s+/g, " ").trim())
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(labels));
}

function isIdentifierLikeCoverageLabel(value: string) {
  const label = value
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:(?:R|K|T|REQ|ID)[-._/\s]+[A-Z0-9]+(?:[-._/][A-Z0-9]+)*|(?:R|K|T)\d+(?:[-._/]\d+)*|KRAV\s+(?:NR\.?\s*)?[A-Z0-9]+(?:[-._/][A-Z0-9]+)*|\d+(?:[-./]\d+)+)$/i.test(
    label,
  );
}

function identifierCoverageLabelMatchesText(label: string, text: string) {
  const canonical = (value: string) =>
    value
      .replace(/[‐‑‒–—]/g, "-")
      .replace(/\s*-\s*/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleUpperCase("nb");
  const canonicalLabel = canonical(label);
  const canonicalText = canonical(text);
  if (!canonicalLabel || !canonicalText) {
    return false;
  }
  if (canonicalLabel === canonicalText) {
    return true;
  }
  const flexibleLabel = escapeRegExp(canonicalLabel).replace(/ /g, "\\s+");
  return new RegExp(
    `(?:^|[\\s,;:|>()\\[\\]{}])${flexibleLabel}(?=$|[\\s,;:|<>()\\[\\]{}]|\\.(?=$|\\s))`,
    "u",
  ).test(canonicalText);
}

function coverageLabelMatchesText(label: string, text: string) {
  if (isIdentifierLikeCoverageLabel(label)) {
    return identifierCoverageLabelMatchesText(label, text);
  }

  const normalizedLabel = normalizeComparableText(label);
  if (!normalizedLabel) {
    return false;
  }

  const normalizedText = normalizeComparableText(text);
  if (normalizedLabel.length <= 3) {
    return normalizedText === normalizedLabel;
  }

  return (
    normalizedText === normalizedLabel ||
    ` ${normalizedText} `.includes(` ${normalizedLabel} `)
  );
}

type CoverageEvidenceIndexEntry = {
  item: RequirementCoverageItem;
  normalizedEvidence: string;
  tokens: Set<string>;
};

function buildCoverageEvidenceIndex(
  coverage: RequirementCoverage,
): CoverageEvidenceIndexEntry[] {
  return coverage.items
    .map((item) => {
      const normalizedEvidence = normalizeComparableText(item.evidence ?? "");
      return {
        item,
        normalizedEvidence,
        tokens: coverageEvidenceLinkTokens(normalizedEvidence),
      };
    })
    .filter((entry) => entry.normalizedEvidence.length >= 8);
}

function matchFindingEvidenceToCoverageItem(input: {
  evidence: string;
  evidenceIndex: CoverageEvidenceIndexEntry[];
}) {
  const normalizedEvidence = normalizeComparableText(input.evidence ?? "");
  const evidenceTokens = coverageEvidenceLinkTokens(normalizedEvidence);
  if (normalizedEvidence.length < 8) {
    return null;
  }

  const exactMatches = input.evidenceIndex.filter(
    (candidate) => candidate.normalizedEvidence === normalizedEvidence,
  );
  if (exactMatches.length === 1) {
    return exactMatches[0].item;
  }
  if (exactMatches.length > 1) {
    return null;
  }

  if (normalizedEvidence.length < 40 || evidenceTokens.size < 6) {
    return null;
  }

  const containmentMatches = input.evidenceIndex.filter(
    (candidate) =>
      candidate.normalizedEvidence.includes(normalizedEvidence) ||
      normalizedEvidence.includes(candidate.normalizedEvidence),
  );
  if (containmentMatches.length === 1) {
    return containmentMatches[0].item;
  }
  if (containmentMatches.length > 1) {
    return null;
  }

  const scoredMatches = input.evidenceIndex
    .map((candidate) => {
      let overlap = 0;
      for (const token of evidenceTokens) {
        if (candidate.tokens.has(token)) {
          overlap += 1;
        }
      }
      return {
        candidate,
        overlap,
        score: overlap / evidenceTokens.size,
      };
    })
    .filter((match) => match.overlap >= 6 && match.score >= 0.82)
    .sort((left, right) => right.score - left.score);
  if (!scoredMatches.length) {
    return null;
  }

  const [best, runnerUp] = scoredMatches;
  if (runnerUp && best.score - runnerUp.score < 0.08) {
    return null;
  }

  return best.candidate.item;
}

function isExplicitSectionFinding(
  finding: SolutionEvaluationResult["document_findings"][number],
) {
  return (
    finding.reference_match === "section" ||
    /^seksjonsfunn:/i.test(finding.reference?.trim() ?? "")
  );
}

function matchFindingToCoverageItem(input: {
  finding: SolutionEvaluationResult["document_findings"][number];
  coverage: RequirementCoverage;
}) {
  if (!input.coverage.items.length) {
    return null;
  }

  const normalizedReference = normalizedCoverageRef(
    input.finding.reference ?? "",
  );
  const exactReferenceMatches = input.coverage.items.filter((item) =>
    coverageItemReferenceLabels(item).some(
      (label) => normalizedCoverageRef(label) === normalizedReference,
    ),
  );
  if (exactReferenceMatches.length === 1) {
    return exactReferenceMatches[0];
  }
  if (exactReferenceMatches.length > 1) {
    return null;
  }

  const directMatches = input.coverage.items.filter((item) =>
    coverageItemReferenceLabels(item).some((label) =>
      coverageLabelMatchesText(label, input.finding.reference ?? ""),
    ),
  );
  if (directMatches.length === 1) {
    return directMatches[0];
  }
  if (directMatches.length > 1) {
    return null;
  }

  const broaderText = [
    input.finding.reference,
    input.finding.finding,
    input.finding.evidence,
  ]
    .filter(Boolean)
    .join(" ");

  const broaderMatches = input.coverage.items.filter((item) =>
    coverageItemReferenceLabels(item)
      .filter((label) => normalizedCoverageRef(label).length > 3)
      .some((label) => coverageLabelMatchesText(label, broaderText)),
  );
  return broaderMatches.length === 1 ? broaderMatches[0] : null;
}

function documentFindingEvidenceMatchesText(input: {
  evidence: string;
  documentText?: string;
}) {
  const evidence = normalizeCoverageEvidenceText(input.evidence);
  const documentText = normalizeCoverageEvidenceText(input.documentText ?? "");
  if (!documentText || evidence.length < 16) {
    return false;
  }

  return documentText.includes(evidence);
}

function groundedDocumentFindingEvidence(input: {
  candidate: unknown;
  documentText?: string;
}) {
  const candidate = compactText(input.candidate ?? "", 500);
  if (
    candidate &&
    documentFindingEvidenceMatchesText({
      evidence: candidate,
      documentText: input.documentText,
    })
  ) {
    return {
      evidence: candidate,
      evidence_grounding: "document_exact" as const,
    };
  }

  return { evidence: "" };
}

export function normalizeDocumentFindingsAgainstCoverage(
  findings: SolutionEvaluationResult["document_findings"],
  coverage: RequirementCoverage,
  options: { evidenceDocumentText?: string } = {},
): SolutionEvaluationResult["document_findings"] {
  const evidenceIndex = buildCoverageEvidenceIndex(coverage);
  return findings
    .map((item) => {
      const assessment =
        item.assessment === "Godt" ||
        item.assessment === "Dårlig" ||
        item.assessment === "Mangler" ||
        item.assessment === "Uklart"
          ? item.assessment
          : ("Uklart" as const);
      const explicitSectionFinding = isExplicitSectionFinding(item);
      const candidateEvidence = compactText(item.evidence ?? "", 500);
      // Local requirement IDs and supplier quotes can repeat across documents.
      // A precise source locator constrains evidence matching; it must not be
      // silently replaced with another document's otherwise identical quote.
      const normalizedReference = normalizedCoverageRef(item.reference ?? "");
      const qualifiedReferenceMatches = coverage.items.filter((candidate) =>
        [candidate.full_reference, candidate.source_reference].some((label) =>
          typeof label === "string" && label.length > 0 &&
          normalizedCoverageRef(label) !== normalizedCoverageRef(candidate.reference) &&
          normalizedCoverageRef(label) === normalizedReference,
        ),
      );
      const scopedEvidenceIndex = qualifiedReferenceMatches.length
        ? evidenceIndex.filter((entry) => qualifiedReferenceMatches.includes(entry.item))
        : evidenceIndex;
      const evidenceMatch = explicitSectionFinding
        ? null
        : matchFindingEvidenceToCoverageItem({
            evidence: candidateEvidence,
            evidenceIndex: scopedEvidenceIndex,
          });
      const directMatch =
        !explicitSectionFinding && !candidateEvidence
          ? matchFindingToCoverageItem({ finding: item, coverage })
          : null;
      const match = evidenceMatch ?? directMatch;
      const originalReference = compactText(item.reference, 220);

      if (match) {
        const exactCoverageEvidence = match.evidence?.trim()
          ? match.evidence
          : "";
        const groundedDocumentEvidence = groundedDocumentFindingEvidence({
          candidate: item.evidence,
          documentText: options.evidenceDocumentText,
        });
        return {
          reference: compactText(
            match.full_reference || match.source_reference || match.reference,
            700,
          ),
          reference_match: "coverage" as const,
          matched_requirement_reference: match.reference,
          assessment: match.assessment,
          finding: compactText(match.rationale, 500),
          ...(exactCoverageEvidence
            ? {
                evidence: exactCoverageEvidence,
                evidence_grounding: "coverage_exact" as const,
              }
            : groundedDocumentEvidence),
          recommendation: compactText(match.recommendation, 650),
        };
      }

      const hasCoverage = coverage.items.length > 0;
      const sectionReference =
        originalReference && !/^seksjonsfunn:/i.test(originalReference)
          ? `Seksjonsfunn: ${originalReference}`
          : originalReference || "Seksjonsfunn: arkitektløsningen generelt";
      const groundedDocumentEvidence = groundedDocumentFindingEvidence({
        candidate: item.evidence,
        documentText: options.evidenceDocumentText,
      });

      return {
        reference: hasCoverage
          ? compactText(sectionReference, 260)
          : originalReference,
        reference_match: hasCoverage ? ("section" as const) : undefined,
        matched_requirement_reference: null,
        assessment,
        finding: compactText(item.finding, 500),
        ...groundedDocumentEvidence,
        recommendation: compactText(item.recommendation, 650),
      };
    })
    .filter(
      (item) =>
        item.reference || item.finding || item.evidence || item.recommendation,
    )
    .slice(0, 6);
}

function normalizeSubstantiveDocumentFindingText(
  value: string | null | undefined,
) {
  return String(value ?? "")
    .replace(/[*_`#>]/gu, " ")
    .replace(/^[\s'"“”.,;:!?…()[\]{}<>]+/u, "")
    .replace(/[\s'"“”.,;:!?…()[\]{}<>]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedMarkdownHeaderKey(value: string) {
  return normalizeSubstantiveDocumentFindingText(value)
    .toLocaleLowerCase("nb-NO")
    .normalize("NFKC")
    .replace(/[^a-z0-9æøå]+/giu, "");
}

export function solutionDocumentAnswerBearingText(value: string) {
  const lines = String(value ?? "").split(/\r?\n/u);
  const answerRows: string[] = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes("|")) {
      continue;
    }
    const headers = splitMarkdownTableRow(lines[index]);
    const headerKeys = headers.map(normalizedMarkdownHeaderKey);
    const referenceIndex = headerKeys.findIndex((key) =>
      ["kravref", "kravreferanse", "reference", "ref"].includes(key),
    );
    const answerIndex = headerKeys.findIndex((key) =>
      ["svar", "besvarelse", "answer", "response"].includes(key),
    );
    const answerIndexes = headerKeys
      .map((key, cellIndex) =>
        [
          "svar",
          "besvarelse",
          "answer",
          "response",
          "svargrunnlag",
          "answerbasis",
          "evidence",
        ].includes(key)
          ? cellIndex
          : -1,
      )
      .filter((cellIndex) => cellIndex >= 0);
    if (
      referenceIndex < 0 ||
      answerIndex < 0 ||
      !isMarkdownTableDivider(lines[index + 1])
    ) {
      continue;
    }

    const separator = splitMarkdownTableRow(lines[index + 1]);
    if (separator.length < headers.length) {
      continue;
    }

    let rowIndex = index + 2;
    for (; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex];
      if (!line.trim() || !line.includes("|")) {
        break;
      }
      const cells = splitMarkdownTableRow(line);
      if (cells.length < headers.length) {
        break;
      }
      if (!normalizePageText(cells[referenceIndex] ?? "")) {
        continue;
      }
      answerRows.push(
        answerIndexes
          .map((cellIndex) => normalizePageText(cells[cellIndex] ?? ""))
          .filter(Boolean)
          .join(" "),
      );
    }
    index = rowIndex - 1;
  }

  return [
    ...answerRows.filter(Boolean),
    ...lines.filter((line) => !line.includes("|")),
  ].join("\n");
}

function isSubstantiveDocumentFindingEvidence(
  value: string | null | undefined,
) {
  const evidence = String(value ?? "").trim();
  const substantiveEvidence = normalizeSubstantiveDocumentFindingText(evidence);
  return (
    substantiveEvidence.length >= 16 &&
    substantiveEvidence.split(/\s+/u).length >= 3 &&
    !/^#{1,6}\s+[^\n]+$/u.test(evidence)
  );
}

function isEvidenceGroundedDocumentFinding(
  finding: SolutionEvaluationResult["document_findings"][number],
) {
  const evidence = String(finding.evidence ?? "").trim();
  if (
    !isSubstantiveDocumentFindingEvidence(evidence)
  ) {
    return false;
  }

  if (finding.reference_match === "coverage") {
    return (
      Boolean(finding.matched_requirement_reference?.trim()) &&
      finding.evidence_grounding === "coverage_exact"
    );
  }

  if (finding.reference_match === "section") {
    return (
      /^seksjonsfunn:/iu.test(finding.reference?.trim() ?? "") &&
      !finding.matched_requirement_reference?.trim() &&
      normalizeSubstantiveDocumentFindingText(finding.finding).length >= 24 &&
      normalizeSubstantiveDocumentFindingText(finding.recommendation).length >=
        24 &&
      finding.evidence_grounding === "document_exact"
    );
  }

  return false;
}

function deterministicCoverageDocumentFinding(
  coverage: RequirementCoverage,
): SolutionEvaluationResult["document_findings"][number] | null {
  const assessmentPriority: Record<
    RequirementCoverageItem["assessment"],
    number
  > = {
    Mangler: 0,
    Dårlig: 1,
    Uklart: 2,
    Godt: 3,
  };
  const candidate = coverage.items
    .filter(
      (item) =>
        Boolean(item.answer_document_id?.trim()) &&
        isSubstantiveDocumentFindingEvidence(item.evidence) &&
        String(item.rationale ?? "").trim().length >= 16 &&
        String(item.recommendation ?? "").trim().length >= 8,
    )
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        assessmentPriority[left.item.assessment] -
          assessmentPriority[right.item.assessment] || left.index - right.index,
    )[0]?.item;

  if (!candidate) {
    return null;
  }

  return {
    reference: compactText(
      candidate.full_reference ||
        candidate.source_reference ||
        candidate.reference,
      700,
    ),
    reference_match: "coverage",
    matched_requirement_reference: candidate.reference,
    assessment: candidate.assessment,
    finding: compactText(candidate.rationale, 500),
    evidence: candidate.evidence,
    evidence_grounding: "coverage_exact",
    recommendation: compactText(candidate.recommendation, 650),
  };
}

export function selectEvidenceGroundedDocumentFindings(
  findings: SolutionEvaluationResult["document_findings"],
  coverage: RequirementCoverage,
): SolutionEvaluationResult["document_findings"] {
  const grounded = findings.filter(isEvidenceGroundedDocumentFinding);
  if (grounded.length) {
    return grounded.slice(0, 6);
  }

  const deterministic = deterministicCoverageDocumentFinding(coverage);
  return deterministic ? [deterministic] : [];
}

function parseModelDocumentFindings(
  value: unknown,
): SolutionEvaluationResult["document_findings"] {
  type Finding = SolutionEvaluationResult["document_findings"][number];
  return untrustedRows<Finding>(value).map((item) => ({
    reference: stringOr(item.reference),
    assessment:
      item.assessment === "Godt" ||
      item.assessment === "Dårlig" ||
      item.assessment === "Mangler" ||
      item.assessment === "Uklart"
        ? item.assessment
        : "Uklart",
    finding: stringOr(item.finding),
    evidence: stringOr(item.evidence),
    recommendation: stringOr(item.recommendation),
  }));
}

export function normalizeSolutionEvaluationResult(
  result: Untrusted<SolutionEvaluationResult>,
  options: {
    evidenceDocumentText?: string;
    provenance?: Pick<
      SolutionEvaluationResult,
      "customer_document_id" | "solution_document_id" | "evaluation_context"
    >;
  } = {},
): SolutionEvaluationResult {
  const strengths = capNormalizedList(
    stringList(result.strengths),
  );
  const weaknesses = capNormalizedList(
    stringList(result.weaknesses),
  );
  const genericSections = capNormalizedList(
    stringList(result.generic_sections),
  );
  const missingElements = capNormalizedList(
    stringList(result.missing_elements),
  );
  const risksToCustomer = capNormalizedList(
    stringList(result.risks_to_customer),
  );
  const trustSignals = capNormalizedList(
    stringList(result.trust_signals),
  );
  const improvementRecommendations = capNormalizedList(
    stringList(result.improvement_recommendations),
  );
  const valueAssessment = normalizeValueOpportunities(
    result.value_assessment,
  );
  const scoreAssessment = untrustedObject<
    SolutionEvaluationResult["likely_score_assessment"]
  >(result.likely_score_assessment);
  const likelyScoreAssessment = {
    quality: compactText(scoreAssessment.quality ?? "", 500),
    delivery_confidence: compactText(
      scoreAssessment.delivery_confidence ?? "",
      500,
    ),
    risk: compactText(scoreAssessment.risk ?? "", 500),
    competitiveness: compactText(scoreAssessment.competitiveness ?? "", 500),
  };
  const rewriteSuggestions = untrustedRows<
    SolutionEvaluationResult["rewrite_suggestions"][number]
  >(result.rewrite_suggestions)
    .map((item) => ({
      target: compactText(item.target, 240),
      suggestion: compactText(item.suggestion, 700),
    }))
    .filter((item) => item.target || item.suggestion)
    .slice(0, 8);
  const requirementCoverage = normalizeSolutionRequirementCoverage(
    result.requirement_coverage,
  );
  const documentFindings = selectEvidenceGroundedDocumentFindings(
    normalizeDocumentFindingsAgainstCoverage(
      parseModelDocumentFindings(result.document_findings),
      requirementCoverage,
      { evidenceDocumentText: options.evidenceDocumentText },
    ),
    requirementCoverage,
  );
  const rawComparison = untrustedObject<
    NonNullable<SolutionEvaluationResult["architecture_comparison"]>
  >(result.architecture_comparison);
  const rawArchitectSolutionScore = normalizeComparisonScore(
    rawComparison.architect_solution_score,
  );
  const coverageWeightedMaximum = requirementCoverage.items.length
    ? Math.round(
        ((requirementCoverage.good +
          requirementCoverage.weak * 0.6 +
          requirementCoverage.unclear * 0.35) /
          requirementCoverage.items.length) *
          100,
      )
    : 100;
  const architectSolutionScore = Math.min(
    rawArchitectSolutionScore,
    coverageWeightedMaximum,
  );
  const systemSolutionScore = normalizeComparisonScore(
    rawComparison.system_solution_score,
  );
  const architectureComparison = {
    winner: reconcileArchitectureComparisonWinner(
      architectSolutionScore,
      systemSolutionScore,
    ),
    architect_solution_score: architectSolutionScore,
    system_solution_score: systemSolutionScore,
    verdict: stringOr(rawComparison.verdict).replace(/\s+/g, " ").trim(),
    strong_critique: capNormalizedList(
      stringList(rawComparison.strong_critique),
      { max: 6 },
    ),
    pragmatic_reflections: capNormalizedList(
      stringList(rawComparison.pragmatic_reflections),
      { max: 6 },
    ),
    strategy_improvement_advice: capNormalizedList(
      stringList(rawComparison.strategy_improvement_advice),
      { max: 6 },
    ),
  };

  const fitToCustomerNeeds = stringOr(result.fit_to_customer_needs)
    .replace(/\s+/g, " ")
    .trim();
  return {
    ...options.provenance,
    fit_to_customer_needs: fitToCustomerNeeds,
    strengths,
    weaknesses,
    generic_sections: genericSections,
    missing_elements: missingElements,
    risks_to_customer: risksToCustomer,
    trust_signals: trustSignals,
    likely_score_assessment: likelyScoreAssessment,
    improvement_recommendations: improvementRecommendations,
    value_assessment: valueAssessment,
    rewrite_suggestions: rewriteSuggestions,
    document_findings: documentFindings,
    requirement_coverage: requirementCoverage,
    architecture_comparison: architectureComparison,
    executive_summary: dedupeSummary(stringOr(result.executive_summary), [
      fitToCustomerNeeds,
      ...strengths,
      ...weaknesses,
      ...genericSections,
      ...missingElements,
      ...risksToCustomer,
      ...improvementRecommendations,
    ]),
  };
}

export function assertSubstantiveSolutionEvaluationResult(
  result: SolutionEvaluationResult,
) {
  const issues: string[] = [];
  const requireText = (label: string, value: string | undefined, minimum: number) => {
    if (normalizeSubstantiveDocumentFindingText(value).length < minimum) {
      issues.push(label);
    }
  };
  requireText("fit_to_customer_needs", result.fit_to_customer_needs, 40);
  requireText("executive_summary", result.executive_summary, 60);
  requireText(
    "likely_score_assessment.quality",
    result.likely_score_assessment?.quality,
    8,
  );
  requireText(
    "likely_score_assessment.delivery_confidence",
    result.likely_score_assessment?.delivery_confidence,
    8,
  );
  requireText(
    "likely_score_assessment.risk",
    result.likely_score_assessment?.risk,
    8,
  );
  requireText(
    "likely_score_assessment.competitiveness",
    result.likely_score_assessment?.competitiveness,
    8,
  );
  requireText(
    "architecture_comparison.verdict",
    result.architecture_comparison?.verdict,
    30,
  );

  for (const [label, values] of [
    ["strengths", result.strengths],
    ["weaknesses", result.weaknesses],
    ["improvement_recommendations", result.improvement_recommendations],
    [
      "architecture_comparison.strong_critique",
      result.architecture_comparison?.strong_critique,
    ],
    [
      "architecture_comparison.pragmatic_reflections",
      result.architecture_comparison?.pragmatic_reflections,
    ],
    [
      "architecture_comparison.strategy_improvement_advice",
      result.architecture_comparison?.strategy_improvement_advice,
    ],
  ] as Array<[string, string[] | undefined]>) {
    if (!Array.isArray(values) || !values.some((value) => value.trim().length >= 12)) {
      issues.push(label);
    }
  }
  if (
    !Array.isArray(result.rewrite_suggestions) ||
    !result.rewrite_suggestions.some(
      (item) =>
        item.target.trim().length >= 3 && item.suggestion.trim().length >= 20,
    )
  ) {
    issues.push("rewrite_suggestions");
  }

  if (issues.length) {
    throw new Error(
      `Helhetsvurderingen mangler obligatorisk, substansielt innhold og ble ikke lagret: ${issues.join(
        ", ",
      )}.`,
    );
  }
  return result;
}
function normalizeComparisonScore(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(raw)));
}

export function reconcileArchitectureComparisonWinner(
  architectSolutionScore: number,
  systemSolutionScore: number,
): NonNullable<
  SolutionEvaluationResult["architecture_comparison"]
>["winner"] {
  if (architectSolutionScore === systemSolutionScore) {
    return "Uavgjort";
  }

  return architectSolutionScore > systemSolutionScore
    ? "Arkitektløsning"
    : "Systemløsning";
}

async function createCustomerAnalysisV3Completion<T>(input: {
  system: string;
  user: string;
  model?: string;
  onCompletedField?: (key: string, value: unknown) => Promise<void>;
}) {
  return runStructuredJsonResponse<T>({
    ...input,
    schemaName: "customer_analysis_v3",
    schema: CUSTOMER_ANALYSIS_V3_JSON_SCHEMA,
    reasoningEffort: FAST_REASONING_EFFORT,
    verbosity: "low",
    maxOutputTokens: 8_000,
    timeoutMs: 180_000,
    maxRetries: 2,
    promptCacheKey: "customer-analysis-v3",
    getClient,
    defaultModel: DOCUMENT_ANALYSIS_MODEL,
    defaultReasoningEffort: FAST_REASONING_EFFORT,
    supportsCustomTemperature,
  });
}

type AnalyzeCustomerDocumentsInput = {
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  serviceCandidates?: ProjectServiceDescription[];
  model?: string;
  onCompletedField?: (key: string, value: unknown) => Promise<void>;
};

async function analyzeCustomerDocumentsLegacy(
  input: AnalyzeCustomerDocumentsInput,
) {
  const analysisDocuments = [
    input.customerDocument,
    ...input.supportingDocuments,
  ];
  const analysisFoundationFacts = collectArtifactFoundationFacts({
    documents: analysisDocuments,
    serviceDocuments: [],
  });
  // Only the first 12,000 characters of the customer document were sent, so
  // budgets, options, award criteria and a late corrections chapter were
  // never seen. Documents that fit are sent whole. For the remaining
  // documents, retrieval skips fully covered chunks and preserves boundary
  // chunks that contain additional evidence.
  const primaryInFull =
    input.customerDocument.raw_text.length <= CUSTOMER_ANALYSIS_FULL_DOCUMENT_MAX_CHARS;
  const primaryTextLimit = primaryInFull ? input.customerDocument.raw_text.length : 12000;
  let supportingBudget = CUSTOMER_ANALYSIS_SUPPORTING_FULL_BUDGET_CHARS;
  const supportingPlan = input.supportingDocuments.map((document, index) => {
    // At most four supporting documents get their own prompt section.
    const full = index < 4 && document.raw_text.length <= supportingBudget;
    if (full) supportingBudget -= document.raw_text.length;
    return { document, full, shown: index < 4, textLimit: full ? document.raw_text.length : 4000 };
  });
  // Every document not sent whole stays reachable through retrieval.
  const retrievalDocuments = [
    ...(primaryInFull ? [] : [input.customerDocument]),
    ...supportingPlan.filter((plan) => !plan.full).map((plan) => plan.document),
  ];
  const promptDocumentText = new Map([
    [input.customerDocument.id, compactText(input.customerDocument.raw_text, primaryTextLimit).slice(0, primaryTextLimit)],
    ...supportingPlan.filter((plan) => plan.shown).map(({ document, textLimit }) =>
      [document.id, compactText(document.raw_text, textLimit).slice(0, textLimit)] as const,
    ),
  ]);
  const analysisRetrieval = retrievalDocuments.length
    ? await retrieveDocumentSnippetsWithMetadata({
        query: [
          input.projectName,
          "kundens behov mål krav risiko evalueringskriterier tildelingskriterier forutsetninger budsjett økonomisk ramme tidsplan frister opsjoner rettelser arkitektur løsning verdi",
        ].join("\n"),
        projectId: input.customerDocument.project_id,
        documents: retrievalDocuments,
        exactTerms: ["krav", "behov", "risiko", "evalueringskriterier", "mål", "budsjett", "opsjon", "frist"],
        limit: 10,
        promptDocumentText,
      })
    : null;
  const supportingContexts = supportingPlan
    .filter((plan) => plan.shown)
    .map(({ document, textLimit }, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit,
        structureLimit: 6,
        structureTextLimit: 160,
      }),
    )
    .join("\n\n");
  const userPrompt = [
    "Analyser prosjektet og returner kun gyldig JSON.",
    "Skill tydelig mellom eksplisitte krav og implisitte krav.",
    "Alle verdiutsagn må knyttes til nøyaktig én av de fire faste verdikategoriene.",
    "",
    buildDelimitedContext(
      "Prosjekt",
      `Prosjektnavn: ${input.projectName}\nArbeid som et tilbudsteam som skal forstå kunden dypt og bruke funnene i posisjonering, løsningsarbeid og tilbudsbesvarelse.`,
    ),
    buildCustomerAnalysisFactsContext(analysisFoundationFacts),
    documentContext("Primært kundedokument", input.customerDocument, {
      textLimit: primaryTextLimit,
      structureLimit: primaryInFull ? 4 : 10,
      structureSelection: primaryInFull ? "head" : "distributed",
      structureTextLimit: 180,
    }),
    analysisRetrieval
      ? retrievedSnippetContext(
          "Semantisk dokumentdekning",
          analysisRetrieval.snippets,
          // A boundary chunk may repeat the head before adding a later
          // qualification; keep the new evidence at its end as well.
          { textLimit: null },
        )
      : "",
    analysisRetrieval
      ? buildDelimitedContext(
          "Retrieval-kvalitet",
          JSON.stringify(analysisRetrieval.telemetry.quality),
        )
      : "",
    buildDelimitedContext(
      "Dokumentdekningsregel",
      [
        primaryInFull
          ? "Hele det primære kundedokumentet er med. Bruk hele dokumentet, også senere kapitler om økonomiske rammer, opsjoner, tidsplan, evaluering og rettelser. Ikke skriv at deler av dokumentet ikke er synlige."
          : "Bruk strukturkartet og tekstutdraget aktivt. Hvis dokumentet viser til tabeller, figurer, vedlegg eller krav som ikke er synlige i tekstutdraget, marker dette nøkternt som et verifikasjonsbehov i analysen fremfor å anta innhold.",
        "Når et rettelses- eller endringskapittel endrer tidligere tekst, gjelder den nyeste teksten; nevn endringen.",
        "Når tall, frister eller krav er motstridende mellom kapitler eller dokumenter, skal du påpeke motstriden eksplisitt med begge verdiene og kildene i stedet for å velge én av dem. En uttrykkelig publisert rettelse er ikke en motstrid: den rettede verdien gjelder, også når rettelsen står i et annet dokument, og den erstattede verdien nevnes som erstattet.",
      ].join(" "),
    ),
    serviceRecommendationContext(input.serviceCandidates),
    supportingContexts
      ? buildDelimitedContext(
          "Tilleggsregel",
          "Bruk støttedokumentene bare som støtte og kontekst. Ikke la dem overstyre primært kundedokument, med unntak av en uttrykkelig publisert rettelse.",
        )
      : "",
    supportingContexts,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Without a timeout a hung call held the job for its whole 15 min deadline.
  const timeoutMs = boundedByProjectWorkflowDeadline(
    CUSTOMER_ANALYSIS_TIMEOUT_MS,
    { reserveMs: 30_000 },
  );
  if (timeoutMs === null) {
    throw new WorkflowIncompleteError(
      "Kundeanalysen stoppet fordi jobbfristen var nådd før AI-analysen kunne starte. Prøv igjen.",
    );
  }
  const result = await createJsonCompletion<CustomerAnalysisResult>({
    system: buildCustomerAnalysisPrompt(),
    user: userPrompt,
    temperature: 0.1,
    model: input.model ?? ANALYSIS_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
    timeoutMs,
    maxRetries: 1,
    promptCacheKey: "customer-analysis",
  });

  await recordDocumentIntelligenceEvent({
    projectId: input.customerDocument.project_id,
    eventType: "customer_analysis_used",
    sourceRevision: input.customerDocument.chunk_source_revision,
    metadata: {
      pipeline_version: "legacy",
      context_mode: "raw",
      document_count: analysisDocuments.length,
      compiled_document_count: 0,
      legacy_fallback_count: analysisDocuments.length,
      retrieval_used: analysisRetrieval !== null,
      prompt_chars: userPrompt.length,
      model: input.model ?? ANALYSIS_MODEL,
    },
  }).catch(() => false);

  const signalSourceText = analysisDocuments
    .map((document) => document.raw_text)
    .join("\n\n");

  return normalizeCustomerAnalysisResult(
    enrichCustomerAnalysisWithFoundationFacts(result, analysisFoundationFacts),
    {
      signalSourceText,
      serviceCandidates: input.serviceCandidates,
      sourceDocuments: analysisDocuments.map((document) => ({
        title: document.title,
        rawText: document.raw_text,
        structureMap: document.structure_map,
      })),
    },
  );
}

export async function analyzeCustomerDocuments(
  input: AnalyzeCustomerDocumentsInput,
) {
  if (customerAnalysisPipeline() === "legacy") {
    return analyzeCustomerDocumentsLegacy(input);
  }

  const analysisDocuments = [
    input.customerDocument,
    ...input.supportingDocuments,
  ];
  const {
    contexts: currentContexts,
    compiledOnDemandCount,
    persistenceFailureCount,
  } = await resolveCustomerAnalysisContexts({
    projectId: input.customerDocument.project_id,
    documents: analysisDocuments,
  });
  const analysisFoundationFacts = collectArtifactFoundationFacts({
    documents: analysisDocuments,
    serviceDocuments: [],
  });
  const promptDocuments = analysisDocuments.map((document) => ({
    documentId: document.id,
    title: document.title,
    role: document.role,
    context: currentContexts.get(document.id)?.analysisContext ?? "",
    sourceText: document.raw_text,
  }));
  const userPrompt = buildCustomerAnalysisV3UserPrompt({
    projectName: input.projectName,
    documents: promptDocuments,
    foundationFacts: buildCustomerAnalysisFactsContext(analysisFoundationFacts),
    serviceCandidates: serviceRecommendationContext(input.serviceCandidates),
  });
  const result =
    await createCustomerAnalysisV3Completion<CustomerAnalysisResult>({
      system: buildCustomerAnalysisV3SystemPrompt(),
      user: userPrompt,
      model: input.model ?? DOCUMENT_ANALYSIS_MODEL,
      onCompletedField: input.onCompletedField,
    });

  void recordDocumentIntelligenceEvent({
    projectId: input.customerDocument.project_id,
    eventType: "customer_analysis_used",
    sourceRevision: input.customerDocument.chunk_source_revision,
    metadata: {
      pipeline_version: "document-analysis.v3",
      document_count: analysisDocuments.length,
      compiled_document_count: currentContexts.size,
      compiled_on_demand_count: compiledOnDemandCount,
      compiled_on_demand_persist_failed_count: persistenceFailureCount,
      prompt_chars: userPrompt.length,
      document_context_usage: JSON.stringify(
        customerAnalysisV3ContextUsage(promptDocuments),
      ),
      model: input.model ?? DOCUMENT_ANALYSIS_MODEL,
    },
  }).catch(() => false);

  const signalSourceText = [
    input.customerDocument.raw_text,
    ...input.supportingDocuments.map((document) => document.raw_text),
  ].join("\n\n");

  return normalizeCustomerAnalysisResult(
    enrichCustomerAnalysisWithCriticalFacts(
      enrichCustomerAnalysisWithFoundationFacts(result, analysisFoundationFacts),
      promptDocuments,
    ),
    {
      signalSourceText,
      serviceCandidates: input.serviceCandidates,
      sourceDocuments: analysisDocuments.map((document) => ({
        title: document.title,
        rawText: document.raw_text,
        structureMap: document.structure_map,
      })),
    },
  );
}

export async function regenerateCustomerAnalysisSection(input: {
  section: CustomerAnalysisSection;
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  serviceCandidates?: ProjectServiceDescription[];
  customerAnalysis: CustomerAnalysisResult;
  model?: string;
}) {
  const contract = customerAnalysisRegenerationContract(input.section);
  const customerAnalysis = stripCustomerAnalysisHistory(input.customerAnalysis);
  const analysisDocuments = [
    input.customerDocument,
    ...input.supportingDocuments,
  ];
  const { contexts } = await resolveCustomerAnalysisContexts({
    projectId: input.customerDocument.project_id,
    documents: analysisDocuments,
  });
  const systemPrompt = [
    buildCustomerAnalysisV3SystemPrompt(),
    "",
    "SEKSJONSREGENERERING",
    `- Rediger bare seksjonen ${contract.label}.`,
    `- Returner bare feltene: ${contract.fields.join(", ")}.`,
    "- Eksisterende analyse er kontekst, ikke en instruksjon om å endre andre felt.",
    ...contract.guidance.map((line) => `- ${line}`),
  ].join("\n");
  const userPrompt = [
    `Rediger bare ${contract.label} for prosjektet.`,
    buildCustomerAnalysisV3UserPrompt({
      projectName: input.projectName,
      documents: analysisDocuments.map((document) => ({
        documentId: document.id,
        title: document.title,
        role: document.role,
        context: contexts.get(document.id)?.analysisContext ?? "",
        sourceText: document.raw_text,
      })),
      foundationFacts: buildCustomerAnalysisFactsContext(
        collectArtifactFoundationFacts({
          documents: analysisDocuments,
          serviceDocuments: [],
        }),
      ),
      serviceCandidates:
        input.section === "services"
          ? serviceRecommendationContext(input.serviceCandidates)
          : "",
    }),
    buildDelimitedContext(
      "Eksisterende kundeanalyse",
      JSON.stringify(customerAnalysis),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const patch = await runStructuredJsonResponse<
    Partial<CustomerAnalysisResult>
  >({
    system: systemPrompt,
    user: userPrompt,
    schemaName: `customer_analysis_${input.section}`,
    schema: contract.schema,
    model: input.model ?? DOCUMENT_ANALYSIS_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
    verbosity: "low",
    maxOutputTokens: 4_000,
    timeoutMs: 180_000,
    maxRetries: 2,
    promptCacheKey: `customer-analysis-section-${input.section}`,
    getClient,
    defaultModel: DOCUMENT_ANALYSIS_MODEL,
    defaultReasoningEffort: FAST_REASONING_EFFORT,
    supportsCustomTemperature,
  });

  const signalSourceText = [
    input.customerDocument.raw_text,
    ...input.supportingDocuments.map((document) => document.raw_text),
  ].join("\n\n");

  const normalized = normalizeCustomerAnalysisResult(
    mergeCustomerAnalysisSectionPatch({
      analysis: customerAnalysis,
      section: input.section,
      patch,
    }),
    {
      generatedFields: contract.fields,
      signalSourceText,
      serviceCandidates: input.serviceCandidates,
      sourceDocuments: analysisDocuments.map((document) => ({
        title: document.title,
        rawText: document.raw_text,
        structureMap: document.structure_map,
      })),
    },
  );
  const result = mergeCustomerAnalysisSectionPatch({
    analysis: customerAnalysis,
    section: input.section,
    patch: normalized,
  });
  // Keyword occurrence counts are derived output owned by the same section,
  // although only the keyword list is supplied by the model's schema.
  return input.section === "keywords"
    ? { ...result, signal_word_counts: normalized.signal_word_counts }
    : result;
}

export async function generateHighLevelDesign(input: {
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  customerAnalysis: CustomerAnalysisResult;
  model?: string;
}) {
  const customerAnalysis = stripCustomerAnalysisHistory(input.customerAnalysis);
  const supportingContexts = input.supportingDocuments
    .slice(0, 4)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 5000,
        structureLimit: 6,
        structureTextLimit: 150,
      }),
    )
    .join("\n\n");
  const documentsForCoverage = [input.customerDocument, ...input.supportingDocuments];
  const coverageSeed = buildOfferCoverageRetrievalSeed({
    projectName: input.projectName,
    mode: "high_level_design",
    customerAnalysis,
    documents: documentsForCoverage,
  });
  // Both use the same frozen sources; retrieval does not depend on the digest.
  // Start both together and wait for all evidence before composing the prompt.
  const [customerDocumentDigest, coverageRetrieval] = await Promise.all([
    buildDocumentInsightDigest(
      "Primært kundedokument",
      input.customerDocument,
      { maxChunks: 5 },
    ),
    retrieveDocumentSnippetsWithMetadata({
      query: coverageSeed.query,
      projectId: input.customerDocument.project_id,
      documents: documentsForCoverage,
      exactTerms: coverageSeed.exactTerms,
      limit: 16,
    }),
  ]);
  const coverageContext = buildOfferCoverageContext({
    mode: "high_level_design",
    customerAnalysis,
    snippets: coverageRetrieval.snippets,
    telemetry: coverageRetrieval.telemetry,
  });
  const designFoundationFacts = collectArtifactFoundationFacts({
    documents: documentsForCoverage,
    serviceDocuments: [],
  });

  const userPrompt = [
    "Generer kun high-level design og diagram. Returner kun gyldig JSON.",
    buildDelimitedContext(
      "Dekningskrav for high-level design",
      [
        "Bruk den dynamiske dekningskonteksten aktivt før du skriver.",
        "high_level_solution_design skal dekke alle dekningskategorier som har dokumenterte funn, men bare som korte designføringer når kategorien ikke er teknisk arkitektur.",
        "Ikke begrens svaret til tekniske komponenter dersom kildene også har leveranse-, drifts-, kommersielle eller avklaringsfunn som påvirker løsningsvalg, gjennomføring eller tilbudsrisiko.",
        "Bruk eksakte prosjektbegreper, komponentnavn, frister, tall og vilkår bare når de finnes i kildene eller i lagret analyse.",
        "Diagrammet skal fortsatt bare vise arkitektur og operativ flyt, ikke kommersielle vilkår eller frister.",
      ].join("\n"),
    ),
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    buildProjectDesignFactsContext(designFoundationFacts),
    documentContext("Primært kundedokument", input.customerDocument, {
      textLimit: 10000,
      structureLimit: 8,
      structureTextLimit: 160,
    }),
    customerDocumentDigest ?? "",
    coverageContext,
    buildDelimitedContext(
      "Eksisterende kundeanalyse",
      summarizeCustomerAnalysis(customerAnalysis),
    ),
    supportingContexts
      ? buildDelimitedContext(
          "Tilleggsregel",
          "Bruk støttedokumentene som støtte. Ikke overstyr primært kundedokument eller eksisterende kundeanalyse uten tydelig grunnlag.",
        )
      : "",
    supportingContexts,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await createJsonCompletion<{
    high_level_solution_design: string;
    high_level_architecture_mermaid: string;
  }>({
    system: buildHighLevelDesignPrompt(),
    user: userPrompt,
    temperature: 0.12,
    model: input.model ?? ANALYSIS_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
    promptCacheKey: "high-level-design",
  });

  const normalizedHighLevelSolutionDesign =
    enrichHighLevelDesignTextWithFoundationFacts(
      stringOr(result.high_level_solution_design),
      designFoundationFacts,
    );

  return {
    high_level_solution_design: normalizedHighLevelSolutionDesign,
    high_level_architecture_mermaid: normalizeHighLevelDesignDiagram({
      rawDiagram: stringOr(result.high_level_architecture_mermaid),
      designText: normalizedHighLevelSolutionDesign,
      facts: designFoundationFacts,
    }),
  };
}

export async function evaluateSolutionDocument(input: {
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  solutionDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  sourceRequirementLedger?: RequirementLedgerEntry[];
  solutionRequirementLedger?: RequirementLedgerEntry[];
  customerAnalysis: CustomerAnalysisResult;
  systemSolutionArtifact?: {
    id?: string;
    title: string;
    content_markdown: string;
    artifact_type?: GeneratedArtifactType;
    created_at?: string;
  } | null;
  model?: string;
  sourceRevision?: number;
  documentLedgerContext?: string;
  onProgress?: (message: string) => void;
}) {
  const requirementCoverage = await buildSolutionRequirementCoverage({
    projectName: input.projectName,
    solutionDocument: input.solutionDocument,
    solutionRequirementLedger: input.solutionRequirementLedger,
    sourceRequirementLedger: input.sourceRequirementLedger,
    requirementDocuments: [input.customerDocument, ...input.supportingDocuments],
    customerAnalysis: input.customerAnalysis,
    model: input.model,
    onProgress: input.onProgress,
  });
  const requirementSourceDocuments = canonicalRequirementSourceDocuments({
    customerDocument: input.customerDocument,
    documents: input.supportingDocuments,
  });
  const requirementSourceManifest = buildImmutableRequirementRowManifest(
    requirementCoverage.items.map((item) => ({
      ref: item.reference,
      requirementText: item.requirement,
      sourceLocator: item.full_reference || item.source_reference,
      sourceDocumentId: item.source_document_id ?? null,
    })),
  );
  input.onProgress?.(
    formatJobProgress(62, `Kravdekning ferdig med ${requirementCoverage.items.length} krav. Bygger vurderingsgrunnlag ...`),
  );
  const hasRequirementCoverage = requirementCoverage.items.length > 0;
  const evaluationFoundationFacts = collectArtifactFoundationFacts({
    documents: [input.customerDocument, ...input.supportingDocuments],
    serviceDocuments: [],
  });
  const solutionDocumentDigest = hasRequirementCoverage
    ? null
    : await buildDocumentInsightDigest(
        "Importert arkitekt-/løsningsdokument",
        input.solutionDocument,
        { maxChunks: 4 },
      );
  const supportingContexts = input.supportingDocuments
    .slice(0, 1)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 2000,
        structureLimit: 4,
        structureTextLimit: 120,
      }),
    )
    .join("\n\n");
  const supplementalEvaluationLedgerContext =
    suppressDuplicatedDocumentLedgerContext({
      documentLedgerContext: input.documentLedgerContext,
      authoritativeRequirementRegistryPresent: hasRequirementCoverage,
    });

  const userPrompt = [
    "Sammenlign systemets lagrede strategi/løsning med det importerte løsnings-/arkitektdokumentet.",
    "Vurder hvilken løsning som er best, gi sterk kritikk, pragmatiske refleksjoner, strategiråd, score og konkrete funn med eksakte referanser tilbake til det importerte Bilag 2 / arkitektdokumentet.",
    hasRequirementCoverage
      ? "Kravdekningen og coverage_registry er fasit for hvilke konkrete krav som er identifisert og vurdert. Når document_findings omtaler et konkret krav, må funnet matche en reference eller source_reference i coverage_registry. Ikke introduser nye krav i document_findings. Hvis du omtaler en bred arkitektur- eller besvarelsesseksjon som ikke finnes i coverage_registry, skal funnet formuleres som et seksjonsfunn og ikke som kravdekning."
      : "",
    "Returner kun gyldig JSON.",
    "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    supplementalEvaluationLedgerContext
      ? buildDelimitedContext(
          "Evalueringsledger",
          "Bruk ledgeren til å koble evalueringskriterier, må-krav og bør-krav til løsningens dekning. Gi bare score når kildegrunnlaget finnes.\n\n" +
            supplementalEvaluationLedgerContext,
        )
      : "",
    documentContext("Primært kundedokument", input.customerDocument, {
      textLimit: hasRequirementCoverage ? 3000 : 4000,
      structureLimit: hasRequirementCoverage ? 4 : 5,
      structureTextLimit: 120,
    }),
    buildSolutionEvaluationFactsContext(evaluationFoundationFacts),
    buildDelimitedContext(
      "Lagret kundeanalyse",
      summarizeCustomerAnalysis(input.customerAnalysis),
    ),
    input.systemSolutionArtifact
      ? buildDelimitedContext(
          "Systemløsning som skal scores",
          [
            `Tittel: ${input.systemSolutionArtifact.title}`,
            input.systemSolutionArtifact.content_markdown,
          ].join("\n\n"),
        )
      : "",
    input.systemSolutionArtifact
      ? buildDelimitedContext(
          "Viktig scoringsregel for systemløsningen",
          "Når en systemløsning er oppgitt i eget felt, skal denne teksten være primærgrunnlaget for architecture_comparison.system_solution_score. Kundeanalysen er da støtte og kontekst, ikke erstatning for systemløsningen.",
        )
      : "",
    documentContext("Importert Bilag 2 / arkitektens svar", input.solutionDocument, {
      textLimit: hasRequirementCoverage ? 2600 : 6000,
      structureLimit: 12,
      structureTextLimit: hasRequirementCoverage ? 120 : 160,
      structureSelection: hasRequirementCoverage ? "distributed" : "head",
    }),
    buildRequirementCoverageEvaluationContext(requirementCoverage),
    buildDelimitedContext("Kriterier som skal vurderes enkeltvis", JSON.stringify(input.customerAnalysis.likely_evaluation_criteria.map((criterion, criterion_index) => ({ criterion_index, criterion })))),
    buildDelimitedContext(
      "Referanseregel for importert Bilag 2",
      [
        "Når du lager document_findings, skal reference peke til den mest presise synlige referansen i strukturkartet eller teksten for Bilag 2: side, seksjon, tabell, rad, ark eller overskrift. Bruk samme referanseform som finnes i dokumentkonteksten.",
        hasRequirementCoverage
          ? "Kravfunn må bruke eller tydelig matche en reference/source_reference fra coverage_registry. Besvarelses- eller arkitekturseksjoner uten slik match skal ikke omtales som et krav, selv om de kan være relevante toppfunn."
          : "",
        hasRequirementCoverage
          ? "Hvis et svar overlater nødvendig kravdekning til vedlegg/bilag/annex som ikke finnes i vurderingskonteksten, skal kravet vurderes som Uklart inntil dokumentet og beviset er kontrollert. Ikke gi goodwill-dekning bare på grunnlag av en uverifisert referanse. Et konkret og selvstendig hovedsvar skal vurderes uten den supplerende vedleggssetningen og kan beholde Godt."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    solutionDocumentDigest
      ? buildDelimitedContext(
          "Analyseinstruks for arkitektdokument",
          "Bruk bred dokumentdekning for arkitektdokumentet aktivt. Den dekker flere sider/blokker enn hovedutdraget, og skal brukes når du scorer, kritiserer og sammenligner arkitektløsningen mot systemløsningen. Visuelle elementer, grafer og tabeller uten maskinlesbar tekst skal behandles som verifikasjonsbehov, ikke som sikre funn.",
        )
      : "",
    solutionDocumentDigest ?? "",
    supportingContexts,
  ]
    .filter(Boolean)
    .join("\n\n");

  const evaluationModel = requirementCoverageBatchModel(input.model);
  const holisticTimeoutMs = boundedByProjectWorkflowDeadline(
    SOLUTION_EVALUATION_TIMEOUT_MS,
    { reserveMs: SOLUTION_EVALUATION_DEADLINE_RESERVE_MS },
  );
  if (holisticTimeoutMs === null) {
    throw new WorkflowIncompleteError(
      "Løsningsvurderingen stoppet fordi kravdekningen brukte opp tidsfristen før helhetsvurderingen kunne kjøres. Prøv igjen om litt.",
    );
  }
  let result: Untrusted<SolutionEvaluationResult>;
  try {
    input.onProgress?.(
      formatJobProgress(74, "Kjører helhetsvurdering mot kravdekning og arkitektens svar ..."),
    );
    result = await runWithProgressHeartbeat(
      {
        onProgress: input.onProgress,
        message:
          formatJobProgress(88, "Helhetsvurderingen jobber fortsatt med kravdekning, score og anbefalinger ..."),
        intervalMs: 15_000,
      },
      () =>
        createJsonCompletion<SolutionEvaluationResult>({
          system: buildSolutionEvaluationPrompt({
            hasSystemSolutionArtifact: Boolean(input.systemSolutionArtifact),
          }),
          user: userPrompt,
          temperature: 0.1,
          model: evaluationModel,
          reasoningEffort: solutionEvaluationReasoningEffort(evaluationModel),
          timeoutMs: holisticTimeoutMs,
          maxRetries: 1,
          promptCacheKey: "solution-evaluation-holistic",
        }),
    );
  } catch (error) {
    assertProjectWorkflowActive();
    console.info(
      JSON.stringify({
        event: "solution_evaluation_fallback",
        ...safeErrorTelemetry(error),
      }),
    );
    throw new Error(
      productionSafeErrorMessage(
        error,
        "Helhetsvurderingen feilet og ble ikke lagret som ferdig.",
      ),
      { cause: error },
    );
  }
  input.onProgress?.(formatJobProgress(94, "Normaliserer vurdering og kravrekkefølge ..."));
  const evaluationContext = buildSolutionEvaluationProvenance({
    customerDocument: input.customerDocument,
    solutionDocument: input.solutionDocument,
    systemSolutionArtifact: input.systemSolutionArtifact,
    requirementSourceDocumentIds: requirementSourceDocuments.map(
      (document) => document.id,
    ),
    requirementSourceManifestSha256: requirementSourceManifest.manifest_sha256,
    sourceRevision: input.sourceRevision,
  });

  const normalizedEvaluation = normalizeSolutionEvaluationResult(
      {
        ...result,
        requirement_coverage: requirementCoverage,
      },
      {
        evidenceDocumentText: solutionDocumentAnswerBearingText(
          input.solutionDocument.raw_text,
        ),
        provenance: {
          customer_document_id: input.customerDocument.id,
          solution_document_id: input.solutionDocument.id,
          evaluation_context: evaluationContext,
        },
      },
    );
  assertSubstantiveSolutionEvaluationResult(normalizedEvaluation);
  normalizedEvaluation.criterion_coverage = normalizeCriterionCoverage(result.criterion_coverage, {
    criteria: input.customerAnalysis.likely_evaluation_criteria,
    analysisRevision: input.customerAnalysis.revision,
    sourceRevision: input.sourceRevision,
    coverage: normalizedEvaluation.requirement_coverage!,
    customerDocuments: [input.customerDocument, ...requirementSourceDocuments],
    solutionDocument: input.solutionDocument,
  });
  return reviewSolutionEvaluationEvidence(normalizedEvaluation, {
    documents: [input.customerDocument, input.solutionDocument, ...input.supportingDocuments].map(document => ({ document, sourceType: "project_document" as const })),
    authoritativeRequirementRefs: (input.sourceRequirementLedger ?? []).map(row => row.id),
    artifacts: input.systemSolutionArtifact?.id ? [{ ...input.systemSolutionArtifact, id: input.systemSolutionArtifact.id }] : [],
  }, result.criterion_coverage);

}

/** Source review may downgrade coverage after model normalization. Keep all
 * derived summaries, scores and matched findings on the same assessment set. */
export function reviewSolutionEvaluationEvidence(result: SolutionEvaluationResult, input: Parameters<typeof reviewStructuredOutputEvidence>[1], originalCriterionCoverage: unknown = result.criterion_coverage) {
  const reviewed = reviewStructuredOutputEvidence(result, input);
  const coverage = reviewed.result.requirement_coverage;
  if (!coverage) return { ...reviewed.result, source_evidence: reviewed.evidence };
  let downgraded = false;
  const changedPaths = new Set<string>();
  const downgradedItems = new Set<RequirementCoverage["items"][number]>();
  for (const issue of reviewed.evidence.issues ?? []) {
    const match = /^result\.requirement_coverage\.items\.(\d+)\./u.exec(issue.path);
    const item = match ? coverage.items[Number(match[1])] : null;
    if (match && item?.assessment === "Godt") {
      item.assessment = "Uklart";
      item.rationale = "Må avklares. Kravdekningen kunne ikke bekreftes i kildegrunnlaget.";
      item.recommendation = "Kontroller originalkilden og oppdater besvarelsen før kravet vurderes på nytt.";
      downgradedItems.add(item);
      changedPaths.add(`result.requirement_coverage.items.${match[1]}.rationale`);
      changedPaths.add(`result.requirement_coverage.items.${match[1]}.recommendation`);
      downgraded = true;
    }
  }
  if (reviewed.result.criterion_coverage) {
    const before = reviewed.result.criterion_coverage;
    const next = reconcileCriterionCoverage(before.map((item, index) => ({ ...item,
      review_required: item.review_required || (reviewed.evidence.issues ?? []).some(issue => issue.path.startsWith(`result.criterion_coverage.${index}.`)),
    })), coverage, input.documents.map(item => item.document).filter((document): document is ProjectDocumentDetail => "project_id" in document));
    next.forEach((item, index) => {
      if (item.rationale !== before[index].rationale) changedPaths.add(`result.criterion_coverage.${index}.rationale`);
      if (item.assessment !== before[index].assessment) changedPaths.add(`result.criterion_coverage.${index}.assessment`);
    });
    reviewed.result.criterion_coverage = next;
    downgraded = criterionCoverageLostGoodRating(originalCriterionCoverage, next) || downgraded;
  }
  // A finding without a unique source-qualified match must never inherit one
  // of the candidate rows' recommendation, even if no row changed this pass.
  reviewed.result.document_findings = reviewed.result.document_findings.map((finding, index) => {
    if (finding.reference_match !== "coverage") return finding;
    const match = matchFindingToCoverageItem({ finding, coverage });
    const changed = !match || downgradedItems.has(match);
    if (!changed) {
      if (finding.assessment !== match.assessment) changedPaths.add(`result.document_findings.${index}.assessment`);
      return { ...finding, assessment: match.assessment };
    }
    for (const field of ["assessment", "finding", "recommendation"]) changedPaths.add(`result.document_findings.${index}.${field}`);
    return { ...finding, assessment: match?.assessment ?? "Uklart",
      finding: match ? match.rationale : "Må avklares. Funnet kan ikke knyttes entydig til ett krav i kildegrunnlaget.",
      recommendation: match?.recommendation ?? "Kontroller originalkilden og avklar hvilket krav funnet gjelder før besvarelsen vurderes på nytt.",
    };
  });
  const finish = () => {
    const changed = (path: string) => [...changedPaths].some(parent => path === parent || path.startsWith(`${parent}.`));
    reviewed.evidence.references = reviewed.evidence.references.filter(reference => !changed(reference.path));
    reviewed.evidence.issues = reviewed.evidence.issues?.filter(issue => !changed(issue.path));
    return { ...reviewed.result, source_evidence: reviewed.evidence };
  };
  if (!downgraded) return finish();
  coverage.good = coverage.items.filter(item => item.assessment === "Godt").length;
  coverage.weak = coverage.items.filter(item => item.assessment === "Dårlig").length;
  coverage.missing = coverage.items.filter(item => item.assessment === "Mangler").length;
  coverage.unclear = coverage.items.filter(item => item.assessment === "Uklart").length;
  coverage.coverage_summary = buildRequirementCoverageSummary(coverage.items);
  changedPaths.add("result.requirement_coverage.coverage_summary");
  // Global narrative was generated from the pre-review assessments. Quotation
  // membership cannot establish that its conclusions survived the downgrade.
  // Withhold that interpretation, retain the scoped row evidence and unchanged
  // findings, and pass the reconciled summary to every downstream consumer.
  const notice = "Kildekontrollen endret krav- eller kriterievurderingen. Den opprinnelige helhetsvurderingen er holdt tilbake. Avklar de usikre vurderingene før konklusjonene brukes.";
  const summary = `${coverage.coverage_summary} ${notice}`;
  reviewed.result.fit_to_customer_needs = summary;
  reviewed.result.executive_summary = summary;
  for (const field of ["strengths", "weaknesses", "generic_sections", "missing_elements", "risks_to_customer", "trust_signals", "improvement_recommendations"] as const) {
    reviewed.result[field] = field === "improvement_recommendations" ? ["Kontroller originalkildene og oppdater de usikre kravbesvarelsene før en ny helhetsvurdering."] : [];
    changedPaths.add(`result.${field}`);
  }
  reviewed.result.value_assessment = [];
  reviewed.result.rewrite_suggestions = [];
  reviewed.result.likely_score_assessment = { quality: notice, delivery_confidence: notice, risk: notice, competitiveness: notice };
  for (const field of ["fit_to_customer_needs", "executive_summary", "value_assessment", "rewrite_suggestions", "likely_score_assessment"]) changedPaths.add(`result.${field}`);
  const comparison = reviewed.result.architecture_comparison;
  if (comparison) {
    comparison.strong_critique = [];
    comparison.pragmatic_reflections = [];
    comparison.strategy_improvement_advice = [notice];
    for (const field of ["strong_critique", "pragmatic_reflections", "strategy_improvement_advice"]) changedPaths.add(`result.architecture_comparison.${field}`);
    const previousScore = comparison.architect_solution_score;
    const previousWinner = comparison.winner;
    const cap = coverage.items.length ? Math.round((coverage.good + coverage.weak * 0.6 + coverage.unclear * 0.35) / coverage.items.length * 100) : 100;
    comparison.architect_solution_score = Math.min(comparison.architect_solution_score, cap);
    comparison.winner = reconcileArchitectureComparisonWinner(comparison.architect_solution_score, comparison.system_solution_score);
    const comparisonChanged = comparison.architect_solution_score !== previousScore || comparison.winner !== previousWinner;
    comparison.verdict = `${coverage.coverage_summary} ${comparisonChanged ? "Sammenligningen er oppdatert" : "Poengene og vinneren er uendret"} etter kildekontroll: arkitektløsning ${comparison.architect_solution_score}, systemløsning ${comparison.system_solution_score}. Avklar de usikre kravene før sammenligningen brukes.`;
    changedPaths.add("result.architecture_comparison.verdict");
  }

  reviewed.result.evidence_review = {
    status: "coverage_downgraded", message: notice,
    affected_requirement_references: [...downgradedItems].map(item => item.full_reference ?? item.reference),
    withheld_paths: [...changedPaths],
  };
  return finish();
}

function parseGeneratedArtifactDraft(
  value: Untrusted<GeneratedArtifactDraft>,
): GeneratedArtifactDraft {
  return {
    title: stringOr(value.title),
    content_markdown: stringOr(value.content_markdown),
    generation_metadata: value.generation_metadata,
  };
}

async function buildPrimaryArtifactDigests(input: ProjectArtifactGenerationInput) {
  const shouldBuildPrimaryDigests = input.artifactType !== "forbedret_kravsvar";
  const [customerDocumentDigest, solutionDocumentDigest] =
    shouldBuildPrimaryDigests
      ? await Promise.all([
          input.customerDocument
            ? buildDocumentInsightDigest("Primært kundedokument", input.customerDocument, {
                maxChunks: 4,
              })
            : Promise.resolve(null),
          input.solutionDocument
            ? buildDocumentInsightDigest(
                "Primært løsningsdokument",
                input.solutionDocument,
                { maxChunks: 4 },
              )
            : Promise.resolve(null),
        ])
      : [null, null];

  return { customerDocumentDigest, solutionDocumentDigest };
}

function buildSupportingArtifactContext(input: ProjectArtifactGenerationInput) {
  const supportingContexts = input.supportingDocuments
    .slice(0, 6)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 2600,
        structureLimit: 4,
        structureTextLimit: 140,
      }),
    )
    .join("\n\n");

  return supportingContexts;
}

function serviceDocumentsForArtifact(input: ProjectArtifactGenerationInput) {
  const serviceDocuments =
    input.artifactType === "bilag1_rekonstruksjon"
      ? []
      : [
          ...(input.serviceDescriptionDocuments ?? []).map(
            serviceDocumentAsProjectDocument,
          ),
          ...(input.serviceDescriptionDocument
            ? [input.serviceDescriptionDocument]
            : []),
        ];

  return serviceDocuments;
}

function buildServiceArtifactContexts(
  input: ProjectArtifactGenerationInput,
  serviceDocuments: ProjectDocumentDetail[],
) {
  const serviceDocumentLimit =
    input.artifactType === "forbedret_kravsvar" ? 4 : 3;
  const serviceContextBudget =
    input.artifactType === "forbedret_kravsvar" ? 3600 : 4000;
  const serviceDescriptionContext = serviceDocuments
    .slice(0, serviceDocumentLimit)
    .map((document, index) =>
      documentContext(
        `Tjenestebeskrivelse ${index + 1} - firmaets relevante tjenester og verktøy`,
        document,
        {
          textLimit: Math.max(
            900,
            Math.floor(
              serviceContextBudget / Math.max(1, serviceDocumentLimit),
            ),
          ),
          structureLimit:
            input.artifactType === "forbedret_kravsvar" ? 6 : 3,
          structureTextLimit:
            input.artifactType === "forbedret_kravsvar" ? 160 : 120,
        },
      ),
    )
    .join("\n\n");
  const serviceSummaryContext = (input.serviceDocumentSummaries ?? [])
    .map((document, index) =>
      buildDelimitedContext(
        `Tjenestesammendrag ${index + 1}`,
        [
          `Tittel: ${document.title}`,
          `Filnavn: ${document.file_name}`,
          `Sammendrag: ${
            compactText(document.ai_summary?.trim() || "", 900) ||
            "Mangler forhåndssammendrag. Bruk råtekst bare hvis dokumentet er hentet som detaljkontekst."
          }`,
        ].join("\n"),
      ),
    )
    .join("\n\n");

  return { serviceDescriptionContext, serviceSummaryContext };
}

function buildBilag1SourceContext(input: ProjectArtifactGenerationInput) {
  const bilag1SourceContext =
    input.artifactType === "bilag1_rekonstruksjon"
      ? [
          input.customerDocument,
          input.solutionDocument,
          ...input.supportingDocuments,
        ]
          .filter(
            (document): document is ProjectDocumentDetail =>
              document !== null && Boolean(document.raw_text.trim()),
          )
          .slice(0, 8)
          .map((document, index) =>
            documentContext(`Bilag 1-kilde ${index + 1}`, document, {
              textLimit: 9000,
              structureLimit: 18,
              structureTextLimit: 260,
            }),
          )
          .join("\n\n")
      : "";

  return bilag1SourceContext;
}

export function selectKnowledgeArtifactsForArtifact<
  T extends { artifact_type: GeneratedArtifactType },
>(artifactType: GeneratedArtifactType, artifacts: T[]): T[] {
  const eligible = artifacts.filter(
    (artifact) => artifact.artifact_type !== artifactType,
  );
  return eligible.slice(
    0,
    artifactType === "gjennomforing_og_risiko" ? 2 : 4,
  );
}

function buildArtifactKnowledgeContext(input: ProjectArtifactGenerationInput) {
  const artifactKnowledge = selectKnowledgeArtifactsForArtifact(
    input.artifactType,
    input.knowledgeArtifacts,
  )
    .map((artifact, index) =>
      buildDelimitedContext(
        `Tidligere arbeidstekst ${index + 1}`,
        [
          `Tittel: ${artifact.title}`,
          `Type: ${artifact.artifact_type}`,
          input.artifactType === "gjennomforing_og_risiko"
            ? "Bruk kun som bakgrunn. Ikke kopier struktur, fasetitler eller formuleringer."
            : "",
          compactText(artifact.content_markdown, 2200),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    )
    .join("\n\n");

  return artifactKnowledge;
}

async function buildArtifactRetrievalContext(
  input: ProjectArtifactGenerationInput,
  serviceDocuments: ProjectDocumentDetail[],
) {
  // Requirement answers already carry a solution document that fits whole;
  // excerpts of it would only repeat it.
  const solutionDocumentInPrompt =
    input.artifactType === "forbedret_kravsvar" &&
    Boolean(input.solutionDocument && solutionDocumentFitsRequirementPrompt(input.solutionDocument));
  const artifactRetrievalDocuments = [
    input.customerDocument,
    solutionDocumentInPrompt ? null : input.solutionDocument,
    ...input.supportingDocuments,
  ].filter((document): document is ProjectDocumentDetail => Boolean(document));
  const artifactRetrieval = await retrieveDocumentSnippetsWithMetadata({
    query: [
      input.projectName,
      input.artifactType,
      "krav behov risiko verdi evalueringskriterier løsning gjennomføring drift kontrakt",
      input.instructions ?? "",
      input.customerAnalysis ? summarizeCustomerAnalysis(input.customerAnalysis) : "",
      input.solutionEvaluation
        ? solutionEvaluationRetrievalTerms(input.solutionEvaluation)
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    projectId: artifactRetrievalDocuments[0]?.project_id ?? null,
    documents: artifactRetrievalDocuments,
    serviceDocuments: input.serviceDescriptionDocuments ?? [],
    exactTerms: [
      "krav",
      "behov",
      "risiko",
      "verdi",
      "evalueringskriterier",
      ...extractExactRetrievalTerms(input.instructions ?? ""),
    ],
    limit: input.artifactType === "forbedret_kravsvar" ? 8 : 10,
  });
  const artifactRetrievalContext = retrievedSnippetContext(
    "Mest relevante dokumentutdrag for artefakten",
    artifactRetrieval.snippets,
    { textLimit: input.artifactType === "forbedret_kravsvar" ? 700 : 1200 },
  );
  const retrievalQualityContext = buildDelimitedContext(
    "Retrieval-kvalitet",
    JSON.stringify(artifactRetrieval.telemetry.quality),
  );
  const foundationFacts =
    input.artifactType === "forbedret_kravsvar"
      ? collectArtifactFoundationFacts({
          documents: artifactRetrievalDocuments,
          serviceDocuments,
	        })
	      : [];

  return {
    artifactRetrievalContext,
    retrievalQualityContext,
    foundationFacts,
  };
}

function buildGeneralArtifactPrompt(input: {
  generationInput: ProjectArtifactGenerationInput;
  serviceSummaryContext: string;
  serviceDescriptionContext: string;
  artifactRetrievalContext: string;
  retrievalQualityContext: string;
  requirementSourceLedgerContext: string;
  requirementContinuityContext: string;
  requirementDocumentContext: string;
  bilag1SourceContext: string;
  customerDocumentDigest: string | null;
  solutionDocumentDigest: string | null;
  supportingContexts: string;
  artifactKnowledge: string;
}) {
  const generationInput = input.generationInput;
  return [
    "Generer artefakten som gyldig JSON med feltene title og content_markdown.",
    generationInput.instructions
      ? buildDelimitedContext("Brukerbestilling", generationInput.instructions)
      : "",
    generationInput.documentLedgerContext
      ? buildDelimitedContext(
          "Strukturert dokumentledger",
          generationInput.documentLedgerContext,
        )
      : "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${generationInput.projectName}`),
    buildDelimitedContext(
      "Kunnskapsregel",
      generationInput.artifactType === "gjennomforing_og_risiko"
        ? "Bruk prosjektgrunnlaget som kunnskapsbase, men prioriter kundedokument, lagret kundeanalyse, dokumenterte risikoer, krav, avhengigheter og evalueringskriterier over tidligere arbeidstekster. Tidligere arbeidstekster er kun bakgrunn og skal ikke styre faseinndeling eller formuleringer."
        : "Bruk hele prosjektgrunnlaget som kunnskapsbase: kundedokument, løsningsdokument, støttedokumenter, strategi- og notatdokumenter, tjenestebeskrivelse, lagret analyse og tidligere arbeidstekster. Prioriter det mest oppdaterte og mest konkrete innholdet hvis kilder overlapper.",
    ),
    generationInput.artifactType === "bilag1_rekonstruksjon"
      ? buildDelimitedContext(
          "Bilag 1-regel",
          "Rekonstruer kundens behovsgrunnlag fra kundens egne kilder. Ikke bland inn leverandørens tilbud som fakta om kunden. Bruk kildeindikasjoner fra dokumenttitler, strukturkart, sidemarkører og ark/rad-referanser når de finnes.",
        )
      : "",
    input.serviceDescriptionContext
      ? buildDelimitedContext(
          "Regel for tjenestebeskrivelse",
          "Tjenestesammendragene viser tjenestedokumenter som er huket av for dette prosjektet. Detaljert tjenestekontekst er bare hentet for dokumenter som ser mest relevante ut. Når du lager kravsvar, systemløsning eller løsningsbeskrivelse, skal du aktivt vurdere hvilke tjenester, leveranseområder, metoder og kapabiliteter som er relevante for kundens behov. Bruk bare relevante deler, og knytt dem konkret til kundens situasjon. Ikke list alt firmaet tilbyr ukritisk.",
        )
      : "",
    input.serviceSummaryContext,
    input.serviceDescriptionContext,
    input.artifactRetrievalContext,
    input.retrievalQualityContext,
    input.requirementSourceLedgerContext,
    input.requirementContinuityContext,
    input.requirementDocumentContext,
    input.bilag1SourceContext,
    generationInput.customerAnalysis
      ? buildDelimitedContext(
          "Kundeanalyse",
          summarizeCustomerAnalysis(generationInput.customerAnalysis),
        )
      : "",
    generationInput.solutionEvaluation
      ? buildDelimitedContext(
          "Løsningsvurdering",
          summarizeSolutionEvaluation(generationInput.solutionEvaluation),
        )
      : "",
    generationInput.customerDocument
      ? buildDelimitedContext(
          "Primært kundedokument sammendrag",
          compactText(generationInput.customerDocument.raw_text, 5000),
        )
      : "",
    input.customerDocumentDigest ?? "",
    generationInput.solutionDocument
      ? buildDelimitedContext(
          "Primært løsningsdokument sammendrag",
          compactText(generationInput.solutionDocument.raw_text, 5000),
        )
      : "",
    input.solutionDocumentDigest ?? "",
    input.supportingContexts,
    input.artifactKnowledge,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function artifactGenerationModel(
  artifactType: GeneratedArtifactType,
  override?: string,
) {
  return (
    override ??
    (artifactType === "forbedret_kravsvar" ||
    artifactType === "bilag1_rekonstruksjon"
      ? ANALYSIS_MODEL
      : FAST_MODEL)
  );
}

function completionInputForArtifact(
  input: ProjectArtifactGenerationInput,
  userPrompt: string,
) {
  return {
    system: buildGeneratorPrompt(input.artifactType),
    user: userPrompt,
    temperature: input.artifactType === "forbedret_kravsvar" ? 0.12 : 0.25,
    model: artifactGenerationModel(input.artifactType, input.model),
    reasoningEffort:
      input.artifactType === "forbedret_kravsvar" ||
      input.artifactType === "bilag1_rekonstruksjon"
        ? ANALYSIS_REASONING_EFFORT
        : FAST_REASONING_EFFORT,
    promptCacheKey: `artifact-generation-${input.artifactType}`,
  };
}

async function runFullDocumentArtifactGeneration(
  input: ProjectArtifactGenerationInput,
  completionInput: ReturnType<typeof completionInputForArtifact>,
  requirementContext: RequirementArtifactContext,
) {
  if (
    input.artifactType === "forbedret_kravsvar" &&
    requirementContext.requirementFileDocuments.length
  ) {
    try {
      const generated = await runWithProgressHeartbeat(
        {
          onProgress: input.onProgress,
          message:
            formatJobProgress(62, "Full-dokumentgenerering med filinput jobber fortsatt ..."),
        },
        () =>
          createJsonCompletionWithFileInputs<GeneratedArtifactDraft>({
            ...completionInput,
            user: [
              "Kravdokument-originalene er lagt ved som filinput. Bruk både maskinlesbar tekst og filstrukturen for krav i tabeller, regneark, bilder, figurer og diagrammer.",
              completionInput.user,
            ].join("\n\n"),
            fileDocuments: requirementContext.requirementFileDocuments,
            timeoutMs: REQUIREMENT_RESPONSE_FILE_INPUT_TIMEOUT_MS,
            maxRetries: 1,
          }).then(parseGeneratedArtifactDraft),
      );

      return withAlignedRequirementResponse(generated, requirementContext, {
        timeoutMs: REQUIREMENT_RESPONSE_FILE_INPUT_TIMEOUT_MS,
        fileInputUsed: true,
        solutionText: input.solutionDocument?.raw_text,
      });
    } catch (error) {
      assertProjectWorkflowActive();
      console.warn(
        JSON.stringify({
          event: "requirement_response_file_input_fallback",
          ...safeErrorTelemetry(error),
          file_count: requirementContext.requirementFileDocuments.length,
        }),
      );
      input.onProgress?.(
        formatJobProgress(64, "Filinput feilet eller tok for lang tid. Fortsetter med tekstbasert full-dokumentgenerering ..."),
      );
    }
  }

  const generated = await runWithProgressHeartbeat(
    {
      onProgress:
        input.artifactType === "forbedret_kravsvar" ? input.onProgress : undefined,
      message: formatJobProgress(68, "Tekstbasert full-dokumentgenerering jobber fortsatt ..."),
    },
    () =>
      createJsonCompletion<GeneratedArtifactDraft>({
        ...completionInput,
        timeoutMs:
          input.artifactType === "forbedret_kravsvar"
            ? REQUIREMENT_RESPONSE_FULL_DOCUMENT_TIMEOUT_MS
            : undefined,
        maxRetries: input.artifactType === "forbedret_kravsvar" ? 1 : undefined,
      }).then(parseGeneratedArtifactDraft),
  );

  return input.artifactType === "forbedret_kravsvar"
    ? withAlignedRequirementResponse(generated, requirementContext, {
        timeoutMs: REQUIREMENT_RESPONSE_FULL_DOCUMENT_TIMEOUT_MS,
        fileInputUsed: false,
        solutionText: input.solutionDocument?.raw_text,
      })
    : generated;
}

export async function generateProjectArtifact(input: ProjectArtifactGenerationInput) {
  const supportingContexts = buildSupportingArtifactContext(input);
  const serviceDocuments = serviceDocumentsForArtifact(input);
  const { serviceDescriptionContext, serviceSummaryContext } =
    buildServiceArtifactContexts(input, serviceDocuments);
  const bilag1SourceContext = buildBilag1SourceContext(input);
  const artifactKnowledge = buildArtifactKnowledgeContext(input);
  const primaryArtifactDigestsPromise = buildPrimaryArtifactDigests(input);
  const requirementContextPromise = buildRequirementArtifactContext(input);
  const artifactRetrievalContextPromise = buildArtifactRetrievalContext(
    input,
    serviceDocuments,
  );
  const [
    { customerDocumentDigest, solutionDocumentDigest },
    requirementContext,
    {
      artifactRetrievalContext,
      retrievalQualityContext,
      foundationFacts,
    },
  ] = await Promise.all([
    primaryArtifactDigestsPromise,
    requirementContextPromise,
    artifactRetrievalContextPromise,
  ]);

  if (requirementContext.useRequirementLedgerGeneration) {
    const requirementAnswer = buildRequirementAnswerFoundation({
      generationInput: input,
      requirementDocuments: requirementContext.requirementDocuments,
      foundationFacts,
      artifactRetrievalContext,
      retrievalQualityContext,
      serviceSummaryContext,
      serviceDescriptionContext,
      artifactKnowledge,
    });

    const generated = await generateRequirementResponseFromLedger({
      projectName: input.projectName,
      baseContext: requirementAnswer.baseContext,
      ledger: input.requirementRegeneration ? selectRequirementRegenerationLedger(requirementContext.requirementLedger, input.requirementRegeneration.parent, input.requirementRegeneration.selection) : requirementContext.requirementLedger,
      solutionDocument: input.solutionDocument,
      ledgerConfidence: requirementContext.requirementLedgerConfidence,
      requirementDocuments: requirementContext.requirementDocuments,
      supportingDocuments: requirementAnswer.supportingDocuments,
      serviceDocuments,
      model: input.model,
      onProgress: input.onProgress,
    });
    return input.requirementRegeneration ? mergeRegeneratedRequirementRows(input.requirementRegeneration.parent, input.requirementRegeneration.selection, generated, requirementContext.requirementLedger) : generated;
  }
  if (input.requirementRegeneration) throw new Error("Utvalgte krav kan bare regenereres fra et komplett kravregister.");

  const userPrompt = buildGeneralArtifactPrompt({
    generationInput: input,
    serviceSummaryContext,
    serviceDescriptionContext,
    artifactRetrievalContext,
    retrievalQualityContext,
    requirementSourceLedgerContext:
      requirementContext.requirementSourceLedgerContext,
    requirementContinuityContext: requirementContext.requirementContinuityContext,
    requirementDocumentContext: requirementContext.requirementDocumentContext,
    bilag1SourceContext,
    customerDocumentDigest,
    solutionDocumentDigest,
    supportingContexts,
    artifactKnowledge,
  });

  return runFullDocumentArtifactGeneration(
    input,
    completionInputForArtifact(input, userPrompt),
    requirementContext,
  );
}
