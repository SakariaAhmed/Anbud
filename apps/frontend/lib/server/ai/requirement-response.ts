import "server-only";

import { isRequirementDocument } from "@/lib/document-processing";
import { isMarkdownTableDivider } from "@/lib/markdown-table-row";
import { formatJobProgress } from "@/lib/project-job-progress";
import {
  REQUIREMENT_RESPONSE_TABLE_HEADINGS,
  requirementResponseTableColumns,
} from "@/lib/requirement-response-table";

import { narrativeAnswerEvidence } from "@/lib/server/requirements/narrative-answer-evidence";

import { createJsonCompletion } from "@/lib/server/ai/completion";
import {
  compactText,
  documentContext,
  retrievedSnippetContext,
  summarizeCustomerAnalysis,
  summarizeSolutionEvaluation,
} from "@/lib/server/ai/context";

import { performance } from "node:perf_hooks";

import { isAiCallTimeoutError } from "@/lib/server/ai/json-completion";
import {
  ANALYSIS_REASONING_EFFORT,
  EVALUATION_REASONING_EFFORT,
  requirementResponseBatchModel,
  requirementResponseRepairModel,
} from "@/lib/server/ai/model-config";
import {
  buildImmutableRequirementRowManifest,
  type ImmutableRequirementRowManifest,
} from "@/lib/server/artifact-validation";
import { retrieveDocumentSnippets } from "@/lib/server/document-chunks";
import { stringFields, untrustedRows } from "@/lib/unknown-values";

import {
  isNearDuplicate,
  normalizeComparableText,
} from "@/lib/server/document-intelligence/text-normalization";

import { ProjectWorkflowTerminalMetadataError } from "@/lib/server/project-job-terminal-metadata";
import {
  assertProjectWorkflowActive,
  bindProjectWorkflowTerminalMetadataReporter,
  boundedByProjectWorkflowDeadline,
  getProjectWorkflowAbortSignal,
  projectWorkflowRemainingMs,
} from "@/lib/server/project-workflow-cancellation";
import { buildDelimitedContext } from "@/lib/server/prompts";
import {
  requirementBatchSystemPrompt,
  requirementHandoffSystemPrompt,
} from "@/lib/server/prompts/requirements";

import { detectExplicitRequirementIds } from "@/lib/server/requirements/id-detection";
import { assertRequirementLedgerQualityForEvaluation } from "@/lib/server/requirements/ledger-quality";
import {
  markdownTableCell,
  splitMarkdownTableRow,
  toMarkdownTableRow,
} from "@/lib/server/requirements/markdown-table";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";
import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";

import {
  ArtifactFoundationFact,
  GeneratedArtifactDraft,
  ProjectArtifactGenerationInput,
  RequirementArtifactContext,
} from "@/lib/server/ai/artifact-generation-types";
import { buildDocumentTextChunks } from "@/lib/server/ai/document-chunk-context";
import {
  awaitConcurrentTask,
  boundedIntegerEnv,
  runWithProgressHeartbeat,
  startConcurrentTasks,
} from "@/lib/server/ai/generation-runtime";
import {
  buildDeterministicControlRepairMetadata,
  buildDeterministicFinalRequirementControlRepair,
  buildDeterministicFinalRequirementTemplateRepair,
  buildPerRequirementRetrievalContext,
  buildRequirementRepairDirective,
  buildRequirementResponseBatchRegistry,
  type DeterministicControlRepairPattern,
  type DeterministicControlRepairStage,
  mapWithConcurrency,
  parsePositiveIntegerEnv,
  type RequirementLedgerConfidence,
  requiresExpandedRequirementAnswer,
  STANDARD_SUPPLIER_PERFORMANCE_BASELINE,
  supplierAnswerNeedsConfirmation,
  suppressDuplicatedDocumentLedgerContext,
} from "@/lib/server/ai/requirement-coverage";
import { requirementRetrievalTokens } from "@/lib/server/ai/requirement-evidence-tokens";
import { assessRequirementLedgerConfidence } from "@/lib/server/ai/requirement-ledger-confidence";
import {
  requirementAnswerSolutionContext,
  solutionDocumentFitsRequirementPrompt,
} from "@/lib/server/ai/solution-document-context";
import {
  documentedPerformanceTargets,
  isNoMaterialSlownessDimensioningRequirement,
  normalizeRequirementAnswerResult,
  type RequirementAnswerResult,
  type RequirementAnswerSource,
} from "@/lib/server/requirements/answer-quality";
import {
  buildRequirementContinuityContext,
  isSyntheticRequirementId,
  normalizeRequirementLedgerText,
} from "@/lib/server/requirements/pdf-layout-ledger";
import {
  requirementDisplayRef,
  requirementDisplaySource,
  requirementGroupHeading,
  requirementLedgerSource,
  requirementTableMarkdown,
  sortRequirementLedgerInDocumentOrder,
} from "@/lib/server/requirements/presentation";
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
import {
  assertExplicitRequirementLedgersComplete,
  canonicalizeRequirementSourceLedger,
  canonicalRequirementSourceDocuments,
} from "@/lib/server/requirements/source-readiness";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import { textCoverageScore } from "@/lib/server/requirements/unstructured-ledger";
import { safeErrorTelemetry } from "@/lib/server/safe-errors";
import type { GeneratedArtifactType, ProjectDocumentDetail } from "@/lib/types";

// Requirement-response generation owns ledger context, answer batches, repair
// handoffs, deadline/progress state and publication metadata. Persistence and
// source-revision fencing remain with the workflow and repository.

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

// Exported for the full-document fallback regression test.
// fallow-ignore-next-line unused-export
export function alignRequirementRowsWithLedger(
  contentMarkdown: string,
  ledger: RequirementLedgerEntry[],
  solutionText = "",
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
        solutionText,
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
  /** Searched passages of a solution document too long for the prompt. */
  solutionPassages?: string;
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
    input.solutionPassages ?? "",
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
  solutionText?: string;
  solutionPassages?: string;
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
      input.solutionText,
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
        solutionPassages: input.solutionPassages,
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
      solutionText: input.solutionText,
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
  solutionText?: string;
  solutionDocument?: ProjectDocumentDetail | null;
  model?: string;
  onProgress?: (message: string) => void;
}) {
  // Repairs see the same searched passages as the answer batches when the
  // solution document is too long to send whole.
  const solutionPassagesFor = (rows: Array<{ entry: RequirementLedgerEntry; absoluteIndex: number }>) =>
    input.solutionDocument && !solutionDocumentFitsRequirementPrompt(input.solutionDocument)
      ? buildPerRequirementRetrievalContext({
          entries: rows.map((row) => row.entry),
          solutionDocument: input.solutionDocument,
          startIndex: 0,
          numbers: rows.map((row) => row.absoluteIndex + 1),
        })
      : Promise.resolve("");
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
      const solutionPassages = await solutionPassagesFor(chunk);
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
            input.solutionText,
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
                solutionPassages,
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
            solutionText: input.solutionText,
          });
          if (repaired.source === "deterministic_fallback") {
            repaired = resolveRequirementAnswerBeforeStrictHandoff({
              entry: row.entry,
              current: repaired,
              solutionText: input.solutionText,
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
        const solutionPassages = await solutionPassagesFor([row]);
        const strictAttempt = await strictHandoffGovernor.run((timeoutMs) =>
          repairSingleRequirementAnswerWithStrictHandoff({
            projectName: input.projectName,
            acceptedAnswerContext,
            row: { ...row, current: repaired },
            rejectionReason: repaired.reason,
            solutionText: input.solutionText,
            solutionPassages,
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
          solutionText: input.solutionText,
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
  /** The solution document the answers were written from. */
  solutionText?: string;
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

  return normalizeRequirementAnswerResult(answer, input.entry, evidence, input.solutionText);
}

export function resolveRequirementAnswerAfterStrictHandoff(input: {
  entry: RequirementLedgerEntry;
  current: RequirementAnswerResult;
  strictRepair: RequirementAnswerResult | null;
  solutionText?: string;
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
      solutionText: input.solutionText,
    }) ??
    buildDeterministicFinalRequirementTemplateRepair({
      entry: input.entry,
      evidence: input.current.evidence,
      solutionText: input.solutionText,
    }) ??
    input.current
  );
}

export function resolveRequirementAnswerBeforeStrictHandoff(input: {
  entry: RequirementLedgerEntry;
  current: RequirementAnswerResult;
  solutionText?: string;
}) {
  if (input.current.source !== "deterministic_fallback") {
    return input.current;
  }

  return (
    buildDeterministicFinalRequirementControlRepair({
      entry: input.entry,
      evidence: input.current.evidence,
      solutionText: input.solutionText,
    }) ?? input.current
  );
}

export function applyVerifiedDeterministicControlRepairs(input: {
  ledger: RequirementLedgerEntry[];
  answers: RequirementAnswerResult[];
  solutionText?: string;
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
        solutionText: input.solutionText,
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
  solutionText?: string;
}) {
  const indexedRows = input.ledger.map((entry, index) => {
    const answerResult = input.answers[index];
    const heading = requirementGroupHeading(entry);
    const answer = answerResult?.answer ?? tableRequirementAnswer(entry);
    const evidence = requirementAnswerEvidence(entry, answerResult?.evidence, input.solutionText);

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

export async function generateRequirementResponseFromLedger(input: {
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
    async (chunk) => {
      // A solution document too long for the prompt is searched for each
      // requirement, as in the solution evaluation: one query for the whole
      // batch left most requirements without their passage.
      const [supportingContext, solutionContext] = await Promise.all([
        buildRequirementBatchRetrievalContext({
          entries: chunk.entries,
          supportingDocuments: input.supportingDocuments,
          serviceDocuments: input.serviceDocuments,
        }),
        input.solutionDocument && !solutionDocumentFitsRequirementPrompt(input.solutionDocument)
          ? buildPerRequirementRetrievalContext({
              entries: chunk.entries,
              solutionDocument: input.solutionDocument,
              startIndex: chunk.startIndex,
            })
          : "",
      ]);
      return [supportingContext, solutionContext].filter(Boolean).join("\n\n");
    },
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
        solutionText: input.solutionDocument?.raw_text,
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
      solutionText: input.solutionDocument?.raw_text,
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
    solutionText: input.solutionDocument?.raw_text,
    solutionDocument: input.solutionDocument,
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
    solutionText: input.solutionDocument?.raw_text,
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

export async function buildRequirementArtifactContext(
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

export function buildRequirementAnswerFoundation(input: {
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
      ? requirementAnswerSolutionContext(input.generationInput.solutionDocument)
      : "",
    supportingContexts,
    input.artifactKnowledge,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { baseContext, supportingDocuments };
}

export function withAlignedRequirementResponse(
  generated: GeneratedArtifactDraft,
  context: RequirementArtifactContext,
  options: {
    timeoutMs: number;
    fileInputUsed: boolean;
    solutionText?: string;
  },
) {
  const alignedContent = alignRequirementRowsWithLedger(
    mergeContinuationRowsInRequirementTable(
      generated.content_markdown,
      context.continuationPages,
      context.pageEvidence,
    ),
    context.alignmentRequirementLedger,
    options.solutionText,
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
