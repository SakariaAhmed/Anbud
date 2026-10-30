import "server-only";

import { isRequirementDocument } from "@/lib/document-processing";
import { isMarkdownTableDivider } from "@/lib/markdown-table-row";
import { formatJobProgress } from "@/lib/project-job-progress";
import {
  REQUIREMENT_RESPONSE_TABLE_HEADINGS,
  requirementResponseTableColumns,
} from "@/lib/requirement-response-table";

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
} from "@/lib/server/ai/context";

import { performance } from "node:perf_hooks";

import { stripCustomerAnalysisHistory } from "@/lib/customer-analysis-history";

import {
  isAiCallTimeoutError,
  runStructuredJsonResponse,
} from "@/lib/server/ai/json-completion";
import {
  stringList,
  stringFields,
  stringOr,
  untrustedObject,
  untrustedRows,
  type Untrusted,
} from "@/lib/unknown-values";
import {
  ANALYSIS_MODEL,
  ANALYSIS_REASONING_EFFORT,
  DOCUMENT_ANALYSIS_MODEL,
  EVALUATION_REASONING_EFFORT,
  FAST_MODEL,
  requirementResponseBatchModel,
  requirementResponseRepairModel,
  solutionEvaluationReasoningEffort,
  FAST_REASONING_EFFORT,
} from "@/lib/server/ai/model-config";
import { extractExactRetrievalTerms } from "@/lib/server/ai/retrieval-query";
import { buildVerifiedFoundationControls, documentedMigrationControl } from "@/lib/server/ai/verified-foundation-controls";
import {
  buildImmutableRequirementRowManifest,
  type ImmutableRequirementRowManifest,
} from "@/lib/server/artifact-validation";
import {
  retrieveDocumentSnippets,
  retrieveDocumentSnippetsWithMetadata,
} from "@/lib/server/document-chunks";
import { customerAnalysisPipeline } from "@/lib/server/document-intelligence/config";
import {
  resolveCustomerAnalysisContexts,
} from "@/lib/server/document-intelligence/customer-analysis-contexts";
import {
  MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS,
  customerAnalysisRegenerationContract,
  mergeCustomerAnalysisSectionPatch,
} from "@/lib/server/document-intelligence/customer-analysis-fields";
import {
  normalizeCustomerAnalysisResult,
  parsePrioritizedRequirements,
  normalizeMermaidDiagram,
  selectServiceRecommendationCandidates,
} from "@/lib/server/document-intelligence/customer-analysis-postprocess";
import {
  CUSTOMER_ANALYSIS_V3_JSON_SCHEMA,
  buildCustomerAnalysisV3SystemPrompt,
  buildCustomerAnalysisV3UserPrompt,
  customerAnalysisV3ContextUsage,
  enrichCustomerAnalysisWithCriticalFacts,
} from "@/lib/server/document-intelligence/customer-analysis-v3";

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
import {
  normalizeValueOpportunities,
} from "@/lib/server/document-intelligence/value-normalization";
import {
  buildOfferCoverageContext,
  buildOfferCoverageRetrievalSeed,
} from "@/lib/server/offer-coverage";

import { ProjectWorkflowTerminalMetadataError } from "@/lib/server/project-job-terminal-metadata";
import { WorkflowIncompleteError } from "@/lib/server/workflow-errors";
import {
  assertProjectWorkflowActive,
  bindProjectWorkflowTerminalMetadataReporter,
  boundedByProjectWorkflowDeadline,
  getProjectWorkflowAbortSignal,
  projectWorkflowRemainingMs,
} from "@/lib/server/project-workflow-cancellation";
import {
  buildCustomerAnalysisPrompt,
  buildDelimitedContext,
  buildGeneratorPrompt,
  buildHighLevelDesignPrompt,
  buildPromptTemplate,
  buildSolutionEvaluationPrompt,
} from "@/lib/server/prompts";
import {
  requirementBatchSystemPrompt,
  requirementCoverageSystemPrompt,
  requirementHandoffSystemPrompt,
} from "@/lib/server/prompts/requirements";

import {
  assertRequirementCoverageIntegrity,
} from "@/lib/server/requirements/evaluation-coverage-integrity";

import { detectExplicitRequirementIds } from "@/lib/server/requirements/id-detection";
import {
  assertRequirementLedgerQualityForEvaluation,
} from "@/lib/server/requirements/ledger-quality";
import {
  markdownTableCell,
  splitMarkdownTableRow,
  toMarkdownTableRow,
} from "@/lib/server/requirements/markdown-table";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";
import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";

import {
  requirementDisplayRef,
  requirementDisplaySource,
  requirementGroupHeading,
  requirementLedgerSource,
  requirementTableMarkdown,
  sortRequirementLedgerInDocumentOrder,
} from "@/lib/server/requirements/presentation";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import { correctedRequirementIds, withoutCorrectionsSection } from "@/lib/server/requirements/corrections";
import { spreadsheetRequirementIds } from "@/lib/server/requirements/spreadsheet-ledger";
import { productionSafeErrorMessage, safeErrorTelemetry } from "@/lib/server/safe-errors";
import {
  allRequirementsWithdrawn,
  assertExplicitRequirementLedgersComplete,
  canonicalRequirementSourceDocuments,
  canonicalizeRequirementSourceLedger,
  originalRequirementSourceIds,
} from "@/lib/server/requirements/source-readiness";
import { buildSolutionEvaluationProvenance } from "@/lib/server/workflow-boundaries";
import type {
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  GeneratedArtifactType,
  ProjectDocumentDetail,
  ProjectServiceDescription,
  ServiceDocument,
  ServiceDocumentDetail,
  SolutionEvaluationResult,
} from "@/lib/types";
import {
  buildRequirementContinuityContext,
  dedupeRequirementLedger,
  isGeneratedRequirementId,
  isSyntheticRequirementId,
  normalizeCoverageEvidenceText,
  normalizeRequirementLedgerText,
} from "@/lib/server/requirements/pdf-layout-ledger";
import {
  appendSentence,
  buildContinuationPageMap,
  buildRequirementPageEvidence,
  buildRequirementSourceLedgerContext,
  extractRequirementLedgerWithCorrections,
  isReliableRequirementLedger,
  mergeContinuationRowsInRequirementTable,
  requirementAnswerEvidence,
  requirementSourceExcerptWithoutAnswer,
  synthesizeRequirementLedgerRow,
  tableRequirementAnswer,
} from "@/lib/server/requirements/source-ledger";
import { textCoverageScore } from "@/lib/server/requirements/unstructured-ledger";
import {
  assertRequirementCoverageBatchesSucceeded,
  bindVerifiedSolutionQuote,
  requirementGenericStems,
  solutionDocumentContainsQuote,
  retryRequirementCoverageBatches,
  assertRequirementCoverageItemsAreReviewable,
  buildDeterministicControlRepairMetadata,
  buildDeterministicFinalRequirementControlRepair,
  buildDeterministicFinalRequirementTemplateRepair,
  buildRequirementCoverageBatchRegistry,
  buildRequirementCoverageEvaluationContext,
  buildRequirementCoverageLedger,
  buildRequirementCoverageLedgerFromDocuments,
  buildRequirementCoverageRetrievalContext,
  buildRequirementCoverageSummary,
  buildRequirementRepairDirective,
  buildRequirementResponseBatchRegistry,
  coverageConfidenceFromLedger,
  coverageItemFromBatchRow,
  type DeterministicControlRepairPattern,
  type DeterministicControlRepairStage,
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
  type RequirementLedgerConfidence,
  requiresExpandedRequirementAnswer,
  selectRequirementsForSolutionCoverage,
  STANDARD_SUPPLIER_PERFORMANCE_BASELINE,
  supplierAnswerNeedsConfirmation,
  suppressDuplicatedDocumentLedgerContext,
  validateRequirementCoverageBatchRows,
} from "@/lib/server/ai/requirement-coverage";
import {
  documentedPerformanceTargets,
  isNoMaterialSlownessDimensioningRequirement,
  normalizeRequirementAnswerResult,
  type RequirementAnswerResult,
  type RequirementAnswerSource,
} from "@/lib/server/requirements/answer-quality";

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

type DocumentTextChunk = {
  label: string;
  text: string;
  references: string[];
};

type DocumentInsightCache = Map<string, Promise<string | null>>;
type RequirementBatchAnswer = {
  nr?: number;
  ref?: string;
  svar?: string;
  answer?: string;
  svargrunnlag?: string;
  evidence?: string;
  bevis?: string;
  source_ref?: string;
  sourceReference?: string;
  kildegrunnlag?: string;
  source?: string;
};

function parseRequirementBatchRows(value: unknown): RequirementBatchAnswer[] {
  return untrustedRows<RequirementBatchAnswer>(value).map((row) => ({
    ...(typeof row.nr === "number" ? { nr: row.nr } : {}),
    ...stringFields(row, [
      "ref",
      "svar",
      "answer",
      "svargrunnlag",
      "evidence",
      "bevis",
      "source_ref",
      "sourceReference",
      "kildegrunnlag",
      "source",
    ]),
  }));
}
type RequirementResponseGenerationMetadata = {
  method: "ledger_batch" | "full_document";
  total_requirements?: number;
  batch_count?: number;
  failed_batches?: number;
  deterministic_fallback_answers_after_batch?: number;
  deterministic_fallback_answers_before_handoff?: number;
  deterministic_fallback_answers_after_handoff?: number;
  exact_duplicate_reuse_answers?: number;
  exact_duplicate_reuse_refs?: string[];
  deterministic_template_repair_answers?: number;
  deterministic_template_repair_refs?: string[];
  deterministic_template_repair_rows?: Array<{
    ref: string;
    order_index: number;
    source_document_id: string | null;
    source_locator: string;
  }>;
  deterministic_control_repair_answers?: number;
  deterministic_control_repair_answers_before_handoff?: number;
  deterministic_control_repair_answers_during_handoff?: number;
  deterministic_control_repair_refs?: string[];
  deterministic_control_repair_rows?: Array<{
    ref: string;
    pattern: DeterministicControlRepairPattern;
    order_index: number;
    source_document_id: string | null;
    source_locator: string;
    repair_stage?: DeterministicControlRepairStage;
  }>;
  proposal_input_required_count?: number;
  proposal_input_required_refs?: string[];
  proposal_input_required_rows?: Array<{
    ref: string;
    reasons: ProposalInputRequirementReason[];
    order_index: number;
    source_document_id: string | null;
    source_locator: string;
  }>;
  manual_review_required?: boolean;
  manual_review_note?: string;
  unresolved_fallback_answers?: Array<{
    nr: number;
    ref: string;
    reason?: string;
    rejected_answer_sample?: string;
  }>;
  full_document_handoff?: {
    attempted: boolean;
    attempted_requirements: number;
    repaired_requirements: number;
    deterministic_control_repaired_requirements?: number;
    deterministic_template_repaired_requirements?: number;
    failed_batches: number;
    duration_ms: number;
    strict_handoff?: {
      outcome: "not_needed" | "completed" | "failed_closed";
      terminal_reason:
        | "deadline_exceeded"
        | "call_budget_exhausted"
        | "repair_unresolved"
        | null;
      configured_call_budget: number;
      configured_deadline_ms: number;
      configured_concurrency: number;
      strict_candidates: number;
      calls_started: number;
      repairs_accepted: number;
      calls_without_accepted_repair: number;
      skipped_call_budget: number;
      skipped_deadline: number;
      unresolved_after_handoff: number;
    };
  };
  full_document_timeout_ms?: number;
  file_input_used?: boolean;
  requirement_refs?: string[];
  immutable_row_manifest?: ImmutableRequirementRowManifest;
  coverage_enforced?: boolean;
  source_evidence_enforced?: boolean;
  coverage_note?: string;
  ledger_confidence?: RequirementLedgerConfidence;
};

type ProposalInputRequirementReason =
  | "supplier_references"
  | "candidate_cvs"
  | "security_assurance_evidence"
  | "commercial_terms"
  | "supplier_policy_or_experience"
  | "explicit_bid_decision";

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
const CHUNK_TEXT_LIMIT = 6500;
const MAX_DOCUMENT_CHUNKS = 8;
const DOCUMENT_INSIGHT_CACHE_MAX_ENTRIES = 200;
const CHUNK_CONCURRENCY = 3;
const SINGLE_BATCH_REQUIREMENT_RESPONSE_MAX = 18;
const REQUIREMENT_RESPONSE_BATCH_SIZE = parsePositiveIntegerEnv(
  "REQUIREMENT_RESPONSE_BATCH_SIZE",
  12,
);
// Measured gpt-5.4 latency for 28-row batches (~70K chars) reached the
// 120 s timeout; large ledgers now use the normal batch size.
const LARGE_REQUIREMENT_RESPONSE_BATCH_SIZE = parsePositiveIntegerEnv(
  "LARGE_REQUIREMENT_RESPONSE_BATCH_SIZE",
  12,
);
const REQUIREMENT_RESPONSE_BATCH_CONCURRENCY = parsePositiveIntegerEnv(
  "REQUIREMENT_RESPONSE_BATCH_CONCURRENCY",
  4,
);
const REQUIREMENT_RESPONSE_RETRIEVAL_CONCURRENCY = parsePositiveIntegerEnv(
  "REQUIREMENT_RESPONSE_RETRIEVAL_CONCURRENCY",
  REQUIREMENT_RESPONSE_BATCH_CONCURRENCY,
);
const REQUIREMENT_RESPONSE_BATCH_TIMEOUT_MS = boundedIntegerEnv(
  process.env,
  "REQUIREMENT_RESPONSE_BATCH_TIMEOUT_MS",
  180_000,
  30_000,
  600_000,
);
// Time kept free for handoff, strict repair and persistence while batches run.
const REQUIREMENT_RESPONSE_BATCH_DEADLINE_RESERVE_MS = 300_000;
const REQUIREMENT_RESPONSE_SPLIT_RETRY_DEADLINE_RESERVE_MS = 240_000;
const REQUIREMENT_RESPONSE_HANDOFF_DEADLINE_RESERVE_MS = 150_000;
const REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEADLINE_RESERVE_MS = 60_000;
const REQUIREMENT_RESPONSE_FULL_DOCUMENT_TIMEOUT_MS = 220_000;
const REQUIREMENT_RESPONSE_FILE_INPUT_TIMEOUT_MS = 240_000;
const REQUIREMENT_RESPONSE_HANDOFF_TIMEOUT_MS = boundedIntegerEnv(
  process.env,
  "REQUIREMENT_RESPONSE_HANDOFF_TIMEOUT_MS",
  150_000,
  30_000,
  600_000,
);
const REQUIREMENT_RESPONSE_STRICT_HANDOFF_TIMEOUT_MS = 45_000;
const REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEFAULT_MAX_CALLS = 12;
const REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEFAULT_DEADLINE_MS = 120_000;
const REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEFAULT_CONCURRENCY = 2;
const REQUIREMENT_RESPONSE_STRICT_HANDOFF_MIN_CALL_WINDOW_MS = 5_000;
const REQUIREMENT_RESPONSE_HANDOFF_BATCH_SIZE = 10;
const REQUIREMENT_RESPONSE_HANDOFF_STYLE_EXAMPLE_LIMIT = 3;
const REQUIREMENT_RESPONSE_HANDOFF_CONCURRENCY = parsePositiveIntegerEnv(
  "REQUIREMENT_RESPONSE_HANDOFF_CONCURRENCY",
  2,
);
const REQUIREMENT_RESPONSE_PROGRESS_HEARTBEAT_MS = 35_000;
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
const CUSTOMER_ANALYSIS_TIMEOUT_MS = boundedIntegerEnv(
  process.env,
  "CUSTOMER_ANALYSIS_TIMEOUT_MS",
  300_000,
  60_000,
  840_000,
);
const REQUIREMENT_COVERAGE_FULL_SOLUTION_MAX_CHARS = boundedIntegerEnv(
  process.env,
  "REQUIREMENT_COVERAGE_FULL_SOLUTION_MAX_CHARS",
  45_000,
  0,
  120_000,
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
const REQUIREMENT_RETRIEVAL_STOP_WORDS = new Set([
  "atea",
  "eller",
  "etter",
  "for",
  "fra",
  "gjennom",
  "hvor",
  "ikke",
  "innen",
  "krav",
  "kravet",
  "kunde",
  "kunden",
  "kunne",
  "med",
  "mot",
  "skal",
  "som",
  "the",
  "til",
  "ved",
]);

function boundedIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function resolveRequirementResponseStrictHandoffLimits(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    maxCalls: boundedIntegerEnv(
      env,
      "REQUIREMENT_RESPONSE_STRICT_HANDOFF_MAX_CALLS",
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEFAULT_MAX_CALLS,
      0,
      32,
    ),
    deadlineMs: boundedIntegerEnv(
      env,
      "REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEADLINE_MS",
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEFAULT_DEADLINE_MS,
      10_000,
      300_000,
    ),
    concurrency: boundedIntegerEnv(
      env,
      "REQUIREMENT_RESPONSE_STRICT_HANDOFF_CONCURRENCY",
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEFAULT_CONCURRENCY,
      1,
      4,
    ),
    minCallWindowMs: REQUIREMENT_RESPONSE_STRICT_HANDOFF_MIN_CALL_WINDOW_MS,
    callTimeoutMs: REQUIREMENT_RESPONSE_STRICT_HANDOFF_TIMEOUT_MS,
  };
}

type StrictHandoffSkipReason =
  | "call_budget_exhausted"
  | "deadline_exceeded";

export function createRequirementResponseStrictHandoffGovernor(input?: {
  limits?: ReturnType<typeof resolveRequirementResponseStrictHandoffLimits>;
  now?: () => number;
  signal?: AbortSignal;
  assertActive?: () => void;
  /** Time left before the job deadline, minus a persistence reserve. */
  workflowRemainingMs?: () => number;
}) {
  const limits = input?.limits ?? resolveRequirementResponseStrictHandoffLimits();
  const now = input?.now ?? (() => performance.now());
  const workflowRemainingMs =
    input?.workflowRemainingMs ??
    (() =>
      projectWorkflowRemainingMs() -
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEADLINE_RESERVE_MS);
  const signal = input?.signal ?? getProjectWorkflowAbortSignal();
  const assertActive = input?.assertActive ?? assertProjectWorkflowActive;
  const waiters: Array<{
    activate: () => void;
    reject: (reason?: unknown) => void;
    onAbort?: () => void;
  }> = [];
  let active = 0;
  let deadlineStartedAt: number | null = null;
  let strictCandidates = 0;
  let callsStarted = 0;
  let repairsAccepted = 0;
  let skippedCallBudget = 0;
  let skippedDeadline = 0;

  function abortReason() {
    return signal?.reason ?? new Error("Strict handoff ble avbrutt.");
  }

  function acquireSlot() {
    assertActive();
    signal?.throwIfAborted();
    if (active < limits.concurrency) {
      active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof waiters)[number] = {
        reject,
        activate: () => {
          if (waiter.onAbort) {
            signal?.removeEventListener("abort", waiter.onAbort);
          }
          active += 1;
          resolve();
        },
      };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(abortReason());
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
    });
  }

  function releaseSlot() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    next?.activate();
  }

  return {
    limits,
    async run<T>(operation: (timeoutMs: number) => Promise<T>): Promise<
      | { status: "completed"; value: T }
      | { status: "skipped"; reason: StrictHandoffSkipReason }
    > {
      strictCandidates += 1;
      deadlineStartedAt ??= now();
      await acquireSlot();
      try {
        assertActive();
        signal?.throwIfAborted();
        if (callsStarted >= limits.maxCalls) {
          skippedCallBudget += 1;
          return { status: "skipped", reason: "call_budget_exhausted" };
        }

        const elapsedMs = Math.max(0, now() - deadlineStartedAt);
        const remainingMs = Math.min(
          limits.deadlineMs - elapsedMs,
          workflowRemainingMs(),
        );
        if (remainingMs < limits.minCallWindowMs) {
          skippedDeadline += 1;
          return { status: "skipped", reason: "deadline_exceeded" };
        }

        callsStarted += 1;
        const value = await operation(
          Math.min(limits.callTimeoutMs, remainingMs),
        );
        return { status: "completed", value };
      } finally {
        releaseSlot();
      }
    },
    recordAcceptedRepair() {
      repairsAccepted += 1;
    },
    snapshot(
      unresolvedAfterHandoff = 0,
      terminalReasonOverride?:
        | "deadline_exceeded"
        | "call_budget_exhausted"
        | "repair_unresolved",
    ) {
      const terminalReason:
        | "deadline_exceeded"
        | "call_budget_exhausted"
        | "repair_unresolved"
        | null =
        unresolvedAfterHandoff > 0
          ? terminalReasonOverride
            ? terminalReasonOverride
            : skippedDeadline > 0
            ? "deadline_exceeded"
            : skippedCallBudget > 0
              ? "call_budget_exhausted"
              : "repair_unresolved"
          : null;
      const outcome: "not_needed" | "completed" | "failed_closed" =
        unresolvedAfterHandoff > 0
          ? "failed_closed"
          : strictCandidates === 0
            ? "not_needed"
            : "completed";
      return {
        outcome,
        terminal_reason: terminalReason,
        configured_call_budget: limits.maxCalls,
        configured_deadline_ms: limits.deadlineMs,
        configured_concurrency: limits.concurrency,
        strict_candidates: strictCandidates,
        calls_started: callsStarted,
        repairs_accepted: repairsAccepted,
        calls_without_accepted_repair: Math.max(
          0,
          callsStarted - repairsAccepted,
        ),
        skipped_call_budget: skippedCallBudget,
        skipped_deadline: skippedDeadline,
        unresolved_after_handoff: unresolvedAfterHandoff,
      };
    },
  };
}

export function createRequirementResponseHandoffProgressTracker(
  candidateIndexes: readonly number[],
) {
  const candidates = new Set(candidateIndexes);
  const resolved = new Set<number>();
  return {
    markResolved(index: number) {
      if (candidates.has(index)) {
        resolved.add(index);
      }
    },
    unresolvedCount() {
      return candidates.size - resolved.size;
    },
  };
}

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

function alignRequirementRowsWithLedger(
  contentMarkdown: string,
  ledger: RequirementLedgerEntry[],
) {
  if (!ledger.length) {
    return contentMarkdown;
  }

  const lines = contentMarkdown.split("\n");
  const nextLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim().startsWith("|")) {
      nextLines.push(line);
      index += 1;
      continue;
    }

    const headerCells = splitMarkdownTableRow(line);
    const columns = requirementResponseTableColumns(headerCells);
    let { sourceIndex, evidenceIndex } = columns;
    const { refIndex, requirementIndex, answerIndex } = columns;

    if (
      sourceIndex < 0 ||
      refIndex < 0 ||
      requirementIndex < 0 ||
      answerIndex < 0 ||
      !isMarkdownTableDivider(lines[index + 1] ?? "")
    ) {
      nextLines.push(line);
      index += 1;
      continue;
    }

    const insertedEvidenceColumn = evidenceIndex < 0;
    if (insertedEvidenceColumn) {
      evidenceIndex = sourceIndex;
      headerCells.splice(evidenceIndex, 0, REQUIREMENT_RESPONSE_TABLE_HEADINGS[3]);
      sourceIndex += 1;
    }

    const tableLines = [line, lines[index + 1] ?? ""];
    index += 2;
    while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
      tableLines.push(lines[index] ?? "");
      index += 1;
    }

    const rows = tableLines.slice(2).map((rowLine) => {
      const row = splitMarkdownTableRow(rowLine);
      if (insertedEvidenceColumn) {
        row.splice(evidenceIndex, 0, "");
      }
      while (row.length < headerCells.length) {
        row.push("");
      }
      return row;
    });
    const alignedRows: string[][] = [];
    let rowCursor = 0;

    for (const entry of ledger) {
      const matchedRows: string[][] = [];
      let combinedRequirementText = "";
      let scan = rowCursor;
      let bestCoverage = 0;

      while (scan < rows.length && matchedRows.length < 4) {
        const candidate = rows[scan];
        const candidateId = normalizeRequirementId(candidate?.[refIndex] ?? "");
        const expectedId = normalizeRequirementId(entry.id);
        const candidateText = candidate?.[requirementIndex] ?? "";
        const nextCombined = appendSentence(combinedRequirementText, candidateText);
        const coverage = textCoverageScore(entry.text, nextCombined);
        const isExpectedId = candidateId === expectedId;
        const improvesCurrentMatch = matchedRows.length > 0 && coverage > bestCoverage;

        if (isExpectedId || coverage >= 0.55 || improvesCurrentMatch) {
          matchedRows.push(candidate);
          combinedRequirementText = nextCombined;
          bestCoverage = Math.max(bestCoverage, coverage);
          scan += 1;
          if (coverage >= 0.88) {
            break;
          }
          continue;
        }

        if (!matchedRows.length) {
          scan += 1;
          continue;
        }
        break;
      }

      if (!matchedRows.length) {
        alignedRows.push(
          synthesizeRequirementLedgerRow(
            entry,
            {
              refIndex,
              requirementIndex,
              answerIndex,
              evidenceIndex,
              sourceIndex,
            },
            headerCells.length,
          ),
        );
        continue;
      }

      rowCursor = scan;
      const base = [...matchedRows[0]];
      base[refIndex] = requirementDisplayRef(entry, requirementGroupHeading(entry));
      base[requirementIndex] = entry.text;
      base[answerIndex] = matchedRows
        .map((row) => row[answerIndex] ?? "")
        .filter(Boolean)
        .reduce((left, right) => appendSentence(left, right), "");
      base[evidenceIndex] = requirementAnswerEvidence(
        entry,
        matchedRows
          .map((row) => row[evidenceIndex] ?? "")
          .filter(Boolean)
          .reduce((left, right) => appendSentence(left, right), ""),
      );
      base[sourceIndex] = requirementLedgerSource(entry);
      alignedRows.push(base);
    }

    nextLines.push(toMarkdownTableRow(headerCells));
    nextLines.push(toMarkdownTableRow(headerCells.map(() => "---")));
    nextLines.push(...(alignedRows.length ? alignedRows : rows).map(toMarkdownTableRow));
  }

  return nextLines.join("\n");
}

function ratio(part: number, total: number) {
  return total > 0 ? part / total : 0;
}

function roundedRatio(value: number) {
  return Math.round(value * 100) / 100;
}

function requirementLedgerEntryHasLocator(entry: RequirementLedgerEntry) {
  return Boolean(
    entry.sourceExcerpt ||
      entry.tableId ||
      entry.heading ||
      (Array.isArray(entry.pages) && entry.pages.length > 0),
  );
}

function requirementLedgerEntryIsStructured(entry: RequirementLedgerEntry) {
  return Boolean(
    entry.tableId ||
      entry.sourceExcerpt ||
      entry.answerExcerpt ||
      entry.pages.length > 0,
  );
}

function normalizedExplicitCompletenessId(value: string) {
  return normalizeRequirementId(value)
    .replace(/^TABELL\s+/i, "")
    .replace(/[^A-Z0-9ÆØÅ]+/gi, "")
    .toLocaleUpperCase("nb");
}

export function hasExplicitlyCompleteSmallRequirementLedger(input: {
  ledger: RequirementLedgerEntry[];
  requirementDocuments: ProjectDocumentDetail[];
}) {
  if (
    input.ledger.length === 0 ||
    input.ledger.length > 4 ||
    input.requirementDocuments.length === 0
  ) {
    return false;
  }

  const requirementDocumentIds = new Set(
    input.requirementDocuments.map((document) => document.id),
  );
  if (
    input.ledger.some(
      (entry) => !entry.documentId || !requirementDocumentIds.has(entry.documentId),
    )
  ) {
    return false;
  }

  return input.requirementDocuments.every((document) => {
    const documentEntries = input.ledger.filter(
      (entry) => entry.documentId === document.id,
    );
    if (!documentEntries.length) {
      return allRequirementsWithdrawn(document);
    }

    const sourceIds = spreadsheetRequirementIds(document);
    const detectedIds = correctedRequirementIds(
      sourceIds.length ? sourceIds : detectExplicitRequirementIds(withoutCorrectionsSection(document.raw_text)),
      document.raw_text,
    )
      .map(normalizedExplicitCompletenessId)
      .filter(Boolean);
    if (detectedIds.length !== documentEntries.length) {
      return false;
    }

    const remainingIds = [...detectedIds];
    return documentEntries.every((entry) => {
      if (
        isGeneratedRequirementId(entry.id) ||
        !requirementLedgerEntryHasLocator(entry) ||
        !requirementLedgerEntryIsStructured(entry) ||
        entry.text.replace(/\s+/g, " ").trim().length < 20
      ) {
        return false;
      }

      const candidates = [entry.id, entry.tableId ?? ""]
        .map(normalizedExplicitCompletenessId)
        .filter(Boolean);
      const detectedIndex = remainingIds.findIndex((detectedId) =>
        candidates.includes(detectedId),
      );
      if (detectedIndex < 0) {
        return false;
      }

      remainingIds.splice(detectedIndex, 1);
      return true;
    });
  });
}

function requirementLedgerExtractionMethods(entries: RequirementLedgerEntry[]) {
  const methods = new Set<string>();
  for (const entry of entries) {
    const source = `${entry.tableId ?? ""} ${entry.heading ?? ""}`;
    if (/docling/i.test(source)) methods.add("docling");
    if (/docx/i.test(source)) methods.add("docx-table");
    if (/strukturert/i.test(source)) methods.add("structured-table");
    if (entry.sourceExcerpt) methods.add("source-excerpt");
    if (entry.pages.length) methods.add("page-locator");
  }

  return Array.from(methods).sort();
}

function assessRequirementLedgerConfidence(input: {
  ledger: RequirementLedgerEntry[];
  hasExplicitRequirementDocuments: boolean;
  requirementDocuments: ProjectDocumentDetail[];
}): RequirementLedgerConfidence {
  const count = input.ledger.length;
  const locatorCoverage = ratio(
    input.ledger.filter(requirementLedgerEntryHasLocator).length,
    count,
  );
  const structuredRatio = ratio(
    input.ledger.filter(requirementLedgerEntryIsStructured).length,
    count,
  );
  const generatedReferenceCount = input.ledger.filter((entry) =>
    isGeneratedRequirementId(entry.id),
  ).length;
  const explicitReferenceRatio = ratio(count - generatedReferenceCount, count);
  const countScore =
    count >= 20 ? 1 : count >= 8 ? 0.75 : count >= 5 ? 0.5 : count > 0 ? 0.25 : 0;
  const score = roundedRatio(
    countScore * 0.35 +
      locatorCoverage * 0.35 +
      structuredRatio * 0.2 +
      explicitReferenceRatio * 0.1,
  );
  const hasRequirementDocumentSignal =
    input.hasExplicitRequirementDocuments ||
    input.requirementDocuments.some(isRequirementDocument);
  const explicitlyCompleteSmallLedger =
    hasExplicitlyCompleteSmallRequirementLedger({
      ledger: input.ledger,
      requirementDocuments: input.requirementDocuments,
    });
  const reasons: string[] = [];

  if (count === 0) reasons.push("no_requirements_found");
  if (isReliableRequirementLedger(input.ledger)) reasons.push("reliable_ledger_shape");
  if (hasRequirementDocumentSignal) reasons.push("requirement_document_selected");
  if (locatorCoverage >= 0.9) reasons.push("source_locators_present");
  if (locatorCoverage < 0.6) reasons.push("weak_source_locator_coverage");
  if (structuredRatio >= 0.7) reasons.push("structured_rows_present");
  if (generatedReferenceCount > 0) reasons.push("generated_requirement_refs");
  if (explicitlyCompleteSmallLedger) {
    reasons.push("explicitly_complete_small_ledger");
  }

  const level =
    explicitlyCompleteSmallLedger && score >= 0.7
      ? "medium"
      : count >= 8 && locatorCoverage >= 0.85 && score >= 0.7
      ? "high"
      : count >= 5 && locatorCoverage >= 0.6 && score >= 0.55
        ? "medium"
        : "low";

  return {
    level,
    score,
    requirement_count: count,
    source_locator_coverage: roundedRatio(locatorCoverage),
    structured_entry_ratio: roundedRatio(structuredRatio),
    explicit_reference_ratio: roundedRatio(explicitReferenceRatio),
    generated_reference_count: generatedReferenceCount,
    extraction_methods: requirementLedgerExtractionMethods(input.ledger),
    reasons,
  };
}

function shouldUseRequirementLedgerGeneration(input: {
  ledger: RequirementLedgerEntry[];
  hasExplicitRequirementDocuments: boolean;
  requirementDocuments: ProjectDocumentDetail[];
  confidence: RequirementLedgerConfidence;
}) {
  const hasUsableLedger = input.ledger.some(
    (entry) => entry.text.replace(/\s+/g, " ").trim().length >= 20,
  );
  if (!hasUsableLedger) {
    return false;
  }

  if (input.confidence.level === "low") {
    return false;
  }

  return (
    input.hasExplicitRequirementDocuments ||
    input.requirementDocuments.some(isRequirementDocument) ||
    isReliableRequirementLedger(input.ledger) ||
    input.ledger.filter((entry) => !isSyntheticRequirementId(entry.id)).length >= 5
  );
}

function requirementCoverageBatchModel(model?: string) {
  const normalized = model?.trim();
  if (!normalized || /(?:mini|nano)$/i.test(normalized)) {
    return ANALYSIS_MODEL;
  }

  return normalized;
}

function chunkRequirements(entries: RequirementLedgerEntry[]) {
  if (entries.length <= SINGLE_BATCH_REQUIREMENT_RESPONSE_MAX) {
    return [
      {
        startIndex: 0,
        entries,
      },
    ];
  }

  const batchSize =
    entries.length >= 80
      ? LARGE_REQUIREMENT_RESPONSE_BATCH_SIZE
      : REQUIREMENT_RESPONSE_BATCH_SIZE;
  const chunks: Array<{
    startIndex: number;
    entries: RequirementLedgerEntry[];
  }> = [];

  for (
    let startIndex = 0;
    startIndex < entries.length;
    startIndex += batchSize
  ) {
    chunks.push({
      startIndex,
      entries: entries.slice(
        startIndex,
        startIndex + batchSize,
      ),
    });
  }

  return chunks;
}

function chunkRequirementHandoffRows(
  rows: Array<{
    absoluteIndex: number;
    entry: RequirementLedgerEntry;
    current: RequirementAnswerResult;
  }>,
) {
  const chunks: Array<typeof rows> = [];
  for (
    let startIndex = 0;
    startIndex < rows.length;
    startIndex += REQUIREMENT_RESPONSE_HANDOFF_BATCH_SIZE
  ) {
    chunks.push(
      rows.slice(startIndex, startIndex + REQUIREMENT_RESPONSE_HANDOFF_BATCH_SIZE),
    );
  }

  return chunks;
}

export function limitRequirementHandoffStyleExamples<T>(rows: T[]) {
  return rows.slice(0, REQUIREMENT_RESPONSE_HANDOFF_STYLE_EXAMPLE_LIMIT);
}

function buildRequirementHandoffDocumentContext(
  documents: ProjectDocumentDetail[],
) {
  if (!documents.length) {
    return "";
  }

  const perDocumentTextLimit = Math.max(
    1200,
    Math.floor(36_000 / Math.max(1, documents.length)),
  );
  const perDocumentStructureLimit = Math.max(
    2,
    Math.floor(60 / Math.max(1, documents.length)),
  );

  return documents
    .map((document, index) =>
      documentContext(
        `Kravdokument full-dokument handoff ${index + 1}`,
        document,
        {
          textLimit: perDocumentTextLimit,
          structureLimit: perDocumentStructureLimit,
          structureTextLimit: 180,
        },
      ),
    )
    .join("\n\n");
}

const REQUIREMENT_REPAIR_CLARIFICATION_BOUNDARY =
  `Ikke plasser teknisk kjerneomfang og avklaringsspråk i samme setning. For dimensjoneringskrav skal første setning forplikte kapasitetsmodell eller baseline, last-/ytelsestest, skalering eller eksplisitt dimensjonert/provisjonert kapasitet og reservekapasitet/kapasitetsmargin nå. Når kunden ikke har oppgitt tall, skal neste setning bruke den konfigurerte leverandørbaselinen eksakt (${STANDARD_SUPPLIER_PERFORMANCE_BASELINE}) som Ateas leverandørforslag og bindende akseptansekriterium for de samme transaksjonene; både responstid og lastprofil må merkes som leverandørens tilbudte forutsetning, ikke som kundekrav, ingen andre ytelsestall er tillatt, og baselinen kan ikke utsettes som en åpen avklaring.`;
const DETERMINISTIC_TEMPLATE_REPAIR_MANUAL_REVIEW_NOTE =
  "Standardformulering er brukt for disse kravradene og krever manuell gjennomgang og kundetilpasning før innlevering.";

function needsDimensioningDeferredCoreRepairPrompt(
  rejectionReason: unknown,
  requirementText: unknown,
) {
  return (
    typeof rejectionReason === "string" &&
    (rejectionReason.includes("deferred_core_scope") ||
      rejectionReason.includes(
        "missing_supplier_proposed_numeric_performance_target",
      )) &&
    typeof requirementText === "string" &&
    isNoMaterialSlownessDimensioningRequirement(
      normalizeRequirementLedgerText(requirementText),
    )
  );
}

export function requirementAnswerForRepair(answer: RequirementAnswerResult) {
  return compactText(answer.rejectedAnswer ?? answer.answer, 700);
}

export function buildStrictRequirementHandoffUserPrompt(input: {
  projectName: string;
  acceptedAnswerContext: Array<{
    nr: number;
    ref: string;
    svar: string;
    svargrunnlag: string;
    source: RequirementAnswerSource;
  }>;
  strictRow: Record<string, unknown>;
}) {
  const styleExamples = input.acceptedAnswerContext.slice(0, 3);
  const strictRequirementText =
    typeof input.strictRow.kravtekst === "string"
      ? normalizeRequirementLedgerText(input.strictRow.kravtekst)
      : "";
  const permitsSupplierPerformanceTarget =
    isNoMaterialSlownessDimensioningRequirement(strictRequirementText) &&
    input.strictRow.har_dokumenterte_ytelsesmaal !== true;
  return [
    "Reparer denne ene kravraden i JSON. Forrige reparasjon ble avvist som for svak, for generisk eller for lik kravteksten.",
    permitsSupplierPerformanceTarget
      ? `Feltene avvist_arsak og obligatorisk_svarstruktur er en bindende sjekkliste: lukk hvert opplistet punkt synlig i det nye svaret. Bruk den konkrete produktnøytrale baselinen og den konfigurerte leverandørbaselinen eksakt (${STANDARD_SUPPLIER_PERFORMANCE_BASELINE}); både responstid og lastprofil skal merkes som Ateas tilbudte leverandørforutsetning og bindes til de samme transaksjonene og akseptansekriteriet i samme setning. Ikke presenter tallene som kundetall fra kilden, og ikke dikt andre tall, kundedata eller kundespesifikke endepunkter.`
      : "Feltene avvist_arsak og obligatorisk_svarstruktur er en bindende sjekkliste: lukk hvert opplistet punkt synlig i det nye svaret. Bruk den konkrete produktnøytrale baselinen, men ikke dikt tall, kundedata eller kundespesifikke endepunkter.",
    needsDimensioningDeferredCoreRepairPrompt(
      input.strictRow.avvist_arsak,
      input.strictRow.kravtekst,
    )
      ? REQUIREMENT_REPAIR_CLARIFICATION_BOUNDARY
      : "",
    requiresExpandedRequirementAnswer(strictRequirementText)
      ? "Svar må være 2-4 konsise setninger slik at alle delkrav i den bindende sjekklisten blir eksplisitte, og må inneholde konkrete operasjonelle elementer som leveranse, test, måling, kontroll, ansvar, dokumentasjon eller rapportering. Ikke svar bare ja/oppfylt."
      : "Svar må være 1-2 konkrete setninger og må inneholde minst ett operasjonelt element: leveranse, test, måling, kontroll, ansvar, dokumentasjon eller rapportering. Ikke svar bare ja/oppfylt.",
    "Hvis kravet har tallfestet terskel, behold terskelen og forklar hvordan den verifiseres eller måles.",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    styleExamples.length
      ? buildDelimitedContext(
          "Godkjente batchsvar for stil og konsistens",
          JSON.stringify(styleExamples),
        )
      : "",
    buildDelimitedContext(
      "Krav som skal repareres",
      JSON.stringify([input.strictRow]),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function repairSingleRequirementAnswerWithStrictHandoff(input: {
  projectName: string;
  acceptedAnswerContext: Array<{
    nr: number;
    ref: string;
    svar: string;
    svargrunnlag: string;
    source: RequirementAnswerSource;
  }>;
  row: {
    absoluteIndex: number;
    entry: RequirementLedgerEntry;
    current: RequirementAnswerResult;
  };
  rejectionReason?: string;
  model?: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}) {
  input.onProgress?.(
    formatJobProgress(82, "Full-dokument handoff gjør målrettet retry for svakt kravsvar ..."),
  );

  const heading = requirementGroupHeading(input.row.entry);
  const repairDirective = buildRequirementRepairDirective(
    input.row.entry,
    input.rejectionReason ?? input.row.current.reason ?? "",
  );
  const strictRow = {
    nr: input.row.absoluteIndex + 1,
    ref: requirementDisplayRef(input.row.entry, heading),
    kravtekst: compactText(input.row.entry.text, 1100),
    radutdrag: input.row.entry.sourceExcerpt
      ? compactText(input.row.entry.sourceExcerpt, 900)
      : undefined,
    kildegrunnlag: requirementDisplaySource(input.row.entry, heading),
    har_dokumenterte_ytelsesmaal:
      documentedPerformanceTargets(input.row.entry).length > 0,
    svargrunnlag: requirementAnswerEvidence(
      input.row.entry,
      input.row.current.evidence,
    ),
    avvist_svar: requirementAnswerForRepair(input.row.current),
    avvist_arsak: input.rejectionReason ?? input.row.current.reason ?? "",
    ...(repairDirective
      ? { obligatorisk_svarstruktur: repairDirective }
      : {}),
  };

  try {
    const generated = await createJsonCompletion<{
      rows?: RequirementBatchAnswer[];
    }>({
      system: requirementHandoffSystemPrompt(),
      user: buildStrictRequirementHandoffUserPrompt({
        projectName: input.projectName,
        acceptedAnswerContext: input.acceptedAnswerContext,
        strictRow,
      }),
      temperature: 0.1,
      model: requirementResponseRepairModel(input.model),
      reasoningEffort: ANALYSIS_REASONING_EFFORT,
      timeoutMs:
        input.timeoutMs ?? REQUIREMENT_RESPONSE_STRICT_HANDOFF_TIMEOUT_MS,
      maxRetries: 0,
      promptCacheKey: "requirement-response-handoff",
    });
    const rows = parseRequirementBatchRows(generated.rows);
    validateRequirementResponseBatchRows({
      rows,
      entries: [input.row.entry],
      expectedNumbers: [input.row.absoluteIndex + 1],
    });
    const repaired = answerFromBatchRows({
      rows,
      entry: input.row.entry,
      absoluteIndex: input.row.absoluteIndex,
    });

    return repaired.source === "deterministic_fallback" ? null : repaired;
  } catch (error) {
    assertProjectWorkflowActive();
    console.warn(
      JSON.stringify({
        event: "requirement_response_strict_handoff_failed",
        ...safeErrorTelemetry(error),
        ref: requirementDisplayRef(input.row.entry, heading),
      }),
    );
    return null;
  }
}

function exactDuplicateRequirementDocumentIdentity(
  entry: RequirementLedgerEntry,
) {
  return entry.documentId?.trim() ?? "";
}

function exactDuplicateRequirementSectionIdentity(
  entry: RequirementLedgerEntry,
) {
  const heading = normalizeRequirementLedgerText(entry.heading);
  const service = normalizeRequirementLedgerText(entry.service ?? "");
  return heading || service ? [heading, service].join("\u001f") : "";
}

function exactDuplicateRequirementQualifierIdentity(
  entry: RequirementLedgerEntry,
) {
  let residual = normalizeRequirementLedgerText(
    requirementSourceExcerptWithoutAnswer(entry),
  ).replace(
    /^(?:kravgrunnlag|kravtekst|krav-id|referanse|ref)\s*[:：]?\s*/iu,
    "",
  );
  const normalizedId = normalizeRequirementLedgerText(entry.id ?? "");
  if (
    normalizedId &&
    residual.startsWith(normalizedId) &&
    /^(?:$|[\s:：;|,-])/u.test(residual.slice(normalizedId.length))
  ) {
    residual = residual.slice(normalizedId.length);
  }
  const requirementText = normalizeRequirementLedgerText(entry.text);
  const requirementIndex = requirementText
    ? residual.indexOf(requirementText)
    : -1;
  if (requirementIndex >= 0) {
    residual = `${residual.slice(0, requirementIndex)} ${residual.slice(
      requirementIndex + requirementText.length,
    )}`;
  }

  return normalizeRequirementLedgerText(
    residual
      .replace(/\b(?:kravgrunnlag|kravtekst|krav-id|referanse|ref)\s*[:：]?/giu, " ")
      .replace(/[|:：;]+/gu, " "),
  );
}

function isModelAuthoredAcceptedRequirementAnswer(
  answer: RequirementAnswerResult,
) {
  return (
    answer.source === "batch" || answer.source === "full_document_handoff"
  );
}

/**
 * Reuses a model-authored answer only for an exact duplicate requirement in the
 * same source section. The answer is normalized and quality-gated again against
 * the target row, and its evidence is rebuilt exclusively from that target.
 */
export function reuseExactDuplicateRequirementAnswers(input: {
  ledger: RequirementLedgerEntry[];
  answers: RequirementAnswerResult[];
}) {
  const donors = input.answers.flatMap((answer, index) => {
    const entry = input.ledger[index];
    const documentIdentity = entry
      ? exactDuplicateRequirementDocumentIdentity(entry)
      : "";
    const requirementText = entry
      ? normalizeRequirementLedgerText(entry.text)
      : "";
    const sectionIdentity = entry
      ? exactDuplicateRequirementSectionIdentity(entry)
      : "";
    const qualifierIdentity = entry
      ? exactDuplicateRequirementQualifierIdentity(entry)
      : "";
    if (
      !entry ||
      !documentIdentity ||
      !requirementText ||
      !sectionIdentity ||
      !isModelAuthoredAcceptedRequirementAnswer(answer) ||
      detectExplicitRequirementIds(answer.answer).length > 0
    ) {
      return [];
    }

    return [
      {
        answer,
        documentIdentity,
        requirementText,
        sectionIdentity,
        qualifierIdentity,
      },
    ];
  });
  const answers = [...input.answers];
  const reusedRefs: string[] = [];

  for (let index = 0; index < answers.length; index += 1) {
    const current = answers[index];
    const entry = input.ledger[index];
    if (!entry || current?.source !== "deterministic_fallback") {
      continue;
    }

    const documentIdentity = exactDuplicateRequirementDocumentIdentity(entry);
    if (!documentIdentity) {
      continue;
    }
    const requirementText = normalizeRequirementLedgerText(entry.text);
    const sectionIdentity = exactDuplicateRequirementSectionIdentity(entry);
    const qualifierIdentity = exactDuplicateRequirementQualifierIdentity(entry);
    if (!requirementText || !sectionIdentity) {
      continue;
    }
    const donor = donors.find(
      (candidate) =>
        candidate.documentIdentity === documentIdentity &&
        candidate.requirementText === requirementText &&
        candidate.sectionIdentity === sectionIdentity &&
        candidate.qualifierIdentity === qualifierIdentity,
    );
    if (!donor) {
      continue;
    }

    const revalidated = normalizeRequirementAnswerResult(
      donor.answer.answer,
      entry,
      entry.sourceExcerpt,
    );
    if (revalidated.source !== "batch") {
      continue;
    }

    answers[index] = {
      answer: revalidated.answer,
      evidence: revalidated.evidence,
      source: "exact_duplicate_reuse",
    };
    reusedRefs.push(
      requirementDisplayRef(entry, requirementGroupHeading(entry)),
    );
  }

  return {
    answers,
    metadata: {
      exact_duplicate_reuse_answers: reusedRefs.length,
      exact_duplicate_reuse_refs: reusedRefs,
    },
  };
}

async function repairRequirementAnswersWithFullDocumentHandoff(input: {
  projectName: string;
  baseContext: string;
  ledger: RequirementLedgerEntry[];
  answers: RequirementAnswerResult[];
  requirementDocuments: ProjectDocumentDetail[];
  model?: string;
  onProgress?: (message: string) => void;
}) {
  const strictHandoffLimits =
    resolveRequirementResponseStrictHandoffLimits();
  const strictHandoffGovernor =
    createRequirementResponseStrictHandoffGovernor({
      limits: strictHandoffLimits,
    });
  const candidates = input.answers
    .map((answer, index) => ({
      absoluteIndex: index,
      entry: input.ledger[index],
      current: answer,
    }))
    .filter(
      (row): row is {
        absoluteIndex: number;
        entry: RequirementLedgerEntry;
        current: RequirementAnswerResult;
      } => Boolean(row.entry) && row.current.source === "deterministic_fallback",
    );

  if (!candidates.length) {
    return {
      answers: input.answers,
      metadata: {
        attempted: false,
        attempted_requirements: 0,
        repaired_requirements: 0,
        deterministic_control_repaired_requirements: 0,
        deterministic_template_repaired_requirements: 0,
        failed_batches: 0,
        duration_ms: 0,
        strict_handoff: strictHandoffGovernor.snapshot(0),
      },
    };
  }

  const handoffProgress = createRequirementResponseHandoffProgressTracker(
    candidates.map((candidate) => candidate.absoluteIndex),
  );
  const workflowSignal = getProjectWorkflowAbortSignal();
  const reportTerminalMetadata =
    bindProjectWorkflowTerminalMetadataReporter();
  const reportInterruptedHandoff = () => {
    reportTerminalMetadata({
      requirement_response_handoff: strictHandoffGovernor.snapshot(
        handoffProgress.unresolvedCount(),
        "deadline_exceeded",
      ),
    });
  };
  if (workflowSignal?.aborted) {
    reportInterruptedHandoff();
  } else {
    workflowSignal?.addEventListener("abort", reportInterruptedHandoff, {
      once: true,
    });
  }

  const startedAt = Date.now();
  const chunks = chunkRequirementHandoffRows(candidates);
  const documentContextForHandoff = buildRequirementHandoffDocumentContext(
    input.requirementDocuments,
  );
  const acceptedAnswerContext = limitRequirementHandoffStyleExamples(
    input.answers
      .map((answer, index) => {
        const entry = input.ledger[index];
        if (!entry) {
          return null;
        }

        return {
          nr: index + 1,
          ref: requirementDisplayRef(entry, requirementGroupHeading(entry)),
          svar: answer.answer,
          svargrunnlag: answer.evidence,
          source: answer.source,
        };
      })
      .filter(
        (
          row,
        ): row is {
          nr: number;
          ref: string;
          svar: string;
          svargrunnlag: string;
          source: RequirementAnswerSource;
        } => row !== null && row.source === "batch",
      ),
  );
  const nextAnswers = [...input.answers];
  let completedChunks = 0;
  let failedBatches = 0;
  let repairedRequirements = 0;
  let deterministicControlRepairedRequirements = 0;
  let deterministicTemplateRepairedRequirements = 0;

  input.onProgress?.(
    formatJobProgress(78, `Ledger-batch trenger full-dokument handoff for ${candidates.length} krav. Fortsetter med resten av jobben ...`),
  );

  const repairedChunks = await mapWithConcurrency(
    chunks,
    REQUIREMENT_RESPONSE_HANDOFF_CONCURRENCY,
    async (chunk) => {
      const rowsForPrompt = chunk.map((row) => {
        const repairDirective = buildRequirementRepairDirective(
          row.entry,
          row.current.reason ?? "",
        );
        return {
          nr: row.absoluteIndex + 1,
          ref: requirementDisplayRef(
            row.entry,
            requirementGroupHeading(row.entry),
          ),
          kravtekst: compactText(row.entry.text, 900),
          radutdrag: row.entry.sourceExcerpt
            ? compactText(row.entry.sourceExcerpt, 700)
            : undefined,
          kildegrunnlag: requirementDisplaySource(
            row.entry,
            requirementGroupHeading(row.entry),
          ),
          svargrunnlag: requirementAnswerEvidence(
            row.entry,
            row.current.evidence,
          ),
          standardsvar_som_skal_forbedres: compactText(
            requirementAnswerForRepair(row.current),
            500,
          ),
          fallback_arsak: row.current.reason ?? "",
          ...(repairDirective
            ? { obligatorisk_svarstruktur: repairDirective }
            : {}),
        };
      });

      try {
        const handoffTimeoutMs = boundedByProjectWorkflowDeadline(
          REQUIREMENT_RESPONSE_HANDOFF_TIMEOUT_MS,
          { reserveMs: REQUIREMENT_RESPONSE_HANDOFF_DEADLINE_RESERVE_MS },
        );
        if (handoffTimeoutMs === null) {
          throw new Error("Full-dokument handoff ble ikke startet fordi jobbfristen nærmer seg.");
        }
        const generated = await runWithProgressHeartbeat(
          {
            onProgress: input.onProgress,
            message:
              formatJobProgress(80, "Full-dokument handoff jobber fortsatt med svake kravsvar ..."),
          },
          () =>
            createJsonCompletion<{
              rows?: RequirementBatchAnswer[];
            }>({
              system: requirementHandoffSystemPrompt(),
              user: [
                "Reparer bare kravradene i JSON. Bruk full dokumentkontekst, men behold kravlisten uendret.",
                "Feltene fallback_arsak og obligatorisk_svarstruktur er bindende sjekklister. Lukk hvert opplistet issue og hvert strukturpunkt synlig i det nye svaret med en konkret, produktnøytral baseline. Hold enkle svar til 1-2 setninger, men bruk 2-4 konsise setninger for API-/autentiserings-/datamodellkrav og backup-/gjenopprettings-/verifikasjonskrav. Ikke dikt tall, kundedata eller kundespesifikke endepunkter.",
                chunk.some((row) =>
                  needsDimensioningDeferredCoreRepairPrompt(
                    row.current.reason,
                    row.entry.text,
                  ),
                )
                  ? REQUIREMENT_REPAIR_CLARIFICATION_BOUNDARY
                  : "",
                buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
                input.baseContext,
                documentContextForHandoff,
                acceptedAnswerContext.length
                  ? buildDelimitedContext(
                      "Allerede godkjente batchsvar for stil og konsistens",
                      JSON.stringify(acceptedAnswerContext),
                    )
                  : "",
                buildDelimitedContext(
                  "Krav som skal repareres",
                  JSON.stringify(rowsForPrompt),
                ),
              ]
                .filter(Boolean)
                .join("\n\n"),
              temperature: 0.1,
              model: requirementResponseRepairModel(input.model),
              reasoningEffort: ANALYSIS_REASONING_EFFORT,
              timeoutMs: handoffTimeoutMs,
              maxRetries: 1,
              promptCacheKey: "requirement-response-handoff",
            }),
        );
        const rows = parseRequirementBatchRows(generated.rows);
        let handoffBatchError = "";
        try {
          validateRequirementResponseBatchRows({
            rows,
            entries: chunk.map((row) => row.entry),
            expectedNumbers: chunk.map((row) => row.absoluteIndex + 1),
          });
        } catch (error) {
          // A closed code: this reason is shown to the strict-repair model.
          handoffBatchError = "Handoff-batchen hadde ugyldig format.";
          failedBatches += 1;
          console.warn(
            JSON.stringify({
              event: "requirement_response_full_document_handoff_invalid_shape",
              ...safeErrorTelemetry(error),
              count: chunk.length,
            }),
          );
        }
        // Strict single-row repair runs as its own phase after every
        // full-document batch, so its deadline is not spent waiting for
        // later batches.
        const repairedRows = chunk.map((row) => {
          let repaired = answerFromBatchRows({
            rows,
            entry: row.entry,
            absoluteIndex: row.absoluteIndex,
            batchError: handoffBatchError || undefined,
          });
          if (repaired.source === "deterministic_fallback") {
            repaired = resolveRequirementAnswerBeforeStrictHandoff({
              entry: row.entry,
              current: repaired,
            });
          }
          if (repaired.source !== "deterministic_fallback") {
            // Counted now, so an interrupted job reports accepted repairs.
            handoffProgress.markResolved(row.absoluteIndex);
          }
          return { ...row, repaired };
        });
        return repairedRows;
      } catch (error) {
        assertProjectWorkflowActive();
        failedBatches += 1;
        console.warn(
          JSON.stringify({
            event: "requirement_response_full_document_handoff_failed",
            ...safeErrorTelemetry(error),
            count: chunk.length,
          }),
        );
        return chunk.map((row) => ({
          ...row,
          repaired: {
            ...row.current,
            // The reason is shown to the strict-repair model; keep error
            // text (raw outside production) in the logs only.
            reason: [row.current.reason, "handoff_failed"]
              .filter(Boolean)
              .join("; "),
          } satisfies RequirementAnswerResult,
        }));
      } finally {
        completedChunks += 1;
        input.onProgress?.(
          formatJobProgress(
            Math.min(84, 78 + Math.round((completedChunks / chunks.length) * 6)),
            `Full-dokument handoff ferdig med ${completedChunks} av ${chunks.length} reparasjonsbatcher ...`,
          ),
        );
      }
    },
  );

  const strictPhaseRows = await mapWithConcurrency(
    repairedChunks.flat(),
    strictHandoffLimits.concurrency,
    async (row) => {
      let repaired = row.repaired;
      if (repaired.source === "deterministic_fallback") {
        const strictAttempt = await strictHandoffGovernor.run((timeoutMs) =>
          repairSingleRequirementAnswerWithStrictHandoff({
            projectName: input.projectName,
            acceptedAnswerContext,
            row: { ...row, current: repaired },
            rejectionReason: repaired.reason,
            model: input.model,
            timeoutMs,
            onProgress: input.onProgress,
          }),
        );
        const strictRepair =
          strictAttempt.status === "completed" ? strictAttempt.value : null;
        if (strictAttempt.status === "skipped") {
          repaired = {
            ...repaired,
            reason: [repaired.reason, `strict_handoff_skipped:${strictAttempt.reason}`]
              .filter(Boolean)
              .join("; "),
          };
        }
        repaired = resolveRequirementAnswerAfterStrictHandoff({
          entry: row.entry,
          current: repaired,
          strictRepair,
        });
        if (
          strictAttempt.status === "completed" &&
          repaired.source !== "deterministic_fallback"
        ) {
          strictHandoffGovernor.recordAcceptedRepair();
        }
      }

      if (repaired.source === "deterministic_fallback") {
        return {
          ...row,
          repaired: {
            ...row.current,
            rejectedAnswer: repaired.rejectedAnswer ?? row.current.rejectedAnswer,
            reason: [
              row.current.reason,
              `handoff_unresolved: ${repaired.reason ?? "low_value_answer"}`,
            ]
              .filter(Boolean)
              .join("; "),
          } satisfies RequirementAnswerResult,
        };
      }
      handoffProgress.markResolved(row.absoluteIndex);
      return {
        ...row,
        repaired: {
          answer: repaired.answer,
          evidence: repaired.evidence,
          source:
            repaired.source === "deterministic_template_repair"
              ? "deterministic_template_repair"
              : repaired.source === "deterministic_control_repair"
                ? "deterministic_control_repair"
                : "full_document_handoff",
        } satisfies RequirementAnswerResult,
      };
    },
  );

  for (const row of strictPhaseRows) {
    if (row.repaired.source === "full_document_handoff") {
      repairedRequirements += 1;
    }
    if (row.repaired.source === "deterministic_control_repair") {
      deterministicControlRepairedRequirements += 1;
    }
    if (row.repaired.source === "deterministic_template_repair") {
      deterministicTemplateRepairedRequirements += 1;
    }
    nextAnswers[row.absoluteIndex] = row.repaired;
  }
  const unresolvedAfterHandoff = nextAnswers.filter(
    (answer) => answer.source === "deterministic_fallback",
  ).length;
  if (unresolvedAfterHandoff !== handoffProgress.unresolvedCount()) {
    throw new Error(
      "Full-dokument handoff fikk inkonsistent intern fremdriftsteller.",
    );
  }

  return {
    answers: nextAnswers,
    metadata: {
      attempted: true,
      attempted_requirements: candidates.length,
      repaired_requirements: repairedRequirements,
      deterministic_control_repaired_requirements:
        deterministicControlRepairedRequirements,
      deterministic_template_repaired_requirements:
        deterministicTemplateRepairedRequirements,
      failed_batches: failedBatches,
      duration_ms: Date.now() - startedAt,
      strict_handoff:
        strictHandoffGovernor.snapshot(unresolvedAfterHandoff),
    },
  };
}

function normalizedRequirementResponseBatchRef(value: string) {
  return normalizeRequirementId(normalizePageText(value))
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("nb");
}

function expectedRequirementResponseBatchRef(entry: RequirementLedgerEntry) {
  return requirementDisplayRef(entry, requirementGroupHeading(entry));
}

export function validateRequirementResponseBatchRows(input: {
  rows: RequirementBatchAnswer[];
  entries: RequirementLedgerEntry[];
  startIndex?: number;
  expectedNumbers?: number[];
}) {
  const expectedNumbers =
    input.expectedNumbers ??
    input.entries.map((_, index) => (input.startIndex ?? 0) + index + 1);
  if (expectedNumbers.length !== input.entries.length) {
    throw new Error(
      `Kravsvar-batchens validator fikk ${expectedNumbers.length} forventede nummer for ${input.entries.length} krav.`,
    );
  }

  const issues: string[] = [];
  if (input.rows.length !== input.entries.length) {
    issues.push(
      `forventet ${input.entries.length} rader, mottok ${input.rows.length}`,
    );
  }

  const expectedNumberSet = new Set(expectedNumbers);
  const rowsByNumber = new Map<number, RequirementBatchAnswer>();
  const duplicateNumbers = new Set<number>();
  input.rows.forEach((row, index) => {
    if (
      typeof row.nr !== "number" ||
      !Number.isFinite(row.nr) ||
      !Number.isInteger(row.nr)
    ) {
      issues.push(`rad ${index + 1} mangler et eksakt heltalls-nr`);
      return;
    }
    if (rowsByNumber.has(row.nr)) {
      duplicateNumbers.add(row.nr);
      return;
    }
    rowsByNumber.set(row.nr, row);
    if (!expectedNumberSet.has(row.nr)) {
      issues.push(`uventet nr=${row.nr}`);
    }
  });

  if (duplicateNumbers.size) {
    issues.push(
      `dupliserte nr=${Array.from(duplicateNumbers).sort((a, b) => a - b).join(",")}`,
    );
  }

  expectedNumbers.forEach((expectedNr, index) => {
    const row = rowsByNumber.get(expectedNr);
    if (!row) {
      issues.push(`mangler nr=${expectedNr}`);
      return;
    }
    const actualRef = row.ref?.replace(/\s+/g, " ").trim() ?? "";
    if (!actualRef) {
      issues.push(`nr=${expectedNr} mangler ref`);
      return;
    }
    const expectedRef = expectedRequirementResponseBatchRef(
      input.entries[index],
    );
    if (
      normalizedRequirementResponseBatchRef(actualRef) !==
      normalizedRequirementResponseBatchRef(expectedRef)
    ) {
      issues.push(
        `nr=${expectedNr} har ref="${compactText(actualRef, 100)}", forventet "${compactText(expectedRef, 100)}"`,
      );
    }
  });

  if (issues.length) {
    throw new Error(`Ugyldig kravsvar-batch: ${issues.join("; ")}.`);
  }

  return expectedNumbers.map((expectedNr) => rowsByNumber.get(expectedNr)!);
}

export function answerFromBatchRows(input: {
  rows: RequirementBatchAnswer[];
  entry: RequirementLedgerEntry;
  absoluteIndex: number;
  batchError?: string;
}): RequirementAnswerResult {
  if (input.batchError) {
    return {
      answer: tableRequirementAnswer(input.entry),
      evidence: requirementAnswerEvidence(input.entry),
      source: "deterministic_fallback",
      reason: `batch_error: ${input.batchError}`,
    };
  }

  const expectedNr = input.absoluteIndex + 1;
  const matchingRows = input.rows.filter((row) => row.nr === expectedNr);
  if (matchingRows.length !== 1) {
    return {
      answer: tableRequirementAnswer(input.entry),
      evidence: requirementAnswerEvidence(input.entry),
      source: "deterministic_fallback",
      reason: `invalid_batch_shape: forventet nøyaktig én rad med nr=${expectedNr}, fant ${matchingRows.length}`,
    };
  }
  const matched = matchingRows[0];
  const actualRef = matched.ref?.replace(/\s+/g, " ").trim() ?? "";
  const expectedRef = expectedRequirementResponseBatchRef(input.entry);
  if (!actualRef) {
    return {
      answer: tableRequirementAnswer(input.entry),
      evidence: requirementAnswerEvidence(input.entry),
      source: "deterministic_fallback",
      reason: `invalid_batch_shape: nr=${expectedNr} mangler ref`,
    };
  }
  if (
    normalizedRequirementResponseBatchRef(actualRef) !==
      normalizedRequirementResponseBatchRef(expectedRef)
  ) {
    return {
      answer: tableRequirementAnswer(input.entry),
      evidence: requirementAnswerEvidence(input.entry),
      source: "deterministic_fallback",
      reason: `invalid_batch_shape: nr=${expectedNr} har feil ref="${compactText(actualRef, 100)}", forventet "${compactText(expectedRef, 100)}"`,
    };
  }
  const answer = (matched?.svar ?? matched?.answer ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const evidence = matched
    ? matched.svargrunnlag ??
      matched.evidence ??
      matched.bevis ??
      matched.source_ref ??
      matched.sourceReference ??
      matched.kildegrunnlag ??
      matched.source ??
      ""
    : "";

  return normalizeRequirementAnswerResult(answer, input.entry, evidence);
}

export function resolveRequirementAnswerAfterStrictHandoff(input: {
  entry: RequirementLedgerEntry;
  current: RequirementAnswerResult;
  strictRepair: RequirementAnswerResult | null;
}) {
  if (input.strictRepair) {
    return input.strictRepair;
  }
  if (input.current.source !== "deterministic_fallback") {
    return input.current;
  }

  return (
    buildDeterministicFinalRequirementControlRepair({
      entry: input.entry,
      evidence: input.current.evidence,
    }) ??
    buildDeterministicFinalRequirementTemplateRepair({
      entry: input.entry,
      evidence: input.current.evidence,
    }) ??
    input.current
  );
}

export function resolveRequirementAnswerBeforeStrictHandoff(input: {
  entry: RequirementLedgerEntry;
  current: RequirementAnswerResult;
}) {
  if (input.current.source !== "deterministic_fallback") {
    return input.current;
  }

  return (
    buildDeterministicFinalRequirementControlRepair({
      entry: input.entry,
      evidence: input.current.evidence,
    }) ?? input.current
  );
}

export function applyVerifiedDeterministicControlRepairs(input: {
  ledger: RequirementLedgerEntry[];
  answers: RequirementAnswerResult[];
}) {
  return input.answers.map((answer, index) => {
    const entry = input.ledger[index];
    if (!entry || answer.source !== "deterministic_fallback") {
      return answer;
    }
    return (
      buildDeterministicFinalRequirementControlRepair({
        entry,
        evidence: answer.evidence,
      }) ?? answer
    );
  });
}

export function buildRequirementFallbackStageMetadata(input: {
  afterBatch: ReadonlyArray<Pick<RequirementAnswerResult, "source">>;
  beforeHandoff: ReadonlyArray<Pick<RequirementAnswerResult, "source">>;
  afterHandoff: ReadonlyArray<Pick<RequirementAnswerResult, "source">>;
}) {
  const countFallbacks = (
    answers: ReadonlyArray<Pick<RequirementAnswerResult, "source">>,
  ) =>
    answers.filter((answer) => answer.source === "deterministic_fallback")
      .length;

  return {
    deterministic_fallback_answers_after_batch: countFallbacks(
      input.afterBatch,
    ),
    deterministic_fallback_answers_before_handoff: countFallbacks(
      input.beforeHandoff,
    ),
    deterministic_fallback_answers_after_handoff: countFallbacks(
      input.afterHandoff,
    ),
  };
}

export function buildDeterministicTemplateRepairMetadata(input: {
  answers: RequirementAnswerResult[];
  ledger: RequirementLedgerEntry[];
}) {
  const rows = input.answers.flatMap((answer, index) => {
    const entry = input.ledger[index];
    return answer.source === "deterministic_template_repair" && entry
      ? [
          {
            ref: requirementDisplayRef(
              entry,
              requirementGroupHeading(entry),
            ),
            order_index: index,
            source_document_id: entry.documentId ?? null,
            source_locator: requirementDisplaySource(
              entry,
              requirementGroupHeading(entry),
            ),
          },
        ]
      : [];
  });
  const manualReviewRequired = rows.length > 0;

  return {
    deterministic_template_repair_answers: rows.length,
    deterministic_template_repair_refs: rows.map((row) => row.ref),
    deterministic_template_repair_rows: rows,
    manual_review_required: manualReviewRequired,
    ...(manualReviewRequired
      ? {
          manual_review_note:
            DETERMINISTIC_TEMPLATE_REPAIR_MANUAL_REVIEW_NOTE,
        }
      : {}),
  };
}

function proposalInputRequirementReasons(entry: RequirementLedgerEntry) {
  const text = normalizePageText(entry.text).toLocaleLowerCase("nb");
  const reasons = new Set<ProposalInputRequirementReason>();

  if (
    /\b(?:minst\s+\d+\s+referanser?|referanser?\s+med\s+kontaktdata|referansekunder?)\b/u.test(
      text,
    )
  ) {
    reasons.add("supplier_references");
  }
  if (
    /\bcv(?:-er|er|ene)?\b.{0,180}\b(?:kandidat|referanse|vedlegg|tilbud)\w*\b/u.test(
      text,
    )
  ) {
    reasons.add("candidate_cvs");
  }
  if (
    /\b(?:sikkerhetssertifisering\w*|sertifisering\w*.{0,80}sikkerhet|statement\s+of\s+applicability|soa|internrevisjonsrapport|information\s+security\s+management\s+system|isms)\b/u.test(
      text,
    )
  ) {
    reasons.add("security_assurance_evidence");
  }
  if (
    /\b(?:prismodell|prising|timepris(?:er)?|margin|rabatt|betalingsvilkår|bilag\s*7)\b|\bpris(?:er)?\s+for\s+opsjon\w*\b/u.test(
      text,
    )
  ) {
    reasons.add("commercial_terms");
  }
  if (
    /\b(?:samfunnsansvar|mangfold|inkludering|relevante?\s+erfaring|relevante?\s+kompetanse|bakgrunnssjekk(?:er)?|virksomheten\s+jobber\s+med)\b/u.test(
      text,
    )
  ) {
    reasons.add("supplier_policy_or_experience");
  }
  if (
    /\b(?:hvorvidt|om)\b.{0,180}\b(?:viderefør\w*|erstatt\w*|alternative?\s+løsning\w*|splittes?\s+i\s+faste\s+og\s+variable)|\b(?:hvis|dersom)\s+det\s+(?:tilbys|inngår)\s+en\s+soc\b|\beventuell(?:e|t)?\s+endringer?\s+i\s+forhold\s+til\s+dagens\s+løsning\b|\bhvor\s+ofte\s+penetrasjonstester\b/u.test(
      text,
    )
  ) {
    reasons.add("explicit_bid_decision");
  }

  return [...reasons];
}

export function proposalEvidenceSupportsReason(
  corpus: string,
  reason: ProposalInputRequirementReason,
  requirementText = "",
) {
  const text = String(corpus ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[‐‑‒–—]/gu, "-")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!text) return false;
  const evidenceIsDeferred = (subject: RegExp) =>
    text
      .split(/\n{2,}|(?<=[.!?])\s+(?=[\p{Lu}\d])/u)
      .some(
        (segment) =>
          subject.test(segment) &&
          /\b(?:kan|vil|skal)\s+(?:leveres|ettersendes|utarbeides|avtales)\b.{0,80}\b(?:senere|på\s+forespørsel|etter\s+tildeling)\b|\b(?:avtales|avklares|utarbeides)\s+senere\b|\b(?:tbd|ikke\s+vedlagt|mangler)\b/iu.test(
            segment,
          ),
      );
  const requirement = normalizePageText(requirementText);
  const requestedRoles = [
    ...new Set(
      requirement.match(
        /\b(?:sikkerhetsarkitekt|løsningsarkitekt|prosjektleder|tjenesteleder|teamleder|fagansvarlig|rådgiver|konsulent|arkitekt|tekniker|utvikler|testleder)\w*\b/giu,
      ) ?? [],
    ),
  ].map((value) => value.toLocaleLowerCase("nb"));
  const evidenceCoversRequestedRoles = requestedRoles.every((role) =>
    text.toLocaleLowerCase("nb").includes(role),
  );

  switch (reason) {
    case "supplier_references": {
      if (
        evidenceIsDeferred(
          /\b(?:kunde|referanse(?:kunde)?|oppdragsgiver|kontaktdata)\b/iu,
        )
      ) {
        return false;
      }
      const requestedCount = Math.max(
        1,
        Number(/\bminst\s+(\d+)\s+referanser?\b/iu.exec(requirementText)?.[1] ?? 1),
      );
      const referenceRows = text
        .split(
          /(?=\b(?:kunde|referanse(?:kunde)?|oppdragsgiver)\s*(?:\d+)?\s*[:.-])/iu,
        )
        .map((value) => value.trim())
        .filter(Boolean)
        .filter(
          (value) =>
            /\b(?:kunde|referansekunde|oppdragsgiver|referanse)\b/iu.test(value) &&
            /\b(?:kontaktperson|kontakt)\s*[:.-]\s*[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)+/iu.test(
              value,
            ) &&
            (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(value) ||
              /(?:\+\s?47\s?)?(?:\d[\s-]?){8}\b/u.test(value)),
        );
      return referenceRows.length >= requestedCount;
    }
    case "candidate_cvs":
      return (
        !evidenceIsDeferred(/\b(?:cv|curriculum\s+vitae|kandidat)\b/iu) &&
        evidenceCoversRequestedRoles &&
        [
          ...text.matchAll(
            /\b(?:kandidat(?:navn)?|navn)\s*[:.-]\s*([\p{L}'’-]+(?:\s+[\p{L}'’-]+)+)/giu,
          ),
        ].length >= Math.max(1, requestedRoles.length) &&
        /\b(?:curriculum\s+vitae|cv)\b/iu.test(text) &&
        /\b(?:kandidat(?:navn)?|navn)\s*[:.-]\s*[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)+/iu.test(
          text,
        ) &&
        /\b(?:arbeidserfaring|erfaring|utdanning|kompetanse|sertifiseringer?|prosjekterfaring)\b/iu.test(
          text,
        )
      );
    case "security_assurance_evidence": {
      if (
        evidenceIsDeferred(
          /\b(?:ISO\s*\/?IEC\s*27001|sertifikat|soa|statement\s+of\s+applicability|internrevisjonsrapport|isms)\b/iu,
        )
      ) {
        return false;
      }
      const requiresSoa = /\b(?:soa|statement\s+of\s+applicability)\b/iu.test(
        requirement,
      );
      const requiresInternalAudit = /\binternrevisjonsrapport\b/iu.test(
        requirement,
      );
      const hasCertificate =
        /\bISO\s*\/?IEC\s*27001\b/iu.test(text) &&
        /\b(?:sertifikat(?:nummer|nr\.?|\s+id)|certificate\s+(?:no|number)|gyldig\s+til|valid\s+until|utstedt\s+av)\b/iu.test(
          text,
        );
      const hasSoa =
        /\b(?:soa|statement\s+of\s+applicability)\b/iu.test(text) &&
        /\b(?:versjon|version|dato|date)\b|\bA\.\d{1,2}(?:\.\d{1,2})?\b/u.test(
          text,
        );
      const hasInternalAudit =
        /\binternrevisjonsrapport\b/iu.test(text) &&
        /\b(?:dato|funn|avvik|revisor|tiltak)\b/iu.test(text);
      return (
        (hasCertificate || hasSoa || hasInternalAudit) &&
        (!requiresSoa || hasSoa) &&
        (!requiresInternalAudit || hasInternalAudit)
      );
    }
    case "commercial_terms":
      return (
        !evidenceIsDeferred(
          /\b(?:pris|prismodell|timepris|margin|rabatt|betalingsvilkår)\b/iu,
        ) &&
        evidenceCoversRequestedRoles &&
        /\b(?:timepris(?:er)?|fastpris|månedlig\s+pris|margin|rabatt|betalingsvilkår|prismodell)\b/iu.test(text) &&
        (/(?:\b(?:NOK|EUR|kr)\s*)\d[\d\s.,]*|\d[\d\s.,]*\s*(?:NOK|EUR|kr)\b/iu.test(
          text,
        ) ||
          /\b(?:margin|rabatt)\b.{0,40}\b\d+(?:[,.]\d+)?\s*%/iu.test(
            text,
          ) ||
          /\b(?:netto|betaling)\s*\d{1,3}\s*dager\b/iu.test(text)) &&
        (!/\btimepris(?:er)?\b/iu.test(requirement) ||
          /\btimepris(?:er)?\b.{0,80}(?:\d[\d\s.,]*\s*(?:NOK|EUR|kr)|(?:NOK|EUR|kr)\s*\d)/isu.test(
            text,
          )) &&
        (!/\bmargin\b/iu.test(requirement) ||
          /\bmargin\b.{0,50}\d+(?:[,.]\d+)?\s*%/isu.test(text)) &&
        (!/\brabatt\b/iu.test(requirement) ||
          /\brabatt\b.{0,50}\d+(?:[,.]\d+)?\s*%/isu.test(text)) &&
        (!/\bbetalingsvilkår\b/iu.test(requirement) ||
          /\b(?:betalingsvilkår|netto)\b.{0,50}\d{1,3}\s*dager\b/isu.test(
            text,
          ))
      );
    case "supplier_policy_or_experience":
      return (
        !evidenceIsDeferred(
          /\b(?:samfunnsansvar|mangfold|inkludering|erfaring|bakgrunnssjekk|hr-policy)\b/iu,
        ) &&
        /\b(?:samfunnsansvar|mangfold|inkludering|referanseprosjekt\w*|års?\s+erfaring|bakgrunnssjekk(?:er)?|HR-policy)\b/iu.test(
          text,
        ) &&
        /\b(?:mål|tiltak|ansvarlig|rapportering|kontroll|prosjekt|kunde|\d+\s+års?\s+erfaring|gjennomføres|følges\s+opp)\b/iu.test(
          text,
        ) &&
        (!/\bsamfunnsansvar\b/iu.test(requirement) ||
          /\bsamfunnsansvar\b/iu.test(text)) &&
        (!/\bmangfold\b/iu.test(requirement) || /\bmangfold\b/iu.test(text)) &&
        (!/\binkludering\b/iu.test(requirement) ||
          /\binkludering\b/iu.test(text)) &&
        (!/\bbakgrunnssjekk/iu.test(requirement) ||
          /\bbakgrunnssjekk/iu.test(text)) &&
        (!/\berfaring\b/iu.test(requirement) ||
          /\b(?:\d+\s+års?\s+erfaring|referanseprosjekt)\b/iu.test(text))
      );
    case "explicit_bid_decision":
      if (
        evidenceIsDeferred(
          /\b(?:underleverandør|soc|dagens\s+løsning|penetrasjonstest)\b/iu,
        )
      ) {
        return false;
      }
      if (/\bunderleverandør|\bviderefør|\berstatt/iu.test(requirement)) {
        return /\bunderleverandør\w*\b.{0,100}\b(?:viderefører|videreføres|erstatter|erstattes)\b/isu.test(
          text,
        );
      }
      if (/\bsoc\b/iu.test(requirement)) {
        return /\bSOC\s+(?:inngår|tilbys|utelates|inngår\s+ikke)\b/iu.test(text);
      }
      if (/\bpenetrasjonstest/iu.test(requirement)) {
        return /\bpenetrasjonstest\w*.{0,50}\b(?:årlig|halvårlig|kvartalsvis|månedlig)\b/isu.test(
          text,
        );
      }
      if (/\bdagens\s+løsning|\bendringer?\b/iu.test(requirement)) {
        return /\bdagens\s+løsning\s+(?:beholdes|videreføres|erstattes)|\bendringer?\b.{0,80}\b(?:gjennomføres|inngår|utelates)\b/isu.test(
          text,
        );
      }
      return false;
  }
}

export function buildProposalInputRequiredMetadata(input: {
  ledger: RequirementLedgerEntry[];
  answers?: Array<Pick<RequirementAnswerResult, "answer">>;
  evidenceDocuments?: Array<
    Pick<ProjectDocumentDetail, "title" | "file_name" | "raw_text">
  >;
}) {
  if (input.answers && input.answers.length !== input.ledger.length) {
    throw new Error("Svar og krav må ha samme antall rader ved kontroll av tilbudsvalg.");
  }
  const evidenceCorpus = (input.evidenceDocuments ?? [])
    .map((document) => document.raw_text)
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n\n");
  const rows = input.ledger.flatMap((entry, orderIndex) => {
    const reasons = proposalInputRequirementReasons(entry).filter(
      (reason) =>
        !proposalEvidenceSupportsReason(evidenceCorpus, reason, entry.text),
    );
    const answer = normalizePageText(input.answers?.[orderIndex]?.answer ?? "");
    const proposedDeliveryNeedsConfirmation =
      /\b(?:foreslår|foreslås|foreslått(?:e)?)\b/iu.test(answer) &&
      /(?<!ikke )\b(?:krever|forutsetter)\s+(?!(?:ikke|ingen|intet)\b)[^.?!]{0,100}(?:bekreftelse|godkjenning)|(?<!ikke )\bmå\s+(?!ikke\b)[^.?!]{0,100}(?:bekreftes|godkjennes)/iu.test(answer);
    const pendingSupplierEvidence =
      /(?<!ingen )(?<!ikke )\bleverandørbekreftelse\s+må\s+(?!ikke\b)(?:kompletteres|innhentes|avklares)/iu.test(answer);
    const documentedGapNeedsCorrection =
      /\b(?:dette\s+(?:er\s+et\s+avvik|avviker)|dokumentert\s+(?:løsning|løsningsgrunnlag))\b/iu.test(answer) &&
      /\bmå\s+(?!ikke\b)(?:derfor\s+)?(?:lukkes|oppdateres|erstattes)\b[^.?!]{0,150}\bfør\b/iu.test(answer);
    if ((proposedDeliveryNeedsConfirmation || pendingSupplierEvidence || documentedGapNeedsCorrection || supplierAnswerNeedsConfirmation(answer)) && !reasons.includes("explicit_bid_decision")) {
      reasons.push("explicit_bid_decision");
    }
    return reasons.length
      ? [
          {
            ref: requirementDisplayRef(
              entry,
              requirementGroupHeading(entry),
            ),
            reasons,
            order_index: orderIndex,
            source_document_id: entry.documentId ?? null,
            source_locator: requirementDisplaySource(
              entry,
              requirementGroupHeading(entry),
            ),
          },
        ]
      : [];
  });

  return {
    proposal_input_required_count: rows.length,
    proposal_input_required_refs: rows.map((row) => row.ref),
    proposal_input_required_rows: rows,
  };
}

function requirementRetrievalTokens(entries: RequirementLedgerEntry[]) {
  const tokens = entries.flatMap((entry) =>
    tokenizeComparableText(`${entry.id} ${entry.text} ${entry.heading}`),
  );

  return Array.from(
    new Set(
      tokens
        .filter((token) => token.length >= 4)
        .filter((token) => !REQUIREMENT_RETRIEVAL_STOP_WORDS.has(token))
        .slice(0, 140),
    ),
  );
}

async function buildRequirementBatchRetrievalContext(input: {
  entries: RequirementLedgerEntry[];
  supportingDocuments: ProjectDocumentDetail[];
  serviceDocuments: ProjectDocumentDetail[];
}) {
  if (!input.supportingDocuments.length && !input.serviceDocuments.length) {
    return "";
  }

  const tokens = requirementRetrievalTokens(input.entries);
  if (!tokens.length) {
    return "";
  }

  const query = input.entries
    .map((entry) => [entry.id, entry.heading, entry.text].filter(Boolean).join(" "))
    .join("\n");
  const snippets = await retrieveDocumentSnippets({
    query,
    documents: input.supportingDocuments,
    serviceDocuments: input.serviceDocuments.map((document) => ({
      ...document,
      service_id:
        (document as ProjectDocumentDetail & { service_id?: string }).service_id ??
        document.project_id,
    })),
    exactTerms: input.entries
      .map((entry) => entry.id)
      .filter((id) => id && !isSyntheticRequirementId(id)),
    limit: 5,
  });

  if (snippets.length) {
    return retrievedSnippetContext(
      "Relevante semantiske utdrag for denne kravbatchen",
      snippets,
      { textLimit: 750 },
    );
  }

  const candidates = [
    ...input.serviceDocuments.map((document) => ({
      label: "Tjenesteutdrag",
      document,
      maxChunks: 12,
    })),
    ...input.supportingDocuments.map((document) => ({
      label: "Støtteutdrag",
      document,
      maxChunks: 16,
    })),
  ].flatMap(({ label, document, maxChunks }) =>
    buildDocumentTextChunks(document, {
      maxChunks,
      chunkLimit: 1300,
    }).map((chunk) => {
      const haystack = normalizeComparableText(
        `${document.title} ${chunk.references.join(" ")} ${chunk.text}`,
      );
      const score = tokens.reduce(
        (sum, token) => sum + (haystack.includes(token) ? 1 : 0),
        0,
      );
      return {
        label,
        documentTitle: document.title,
        chunk,
        score,
      };
    }),
  );

  const selected = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  if (!selected.length) {
    return "";
  }

  return buildDelimitedContext(
    "Relevante utdrag for denne kravbatchen",
    selected
      .map((item, index) =>
          [
            `${index + 1}. ${item.label}: ${item.documentTitle}`,
            `Referanser: ${item.chunk.references.slice(0, 4).join(", ")}`,
          compactText(item.chunk.text, 750),
        ].join("\n"),
      )
      .join("\n\n"),
  );
}

type ArtifactFoundationFact = {
  label: string;
  text: string;
  source: string;
};

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
  const lineFragments = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 18 && line.length <= 800);
  const sentenceFragments = splitIntoSentences(compactText(value, 80_000))
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

function buildFoundationFactsContext(facts: ArtifactFoundationFact[]) {
  if (!facts.length) {
    return "";
  }

  return buildDelimitedContext(
    "Sentrale prosjektføringer for kravsvar",
    [
      "Bruk disse føringene når de er relevante for et krav. Ikke press dem inn i krav der de ikke hører hjemme.",
      ...facts.map(
        (fact) => `- ${fact.label}: ${fact.text} (Kilde: ${fact.source})`,
      ),
    ].join("\n"),
  );
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
function appendPrioritizedRequirement(
  items: CustomerAnalysisResult["prioritized_requirements"],
  requirement: string,
  priority: CustomerAnalysisResult["prioritized_requirements"][number]["priority"],
  reason: string,
) {
  const existingText = items
    .map((item) => `${item.requirement} ${item.reason}`)
    .join("\n");
  if (
    highLevelDesignAdditionRepresented(existingText, requirement) ||
    items.some(
      (item) =>
        isNearDuplicate(item.requirement, requirement, 0.78) ||
        normalizeComparableText(item.requirement).includes(
          normalizeComparableText(requirement).slice(0, 80),
        ),
    )
  ) {
    return items;
  }

  return [...items, { requirement, priority, reason }];
}

function enrichCustomerAnalysisWithFoundationFacts(
  result: Untrusted<CustomerAnalysisResult>,
  facts: ArtifactFoundationFact[],
): Untrusted<CustomerAnalysisResult> {
  if (!facts.length) {
    return result;
  }

  const documentedControls = buildVerifiedFoundationControls(facts);
  if (!documentedControls.length) {
    return result;
  }

  let prioritizedRequirements = parsePrioritizedRequirements(
    result.prioritized_requirements,
  );
  for (const control of documentedControls) {
    prioritizedRequirements = appendPrioritizedRequirement(
      prioritizedRequirements,
      control,
      "Viktig",
      "Føringen er hentet fra det verifiserte dokumentgrunnlaget og må spores til kilde før den gjøres bindende.",
    );
  }

  return {
    ...result,
    prioritized_requirements: prioritizedRequirements.slice(
      0,
      MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS,
    ),
    likely_evaluation_criteria: appendUniqueTextItems(
      stringList(result.likely_evaluation_criteria),
      documentedControls,
      { max: 6 },
    ),
    expected_solution_direction: appendUniqueTextItems(
      stringList(result.expected_solution_direction),
      documentedControls,
      { max: 6 },
    ),
    risks_for_us: appendUniqueTextItems(
      stringList(result.risks_for_us),
      [documentedRiskControlText(facts)].filter(Boolean),
      { max: 5 },
    ),
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
    const inventoriedSources = sourceRequirementDocuments.filter((document) => originalRequirementSourceIds(document).length > 0);
    if (inventoriedSources.length > 0 && inventoriedSources.every(allRequirementsWithdrawn)) {
      return emptyRequirementCoverage("Alle krav i kravgrunnlaget er trukket tilbake ved rettelse.");
    }
    throw new Error(
      "Kravdekningen stoppet fordi originale kravdokumenter finnes, men ingen krav kunne ekstraheres fra dem.",
    );
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

function requirementCoverageSummary(input: {
  ledger: RequirementLedgerEntry[];
  answers: string[];
}) {
  const explicitRefs = input.ledger.filter(
    (entry) => !isSyntheticRequirementId(entry.id),
  ).length;
  const fallbackAnswers = input.answers.filter((answer, index) => {
    const entry = input.ledger[index];
    return entry ? isNearDuplicate(answer, tableRequirementAnswer(entry), 0.9) : false;
  }).length;

  return [
    `${input.ledger.length} krav er identifisert og besvart.`,
    `${explicitRefs} krav har eksplisitt kravreferanse fra dokumentet.`,
    "Alle kravradene fra kravlisten er inkludert i tabellen.",
    fallbackAnswers
      ? `${fallbackAnswers} svar er fylt deterministisk fra kravtekst og kildegrunnlag fordi AI-raden manglet eller var for svak.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function isClarificationRequirementEntry(entry: RequirementLedgerEntry) {
  const content = normalizeComparableText(
    `${entry.id} ${entry.text} ${entry.heading} ${entry.service ?? ""}`,
  );
  if (
    /\b(clarification question deadline|customer answers to clarification)\b/i.test(
      entry.text,
    )
  ) {
    return false;
  }

  return /\b(known unclear|clarification required|clarification needs|tbd|avklaringspunkt|avklaring kreves|uavklart|uklar)\b/i.test(
    content,
  );
}

function buildRequirementResponseMarkdown(input: {
  ledger: RequirementLedgerEntry[];
  answers: RequirementAnswerResult[];
}) {
  const indexedRows = input.ledger.map((entry, index) => {
    const answerResult = input.answers[index];
    const heading = requirementGroupHeading(entry);
    const answer = answerResult?.answer ?? tableRequirementAnswer(entry);
    const evidence = requirementAnswerEvidence(entry, answerResult?.evidence);

    return {
      entry,
      answer,
      heading,
      cells: [
        requirementDisplayRef(entry, heading),
        entry.text,
        answer,
        evidence,
        requirementDisplaySource(entry, heading),
      ],
    };
  });
  const tableSections: string[] = [];
  const groups: Array<{ heading: string; rows: typeof indexedRows }> = [];
  for (const row of indexedRows) {
    const previous = groups[groups.length - 1];
    if (previous && previous.heading === row.heading) {
      previous.rows.push(row);
      continue;
    }
    groups.push({ heading: row.heading, rows: [row] });
  }
  const shouldRenderGroupHeadings = groups.some((group) => group.heading);
  for (const group of groups) {
    if (shouldRenderGroupHeadings && group.heading) {
      tableSections.push(`### ${group.heading}`, "");
    }
    tableSections.push(
      ...requirementTableMarkdown(group.rows.map((row) => row.cells)),
      "",
    );
  }
  const clarificationRows = indexedRows.filter((row) =>
    isClarificationRequirementEntry(row.entry),
  );

  const clarificationSection = clarificationRows.length
    ? [
        "## Avklaringspunkter",
        "",
        ...clarificationRows.map((row) => {
          const answer = row.answer
            .replace(/^Avklaringspunkt:\s*/i, "")
            .replace(/\s+/g, " ")
            .trim();
          return `- **${markdownTableCell(
            requirementDisplayRef(row.entry, requirementGroupHeading(row.entry)),
          )}:** ${answer}`;
        }),
        "",
      ]
    : [];

  return [
    "## Status",
    "",
    requirementCoverageSummary({
      ledger: indexedRows.map((row) => row.entry),
      answers: indexedRows.map((row) => row.answer),
    }),
    clarificationRows.length
      ? `${clarificationRows.length} avklaringspunkter er markert i kravtabellen.`
      : "",
    "",
    "## Kravbesvarelse",
    "",
    ...tableSections,
    ...clarificationSection,
  ].join("\n");
}

export function formatUnresolvedRequirementResponseSummary(
  rows: Array<{
    nr: number;
    ref: string;
    reason?: string;
    rejected_answer_sample?: string;
  }>,
  includeFailedAnswerSamples =
    process.env.REQUIREMENT_RESPONSE_DIAGNOSTIC_FAILED_ANSWERS === "1",
) {
  return rows
    .slice(0, 12)
    .map((row) =>
      [
        `${row.nr}:${row.ref}${row.reason ? ` (${row.reason})` : ""}`,
        includeFailedAnswerSamples && row.rejected_answer_sample
          ? `[avvist svar: ${compactText(row.rejected_answer_sample, 240)}]`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("; ");
}

export function serializeUnresolvedRequirementFallbackAnswers(
  rows: Array<{
    nr: number;
    ref: string;
    reason?: string;
    rejected_answer_sample?: string;
  }>,
) {
  return {
    unresolved_fallback_answers: rows,
  };
}

async function generateRequirementResponseFromLedger(input: {
  projectName: string;
  baseContext: string;
  ledger: RequirementLedgerEntry[];
  ledgerConfidence: RequirementLedgerConfidence;
  requirementDocuments: ProjectDocumentDetail[];
  supportingDocuments: ProjectDocumentDetail[];
  serviceDocuments: ProjectDocumentDetail[];
  model?: string;
  onProgress?: (message: string) => void;
  solutionDocument?: ProjectDocumentDetail | null;
}) {
  const responseLedger = sortRequirementLedgerInDocumentOrder(input.ledger);
  const chunks = chunkRequirements(responseLedger);
  const responseSystemPrompt = requirementBatchSystemPrompt();
  const responseModel = requirementResponseBatchModel(input.model, chunks.length > 1);
  const responseSharedPromptPrefix = [
    "Besvar kravene i JSON. Ikke legg til, fjern eller slå sammen krav.",
    input.baseContext,
  ]
    .filter(Boolean)
    .join("\n\n");
  let completedBatches = 0;
  let completedRequirements = 0;

  input.onProgress?.(
    formatJobProgress(32, `Fant ${responseLedger.length} krav. Starter ${chunks.length} parallelle svarbatcher ...`),
  );

  const retrievalContextTasks = startConcurrentTasks(
    chunks,
    REQUIREMENT_RESPONSE_RETRIEVAL_CONCURRENCY,
    (chunk) =>
      buildRequirementBatchRetrievalContext({
        entries: chunk.entries,
        supportingDocuments: input.supportingDocuments,
        serviceDocuments: input.serviceDocuments,
      }),
  );

  const runResponseBatch = async (
    entries: RequirementLedgerEntry[],
    startIndex: number,
    relevantExcerpts: string,
    reserveMs: number,
  ) => {
    const krav = buildRequirementResponseBatchRegistry(entries, startIndex);
    const timeoutMs = boundedByProjectWorkflowDeadline(
      REQUIREMENT_RESPONSE_BATCH_TIMEOUT_MS,
      { reserveMs },
    );
    if (timeoutMs === null) {
      // Leave the remaining time to handoff and persistence; these rows go
      // to the handoff stage as ordinary fallbacks.
      return {
        rows: [] as RequirementBatchAnswer[],
        batchError: "Kravsvar-batchen ble ikke startet fordi jobbfristen nærmer seg.",
        timedOut: false,
      };
    }
    try {
      const generated = await createJsonCompletion<{
        rows?: RequirementBatchAnswer[];
      }>({
        system: responseSystemPrompt,
        user: [
          responseSharedPromptPrefix,
          relevantExcerpts,
          buildDelimitedContext("Krav som skal besvares", JSON.stringify(krav)),
        ]
          .filter(Boolean)
          .join("\n\n"),
        userMessages: [
          responseSharedPromptPrefix,
          [
            relevantExcerpts,
            buildDelimitedContext("Krav som skal besvares", JSON.stringify(krav)),
          ]
            .filter(Boolean)
            .join("\n\n"),
        ].filter(Boolean),
        temperature: 0.08,
        model: responseModel,
        reasoningEffort: EVALUATION_REASONING_EFFORT,
        timeoutMs,
        maxRetries: 1,
        promptCacheKey: "requirement-response-batch",
      });
      const rows = parseRequirementBatchRows(generated.rows);
      validateRequirementResponseBatchRows({ rows, entries, startIndex });
      return { rows, batchError: "", timedOut: false };
    } catch (error) {
      assertProjectWorkflowActive();
      console.info(
        JSON.stringify({
          event: "requirement_response_batch_fallback",
          ...safeErrorTelemetry(error),
          start_index: startIndex,
          count: entries.length,
          timed_out: isAiCallTimeoutError(error),
        }),
      );
      return {
        rows: [] as RequirementBatchAnswer[],
        // Closed codes only: this reason reaches repair prompts.
        batchError: isAiCallTimeoutError(error)
          ? "Kravsvar-batchen fikk ikke svar innen tidsfristen."
          : "Kravsvar-batch feilet.",
        timedOut: isAiCallTimeoutError(error),
      };
    }
  };
  const answersForBatch = (
    entries: RequirementLedgerEntry[],
    startIndex: number,
    result: Awaited<ReturnType<typeof runResponseBatch>>,
  ) =>
    entries.map((entry, localIndex) =>
      answerFromBatchRows({
        rows: result.rows,
        entry,
        absoluteIndex: startIndex + localIndex,
        batchError: result.batchError,
      }),
    );

  const firstPass = await mapWithConcurrency(
    chunks,
    REQUIREMENT_RESPONSE_BATCH_CONCURRENCY,
    async (chunk, chunkIndex) => {
      const relevantExcerpts = await awaitConcurrentTask(
        retrievalContextTasks[chunkIndex],
      );
      const result = await runResponseBatch(
        chunk.entries,
        chunk.startIndex,
        relevantExcerpts,
        REQUIREMENT_RESPONSE_BATCH_DEADLINE_RESERVE_MS,
      );
      completedBatches += 1;
      completedRequirements += chunk.entries.length;
      const answeredSoFar = Math.min(responseLedger.length, completedRequirements);
      input.onProgress?.(
        formatJobProgress(
          Math.min(72, 32 + Math.round((completedBatches / chunks.length) * 40)),
          `Besvart ${answeredSoFar} av ${responseLedger.length} krav ...`,
        ),
      );
      return { result, relevantExcerpts };
    },
  );

  // A timeout is the one recognised recoverable batch failure: retry it once
  // as two smaller halves, sharing the batch concurrency and the deadline.
  const splitRetries = firstPass.flatMap(({ result, relevantExcerpts }, chunkIndex) => {
    const chunk = chunks[chunkIndex];
    if (!chunk || !result.timedOut || chunk.entries.length < 2) return [];
    const middle = Math.ceil(chunk.entries.length / 2);
    return [
      { chunkIndex, startIndex: chunk.startIndex, entries: chunk.entries.slice(0, middle), relevantExcerpts },
      { chunkIndex, startIndex: chunk.startIndex + middle, entries: chunk.entries.slice(middle), relevantExcerpts },
    ];
  });
  if (splitRetries.length) {
    input.onProgress?.(
      formatJobProgress(
        74,
        `Prøver ${splitRetries.length / 2} tidsavbrutte svarbatcher på nytt i mindre deler ...`,
      ),
    );
  }
  const splitResults = await mapWithConcurrency(
    splitRetries,
    REQUIREMENT_RESPONSE_BATCH_CONCURRENCY,
    async (retry) => ({
      retry,
      answers: answersForBatch(
        retry.entries,
        retry.startIndex,
        await runResponseBatch(
          retry.entries,
          retry.startIndex,
          retry.relevantExcerpts,
          REQUIREMENT_RESPONSE_SPLIT_RETRY_DEADLINE_RESERVE_MS,
        ),
      ),
    }),
  );
  const batchAnswers = firstPass.map(({ result }, chunkIndex) => {
    const chunk = chunks[chunkIndex]!;
    const halves = splitResults.filter(({ retry }) => retry.chunkIndex === chunkIndex);
    return halves.length
      ? halves
          .sort((left, right) => left.retry.startIndex - right.retry.startIndex)
          .flatMap(({ answers }) => answers)
      : answersForBatch(chunk.entries, chunk.startIndex, result);
  });

  const initialAnswerResults = batchAnswers.flat();
  const failedBatches = initialAnswerResults.filter((answer) =>
    answer.reason?.includes("batch_error:"),
  ).length
    ? chunks.filter((_, chunkIndex) =>
        batchAnswers[chunkIndex]?.some((answer) =>
          answer.reason?.includes("batch_error:"),
        ),
      ).length
    : 0;
  const exactDuplicateReuseResult = reuseExactDuplicateRequirementAnswers({
    ledger: responseLedger,
    answers: initialAnswerResults,
  });
  const verifiedDeterministicAnswers =
    applyVerifiedDeterministicControlRepairs({
      ledger: responseLedger,
      answers: exactDuplicateReuseResult.answers,
    });
  const deterministicControlRepairStageByIndex = new Map<
    number,
    DeterministicControlRepairStage
  >();
  verifiedDeterministicAnswers.forEach((answer, index) => {
    if (answer.source === "deterministic_control_repair") {
      deterministicControlRepairStageByIndex.set(index, "pre_handoff");
    }
  });
  const handoffResult = await repairRequirementAnswersWithFullDocumentHandoff({
    projectName: input.projectName,
    baseContext: input.baseContext,
    ledger: responseLedger,
    answers: verifiedDeterministicAnswers,
    requirementDocuments: input.requirementDocuments,
    model: input.model,
    onProgress: input.onProgress,
  });
  const answerResults = handoffResult.answers;
  answerResults.forEach((answer, index) => {
    if (
      answer.source === "deterministic_control_repair" &&
      !deterministicControlRepairStageByIndex.has(index)
    ) {
      deterministicControlRepairStageByIndex.set(index, "handoff");
    }
  });
  const deterministicTemplateRepairMetadata =
    buildDeterministicTemplateRepairMetadata({
      answers: answerResults,
      ledger: responseLedger,
    });
  const deterministicControlRepairMetadata =
    buildDeterministicControlRepairMetadata({
      answers: answerResults,
      ledger: responseLedger,
      repairStageByIndex: deterministicControlRepairStageByIndex,
    });
  const proposalInputRequiredMetadata = buildProposalInputRequiredMetadata({
    ledger: responseLedger,
    answers: answerResults,
    evidenceDocuments: [
      ...input.supportingDocuments,
      ...input.serviceDocuments,
    ],
  });
  const reservations = input.solutionDocument
    ? narrativeAnswerEvidence(input.solutionDocument, responseLedger).filter((entry) =>
        supplierAnswerNeedsConfirmation(entry.answerExcerpt ?? ""))
    : [];
  const reservationById = new Map(reservations.map((entry) => [normalizeRequirementId(entry.id), entry]));
  const proposalInputRequired =
    proposalInputRequiredMetadata.proposal_input_required_count > 0 || reservations.length > 0;
  const manualReviewRequired =
    deterministicTemplateRepairMetadata.manual_review_required === true ||
    deterministicControlRepairMetadata.manual_review_required === true ||
    proposalInputRequired;
  const manualReviewNote = [
    deterministicTemplateRepairMetadata.manual_review_note,
    deterministicControlRepairMetadata.manual_review_note,
    reservations.length ? `${reservations.length} krav har uttrykkelige avvik eller uavklarte leverandørforutsetninger i løsningsgrunnlaget.` : "",
    proposalInputRequiredMetadata.proposal_input_required_count > 0
      ? `${proposalInputRequiredMetadata.proposal_input_required_count} krav trenger dokumentert leverandørbevis, kommersielle vilkår eller et eksplisitt tilbudsvalg før innlevering.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const fallbackStageMetadata = buildRequirementFallbackStageMetadata({
    afterBatch: initialAnswerResults,
    beforeHandoff: verifiedDeterministicAnswers,
    afterHandoff: answerResults,
  });
  const fallbackAnswersAfterHandoff =
    fallbackStageMetadata.deterministic_fallback_answers_after_handoff;
  const includeFailedAnswerSamples =
    process.env.REQUIREMENT_RESPONSE_DIAGNOSTIC_FAILED_ANSWERS === "1";
  const unresolvedFallbackAnswers = answerResults
    .map((answer, index) => ({
      answer,
      entry: responseLedger[index],
      index,
    }))
    .filter(
      (row): row is {
        answer: RequirementAnswerResult;
        entry: RequirementLedgerEntry;
        index: number;
      } => row.answer.source === "deterministic_fallback" && Boolean(row.entry),
    )
    .map((row) => ({
      nr: row.index + 1,
      ref: requirementDisplayRef(row.entry, requirementGroupHeading(row.entry)),
      reason: row.answer.reason,
      ...(includeFailedAnswerSamples && row.answer.rejectedAnswer
        ? {
            rejected_answer_sample: compactText(
              row.answer.rejectedAnswer,
              240,
            ),
          }
        : {}),
    }));
  const unresolvedBatchErrors = answerResults.filter(
    (answer) =>
      answer.source === "deterministic_fallback" &&
      answer.reason?.includes("batch_error:"),
  ).length;
  if (unresolvedBatchErrors > 0 || fallbackAnswersAfterHandoff > 0) {
    const unresolvedSummary = formatUnresolvedRequirementResponseSummary(
      unresolvedFallbackAnswers,
      includeFailedAnswerSamples,
    );
    const failureMessage = [
      "Kravbesvarelsen stoppet fordi AI-batcher feilet og full-dokument handoff ikke reparerte nok svar.",
      `${fallbackAnswersAfterHandoff} av ${responseLedger.length} svar står fortsatt som standardsvar etter handoff og kan ikke leveres automatisk.`,
      unresolvedSummary ? `Uavklarte krav: ${unresolvedSummary}.` : "",
      unresolvedBatchErrors
        ? `${unresolvedBatchErrors} svar kommer fra feilede batcher.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const unresolvedRefs = unresolvedFallbackAnswers
      .slice(0, 12)
      .map((row) => compactText(row.ref, 60))
      .join(", ");
    const publicMessage = [
      `Kravbesvarelsen ble ikke lagret fordi ${fallbackAnswersAfterHandoff} av ${responseLedger.length} krav ikke kunne besvares automatisk, heller ikke etter reparasjon.`,
      unresolvedRefs ? `Uavklarte krav: ${unresolvedRefs}${unresolvedFallbackAnswers.length > 12 ? " m.fl." : ""}.` : "",
      "Prøv igjen om litt.",
    ]
      .filter(Boolean)
      .join(" ");
    throw new ProjectWorkflowTerminalMetadataError(
      publicMessage,
      {
        requirement_response_handoff:
          handoffResult.metadata.strict_handoff,
      },
      failureMessage,
    );
  }

  input.onProgress?.(
    formatJobProgress(84, `Kontrollerer dekning for ${responseLedger.length} krav og bygger kravtabell ...`),
  );

  const contentMarkdown = buildRequirementResponseMarkdown({
    ledger: responseLedger,
    answers: answerResults.map((answer, index) => {
      const reservation = reservationById.get(normalizeRequirementId(responseLedger[index].id));
      if (!reservation) return answer;
      return {
        ...answer,
        answer: `Ubekreftet forutsetning – må avklares før innlevering. Løsningsgrunnlaget oppgir: «${reservation.answerExcerpt}» Forslag til svar etter avklaring: ${answer.answer}`,
        evidence: `${reservation.documentTitle}, ${reservation.id}: ${reservation.answerExcerpt}`,
      };
    }),
  });
  const requirementRefs = responseLedger.map((entry) =>
    requirementDisplayRef(entry, requirementGroupHeading(entry)),
  );
  const immutableRowManifest = buildImmutableRequirementRowManifest(
    responseLedger.map((entry, index) => ({
      ref: requirementRefs[index] ?? "",
      requirementText: entry.text,
      sourceLocator: requirementDisplaySource(
        entry,
        requirementGroupHeading(entry),
      ),
      sourceDocumentId: entry.documentId ?? null,
    })),
  );

  return {
    title: `Kravbesvarelse - ${input.projectName}`,
    content_markdown: contentMarkdown,
    generation_metadata: {
      requirement_response: {
        method: "ledger_batch",
        total_requirements: responseLedger.length,
        batch_count: chunks.length,
        failed_batches: failedBatches,
        ...fallbackStageMetadata,
        ...exactDuplicateReuseResult.metadata,
        ...deterministicTemplateRepairMetadata,
        ...deterministicControlRepairMetadata,
        ...proposalInputRequiredMetadata,
        manual_review_required: manualReviewRequired,
        ...(manualReviewNote
          ? { manual_review_note: manualReviewNote }
          : {}),
        full_document_handoff: handoffResult.metadata,
        requirement_refs: requirementRefs,
        immutable_row_manifest: immutableRowManifest,
        ...serializeUnresolvedRequirementFallbackAnswers(
          unresolvedFallbackAnswers,
        ),
        coverage_enforced: true,
        source_evidence_enforced: true,
        coverage_note:
          "Kravtabellen er bygget deterministisk fra kravledgeren. Lagring stoppes hvis kravrader eller kravreferanser mangler i kvalitetskontrollen.",
        ledger_confidence: input.ledgerConfidence,
      } satisfies RequirementResponseGenerationMetadata,
    },
  };
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

function buildDocumentTextChunks(
  document: ProjectDocumentDetail,
  options?: { maxChunks?: number; chunkLimit?: number },
): DocumentTextChunk[] {
  const chunkLimit = options?.chunkLimit ?? CHUNK_TEXT_LIMIT;
  const maxChunks = options?.maxChunks ?? MAX_DOCUMENT_CHUNKS;
  const entries = document.structure_map.length
    ? document.structure_map
    : [{ reference: document.title, text: document.raw_text }];
  const chunks: DocumentTextChunk[] = [];
  let currentText = "";
  let currentReferences: string[] = [];

  function flush() {
    if (!currentText.trim()) {
      return;
    }
    chunks.push({
      label: `${document.title} – del ${chunks.length + 1}`,
      text: compactText(currentText, chunkLimit),
      references: currentReferences,
    });
    currentText = "";
    currentReferences = [];
  }

  for (const entry of entries) {
    const entryText = compactText(entry.text, chunkLimit);
    if (!entryText) {
      continue;
    }

    const nextText = [currentText, `${entry.reference}\n${entryText}`]
      .filter(Boolean)
      .join("\n\n");

    if (nextText.length > chunkLimit && currentText) {
      flush();
    }

    currentText = [currentText, `${entry.reference}\n${entryText}`]
      .filter(Boolean)
      .join("\n\n");
    currentReferences.push(entry.reference);

    if (currentText.length >= chunkLimit) {
      flush();
    }

    if (chunks.length >= maxChunks) {
      break;
    }
  }

  flush();
  return chunks.slice(0, maxChunks);
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

type ConcurrentTaskResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

function startConcurrentTasks<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const resolvers: Array<(result: ConcurrentTaskResult<R>) => void> = [];
  const taskPromises = items.map(
    () =>
      new Promise<ConcurrentTaskResult<R>>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          resolvers[index]?.({
            ok: true,
            value: await mapper(items[index], index),
          });
        } catch (error) {
          resolvers[index]?.({ ok: false, error });
        }
      }
    },
  );

  void Promise.all(workers);
  return taskPromises;
}

async function awaitConcurrentTask<T>(
  task: Promise<ConcurrentTaskResult<T>>,
) {
  const result = await task;
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
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

function coverageEvidenceLinkTokens(value: string) {
  return new Set(
    tokenizeComparableText(value)
      .filter((token) => token.length >= 4)
      .filter((token) => !REQUIREMENT_RETRIEVAL_STOP_WORDS.has(token)),
  );
}

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

async function runWithProgressHeartbeat<T>(
  input: {
    onProgress?: (message: string) => void;
    message: string;
    intervalMs?: number;
  },
  run: () => Promise<T>,
) {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (input.onProgress) {
    heartbeat = setInterval(
      () => input.onProgress?.(input.message),
      input.intervalMs ?? REQUIREMENT_RESPONSE_PROGRESS_HEARTBEAT_MS,
    );
  }

  try {
    return await run();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}

async function createCustomerAnalysisV3Completion<T>(input: {
  system: string;
  user: string;
  model?: string;
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
  const analysisRetrieval = await retrieveDocumentSnippetsWithMetadata({
    query: [
      input.projectName,
      "kundens behov mål krav risiko evalueringskriterier forutsetninger arkitektur løsning verdi",
    ].join("\n"),
    projectId: input.customerDocument.project_id,
    documents: analysisDocuments,
    exactTerms: ["krav", "behov", "risiko", "evalueringskriterier", "mål"],
    limit: 10,
  });
  const supportingContexts = input.supportingDocuments
    .slice(0, 2)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 4000,
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
      textLimit: 12000,
      structureLimit: 10,
      structureTextLimit: 180,
    }),
    retrievedSnippetContext(
      "Semantisk dokumentdekning",
      analysisRetrieval.snippets,
      { textLimit: 1200 },
    ),
    buildDelimitedContext(
      "Retrieval-kvalitet",
      JSON.stringify(analysisRetrieval.telemetry.quality),
    ),
    buildDelimitedContext(
      "Dokumentdekningsregel",
      "Bruk strukturkartet og tekstutdraget aktivt. Hvis dokumentet viser til tabeller, figurer, vedlegg eller krav som ikke er synlige i tekstutdraget, marker dette nøkternt som et verifikasjonsbehov i analysen fremfor å anta innhold.",
    ),
    serviceRecommendationContext(input.serviceCandidates),
    supportingContexts
      ? buildDelimitedContext(
          "Tilleggsregel",
          "Bruk støttedokumentene bare som støtte og kontekst. Ikke la dem overstyre primært kundedokument.",
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
      retrieval_used: true,
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
  return normalizedEvaluation;
}

type ArtifactKnowledgeItem = {
  title: string;
  content_markdown: string;
  artifact_type: GeneratedArtifactType;
};

type ProjectArtifactGenerationInput = {
  artifactType: GeneratedArtifactType;
  projectName: string;
  customerAnalysis: CustomerAnalysisResult | null;
  solutionEvaluation: SolutionEvaluationResult | null;
  customerDocument: ProjectDocumentDetail | null;
  solutionDocument: ProjectDocumentDetail | null;
  serviceDescriptionDocument?: ProjectDocumentDetail | null;
  serviceDescriptionDocuments?: ServiceDocumentDetail[];
  serviceDocumentSummaries?: ServiceDocument[];
  supportingDocuments: ProjectDocumentDetail[];
  requirementDocuments?: ProjectDocumentDetail[];
  knowledgeArtifacts: ArtifactKnowledgeItem[];
  instructions?: string;
  model?: string;
  onProgress?: (message: string) => void;
  documentLedgerContext?: string;
};

type GeneratedArtifactDraft = {
  title: string;
  content_markdown: string;
  generation_metadata?: unknown;
};

function parseGeneratedArtifactDraft(
  value: Untrusted<GeneratedArtifactDraft>,
): GeneratedArtifactDraft {
  return {
    title: stringOr(value.title),
    content_markdown: stringOr(value.content_markdown),
    generation_metadata: value.generation_metadata,
  };
}

type RequirementArtifactContext = {
  requirementDocuments: ProjectDocumentDetail[];
  requirementLedger: RequirementLedgerEntry[];
  requirementLedgerConfidence: RequirementLedgerConfidence;
  useRequirementLedgerGeneration: boolean;
  requirementDocumentContext: string;
  requirementContinuityContext: string;
  requirementSourceLedgerContext: string;
  requirementFileDocuments: ProjectDocumentDetail[];
  continuationPages: ReturnType<typeof buildContinuationPageMap>;
  pageEvidence: ReturnType<typeof buildRequirementPageEvidence>;
  alignmentRequirementLedger: RequirementLedgerEntry[];
  alignmentRequirementRefs: string[];
};

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

export function selectRequirementDocumentsForGeneration(
  input: ProjectArtifactGenerationInput,
) {
  const hasExplicitRequirementDocuments = Boolean(input.requirementDocuments?.length);
  const primaryCustomerDocumentId = input.customerDocument?.id ?? null;
  const requirementDocuments =
    input.artifactType === "forbedret_kravsvar"
      ? canonicalRequirementSourceDocuments({
          customerDocument: input.customerDocument,
          documents: hasExplicitRequirementDocuments
            ? (input.requirementDocuments ?? [])
            : [input.solutionDocument, ...input.supportingDocuments].filter(
                (document): document is ProjectDocumentDetail =>
                  document !== null,
              ),
        })
      : [];

  return {
    hasExplicitRequirementDocuments,
    primaryCustomerDocumentId,
    requirementDocuments,
  };
}

export function assertVerifiedRequirementLedgerGeneration(input: {
  artifactType: GeneratedArtifactType;
  requirementDocumentCount: number;
  requirementCount: number;
  confidence: Pick<RequirementLedgerConfidence, "score" | "level">;
  verified: boolean;
}) {
  if (input.artifactType !== "forbedret_kravsvar" || input.verified) {
    return;
  }

  const reason = input.requirementDocumentCount
    ? `kravledgeren har utilstrekkelig tillit (${input.requirementCount} krav, score ${input.confidence.score}, nivå ${input.confidence.level})`
    : "ingen kravdokumenter er valgt eller gjenkjent";
  throw new Error(
    `Kravbesvarelsen stoppet fordi ${reason}. Full-dokumentgenerering kan ikke lagres uten en verifisert kravledger med forventet antall, referanser og kildegrunnlag. Kontroller dokumenttype/OCR og prøv igjen.`,
  );
}

export function assertRequirementArtifactSourceLedgersComplete(input: {
  artifactType: GeneratedArtifactType;
  requirementDocuments: ProjectDocumentDetail[];
  requirementLedgerResults: Array<{
    document: Pick<ProjectDocumentDetail, "id">;
    ledger: RequirementLedgerEntry[];
  }>;
}) {
  if (input.artifactType !== "forbedret_kravsvar") {
    return;
  }
  assertExplicitRequirementLedgersComplete(
    input.requirementDocuments,
    input.requirementLedgerResults,
  );
  for (const result of input.requirementLedgerResults) {
    assertRequirementLedgerQualityForEvaluation(result.ledger, {
      stage: "forbedret_kravsvar_source_ledger",
      documentTitle:
        input.requirementDocuments.find(
          (document) => document.id === result.document.id,
        )?.title ?? result.document.id,
    });
  }
}

async function buildRequirementArtifactContext(
  input: ProjectArtifactGenerationInput,
): Promise<RequirementArtifactContext> {
  const {
    hasExplicitRequirementDocuments,
    primaryCustomerDocumentId,
    requirementDocuments,
  } = selectRequirementDocumentsForGeneration(input);
  const requirementLedgerResults =
    input.artifactType === "forbedret_kravsvar"
      ? await mapWithConcurrency(
          requirementDocuments,
          3,
          async (document) => ({
            document,
            // The same extractor as the evaluation (including the
            // document's corrections chapter), so both see one register.
            ...await extractRequirementLedgerWithCorrections(document),
          }),
        )
      : [];
  assertRequirementArtifactSourceLedgersComplete({
    artifactType: input.artifactType,
    requirementDocuments,
    requirementLedgerResults,
  });
  const requirementLedger = sortRequirementLedgerInDocumentOrder(
    canonicalizeRequirementSourceLedger({
      sourceDocuments: requirementDocuments,
      requirementLedgerResults,
    }),
  );
  const requirementLedgerConfidence = assessRequirementLedgerConfidence({
    ledger: requirementLedger,
    hasExplicitRequirementDocuments,
    requirementDocuments,
  });
  const useRequirementLedgerGeneration =
    input.artifactType === "forbedret_kravsvar" &&
    shouldUseRequirementLedgerGeneration({
      ledger: requirementLedger,
      hasExplicitRequirementDocuments,
      requirementDocuments,
      confidence: requirementLedgerConfidence,
    });
  if (input.artifactType === "forbedret_kravsvar") {
    assertVerifiedRequirementLedgerGeneration({
      artifactType: input.artifactType,
      requirementDocumentCount: requirementDocuments.length,
      requirementCount: requirementLedger.length,
      confidence: requirementLedgerConfidence,
      verified: useRequirementLedgerGeneration,
    });

    input.onProgress?.(
      formatJobProgress(24, `Kravledger klar med ${requirementLedger.length} krav fra ${requirementDocuments.length} dokument(er), tillit ${requirementLedgerConfidence.level}.`),
    );
  }

  const requirementDocumentTextLimit = Math.max(
    1200,
    Math.floor(120_000 / Math.max(1, requirementDocuments.length)),
  );
  const requirementDocumentContext =
    input.artifactType === "forbedret_kravsvar" && !useRequirementLedgerGeneration
      ? requirementDocuments
          .map((document, index) =>
            documentContext(`Kravdokument ${index + 1}`, document, {
              textLimit: requirementDocumentTextLimit,
              structureLimit: 12,
              structureTextLimit: 180,
            }),
          )
          .join("\n\n")
      : "";
  const requirementContinuityContext =
    input.artifactType === "forbedret_kravsvar" && !useRequirementLedgerGeneration
      ? requirementDocuments
          .map((document) => buildRequirementContinuityContext(document))
          .filter(Boolean)
          .join("\n\n")
      : "";
  const requirementSourceLedgerContext =
    input.artifactType === "forbedret_kravsvar" && !useRequirementLedgerGeneration
      ? requirementDocuments
          .map((document, index) =>
            buildRequirementSourceLedgerContext(
              document,
              requirementLedgerResults[index]?.ledger ?? [],
            ),
          )
          .filter(Boolean)
          .join("\n\n")
      : "";
  const requirementFileDocuments =
    input.artifactType === "forbedret_kravsvar" && !useRequirementLedgerGeneration
      ? (hasExplicitRequirementDocuments
          ? (input.requirementDocuments ?? [])
          : [
              input.customerDocument,
              input.solutionDocument,
              ...input.supportingDocuments,
            ])
          .filter(
            (document): document is ProjectDocumentDetail =>
              document !== null &&
              (hasExplicitRequirementDocuments ||
                document.id === primaryCustomerDocumentId ||
                isRequirementDocument(document)) &&
              ["pdf", "xlsx", "xls"].includes(document.file_format) &&
              Boolean(document.file_base64),
          )
          .slice(0, 3)
      : [];
  const continuationPages = buildContinuationPageMap(requirementDocuments);
  const pageEvidence = buildRequirementPageEvidence(requirementDocuments);
  const alignmentRequirementLedger = isReliableRequirementLedger(requirementLedger)
    ? requirementLedger
    : [];
	  const alignmentRequirementRefs = alignmentRequirementLedger.map((entry) =>
	    requirementDisplayRef(entry, requirementGroupHeading(entry)),
	  );

  return {
    requirementDocuments,
    requirementLedger,
    requirementLedgerConfidence,
    useRequirementLedgerGeneration,
    requirementDocumentContext,
    requirementContinuityContext,
    requirementSourceLedgerContext,
    requirementFileDocuments,
    continuationPages,
    pageEvidence,
    alignmentRequirementLedger,
    alignmentRequirementRefs,
  };
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
  const artifactRetrievalDocuments = [
    input.customerDocument,
    input.solutionDocument,
    ...input.supportingDocuments,
  ].filter((document): document is ProjectDocumentDetail => Boolean(document));
  const artifactRetrieval = await retrieveDocumentSnippetsWithMetadata({
    query: [
      input.projectName,
      input.artifactType,
      input.instructions ?? "",
      input.customerAnalysis ? summarizeCustomerAnalysis(input.customerAnalysis) : "",
      input.solutionEvaluation
        ? summarizeSolutionEvaluation(input.solutionEvaluation)
        : "",
      "krav behov risiko verdi evalueringskriterier løsning gjennomføring drift kontrakt",
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

function buildRequirementAnswerFoundation(input: {
  generationInput: ProjectArtifactGenerationInput;
  requirementDocuments: ProjectDocumentDetail[];
  foundationFacts: ArtifactFoundationFact[];
  artifactRetrievalContext: string;
  retrievalQualityContext: string;
  serviceSummaryContext: string;
  serviceDescriptionContext: string;
  artifactKnowledge: string;
}) {
  const requirementDocumentIds = new Set(
    input.requirementDocuments.map((document) => document.id),
  );
  const supportingDocuments =
    input.generationInput.supportingDocuments.filter(
      (document) => !requirementDocumentIds.has(document.id),
    );
  const supportingContexts = supportingDocuments
    .slice(0, 3)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 1200,
        structureLimit: 4,
        structureTextLimit: 110,
      }),
    )
    .join("\n\n");
  const supplementalDocumentLedgerContext =
    suppressDuplicatedDocumentLedgerContext({
      documentLedgerContext: input.generationInput.documentLedgerContext,
      authoritativeRequirementRegistryPresent: true,
    });
  const baseContext = [
    input.generationInput.instructions
      ? buildDelimitedContext("Brukerbestilling", input.generationInput.instructions)
      : "",
    supplementalDocumentLedgerContext
      ? buildDelimitedContext(
          "Strukturert dokumentledger",
          supplementalDocumentLedgerContext,
        )
      : "",
    buildDelimitedContext(
      "Prosjekt",
      `Prosjektnavn: ${input.generationInput.projectName}`,
    ),
    buildDelimitedContext(
      "Kunnskapsregel",
      "Bruk prosjektgrunnlaget som kunnskapsbase for svarene, men kravlisten nedenfor er fasiten for hvilke krav som skal besvares. Ikke finn nye krav og ikke utelat krav fra listen.",
    ),
    buildFoundationFactsContext(input.foundationFacts),
    input.artifactRetrievalContext,
    input.retrievalQualityContext,
    input.serviceSummaryContext,
    input.serviceDescriptionContext
      ? buildDelimitedContext(
          "Regel for tjenestebeskrivelse",
          "Bruk bare relevante deler av tjenestebeskrivelsene, og knytt dem konkret til kravet. Ikke list alt firmaet tilbyr ukritisk.",
        )
      : "",
    input.serviceDescriptionContext,
    input.generationInput.customerAnalysis
      ? buildDelimitedContext(
          "Kundeanalyse",
          summarizeCustomerAnalysis(input.generationInput.customerAnalysis),
        )
      : "",
    input.generationInput.solutionEvaluation
      ? buildDelimitedContext(
          "Løsningsvurdering",
          summarizeSolutionEvaluation(input.generationInput.solutionEvaluation),
        )
      : "",
    input.generationInput.customerDocument
      ? buildDelimitedContext(
          "Primært kundedokument sammendrag",
          compactText(input.generationInput.customerDocument.raw_text, 1200),
        )
      : "",
    input.generationInput.solutionDocument
      ? buildDelimitedContext(
          "Primært løsningsdokument sammendrag",
          compactText(input.generationInput.solutionDocument.raw_text, 1200),
        )
      : "",
    supportingContexts,
    input.artifactKnowledge,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { baseContext, supportingDocuments };
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

function withAlignedRequirementResponse(
  generated: GeneratedArtifactDraft,
  context: RequirementArtifactContext,
  options: {
    timeoutMs: number;
    fileInputUsed: boolean;
  },
) {
  const alignedContent = alignRequirementRowsWithLedger(
    mergeContinuationRowsInRequirementTable(
      generated.content_markdown,
      context.continuationPages,
      context.pageEvidence,
    ),
    context.alignmentRequirementLedger,
  );
  const immutableRowManifest = buildImmutableRequirementRowManifest(
    context.alignmentRequirementLedger.map((entry, index) => ({
      ref:
        context.alignmentRequirementRefs[index] ??
        requirementDisplayRef(entry, requirementGroupHeading(entry)),
      requirementText: entry.text,
      sourceLocator: requirementDisplaySource(
        entry,
        requirementGroupHeading(entry),
      ),
      sourceDocumentId: entry.documentId ?? null,
    })),
  );

  return {
    ...generated,
    content_markdown: alignedContent,
    generation_metadata: {
      requirement_response: {
        method: "full_document",
        total_requirements: context.alignmentRequirementLedger.length || undefined,
        requirement_refs: context.alignmentRequirementRefs.length
          ? context.alignmentRequirementRefs
          : undefined,
        immutable_row_manifest: immutableRowManifest,
        coverage_enforced: context.alignmentRequirementLedger.length > 0,
        source_evidence_enforced: context.alignmentRequirementLedger.length > 0,
        full_document_timeout_ms: options.timeoutMs,
        file_input_used: options.fileInputUsed,
        ledger_confidence: context.requirementLedgerConfidence,
      } satisfies RequirementResponseGenerationMetadata,
    },
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

    return generateRequirementResponseFromLedger({
      projectName: input.projectName,
      baseContext: requirementAnswer.baseContext,
      ledger: requirementContext.requirementLedger,
      solutionDocument: input.solutionDocument,
      ledgerConfidence: requirementContext.requirementLedgerConfidence,
      requirementDocuments: requirementContext.requirementDocuments,
      supportingDocuments: requirementAnswer.supportingDocuments,
      serviceDocuments,
      model: input.model,
      onProgress: input.onProgress,
    });
  }

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
