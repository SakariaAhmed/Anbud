import "server-only";

import { unstable_cache } from "next/cache";

import { analysisContentEqual, withoutAnalysisRevision } from "@/lib/customer-analysis-version";
import { appendCustomerAnalysisSectionHistory, CUSTOMER_ANALYSIS_SECTIONS } from "@/lib/customer-analysis-history";
import { decryptJson, encryptJson } from "@/lib/server/crypto";
import { createServiceClient } from "@/lib/server/data-api";
import type { ArtifactSourceRevisions } from "@/lib/server/repositories/artifacts";
import { runLeaseFencedCustomerAnalysisMutation, runLeaseFencedExecutiveSummaryMutation, runLeaseFencedSolutionEvaluationMutation } from "@/lib/server/repositories/lease-fenced-persistence";
import { keywordsFromText, mergeKeywords } from "@/lib/server/repositories/project-keywords";
import type { Json } from "@/lib/server/repositories/project-rows";
import { projectTag, revalidateProjectCaches } from "@/lib/server/repositories/repository-cache";
import type { CustomerAnalysisHistorySource, CustomerAnalysisResult, CustomerAnalysisSection, ExecutiveSummaryResult, SolutionEvaluationResult } from "@/lib/types";

export interface CustomerAnalysisRow {
  revision?: string;
  id: string;
  project_id: string;
  source_document_ids: string[];
  result_json: Json;
  created_at: string;
  updated_at: string;
}

interface SolutionEvaluationRow {
  id: string;
  project_id: string;
  source_document_ids: string[];
  customer_document_id: string | null;
  solution_document_id: string | null;
  analysis_id: string | null;
  evaluated_generated_artifact_id?: string | null;
  evaluation_provenance_mode?:
    | "document_only"
    | "generated_artifact"
    | "legacy_unknown";
  result_json: Json;
  created_at: string;
  updated_at: string;
}

interface ExecutiveSummaryRow {
  id: string;
  project_id: string;
  result_json: Json;
  input_snapshot: Json;
  created_at: string;
  updated_at: string;
}

const CUSTOMER_ANALYSIS_EMPTY: CustomerAnalysisResult = {
  customer_profile_summary: "",
  customer_goals_summary: "",
  high_level_solution_design: "",
  high_level_architecture_mermaid: "",
  customer_profile: [],
  customer_goals: [],
  implicit_requirements: [],
  prioritized_requirements: [],
  ambiguities: [],
  risks: [],
  risks_for_us: [],
  risks_for_customer: [],
  likely_evaluation_criteria: [],
  signal_words: [],
  signal_word_counts: {},
  expected_solution_direction: [],
  recommended_services: [],
  value_opportunities: [],
  positioning_recommendations: [],
  executive_summary: "",
  section_histories: {},
};

const SOLUTION_EVALUATION_EMPTY: SolutionEvaluationResult = {
  fit_to_customer_needs: "",
  strengths: [],
  weaknesses: [],
  generic_sections: [],
  missing_elements: [],
  risks_to_customer: [],
  trust_signals: [],
  likely_score_assessment: {
    quality: "",
    delivery_confidence: "",
    risk: "",
    competitiveness: "",
  },
  improvement_recommendations: [],
  value_assessment: [],
  rewrite_suggestions: [],
  document_findings: [],
  requirement_coverage: {
    total_requirements: 0,
    assessed_requirements: 0,
    good: 0,
    weak: 0,
    missing: 0,
    unclear: 0,
    confidence: "Lav",
    coverage_summary: "",
    items: [],
  },
  architecture_comparison: {
    winner: "Uavgjort",
    architect_solution_score: 0,
    system_solution_score: 0,
    verdict: "",
    strong_critique: [],
    pragmatic_reflections: [],
    strategy_improvement_advice: [],
  },
  executive_summary: "",
};

type RequirementCoverage = NonNullable<SolutionEvaluationResult["requirement_coverage"]>;

function sanitizeRequirementCoverage(
  coverage: RequirementCoverage | undefined,
): RequirementCoverage | undefined {
  if (!coverage?.items?.length) {
    return coverage;
  }

  // The evaluated array is already in authoritative ledger order. Preserve
  // every row (including generated fallback references) and rebuild the
  // persisted position from that array instead of trusting legacy/model
  // indexes. This keeps read/save round-trips zero-based and gap-free.
  const items = coverage.items.map((item, orderIndex) => ({
    ...item,
    order_index: orderIndex,
  }));

  return {
    ...coverage,
    items,
  };
}

export function sanitizeSolutionEvaluationResult(
  result: SolutionEvaluationResult,
): SolutionEvaluationResult {
  const score = result.likely_score_assessment ??
    SOLUTION_EVALUATION_EMPTY.likely_score_assessment;
  const comparison = result.architecture_comparison ??
    SOLUTION_EVALUATION_EMPTY.architecture_comparison;
  const coverage = result.requirement_coverage
    ? {
        ...SOLUTION_EVALUATION_EMPTY.requirement_coverage,
        ...result.requirement_coverage,
        items: Array.isArray(result.requirement_coverage.items)
          ? result.requirement_coverage.items
          : [],
      }
    : undefined;
  return {
    ...SOLUTION_EVALUATION_EMPTY,
    ...result,
    strengths: Array.isArray(result.strengths) ? result.strengths : [],
    weaknesses: Array.isArray(result.weaknesses) ? result.weaknesses : [],
    generic_sections: Array.isArray(result.generic_sections)
      ? result.generic_sections
      : [],
    missing_elements: Array.isArray(result.missing_elements)
      ? result.missing_elements
      : [],
    risks_to_customer: Array.isArray(result.risks_to_customer)
      ? result.risks_to_customer
      : [],
    trust_signals: Array.isArray(result.trust_signals)
      ? result.trust_signals
      : [],
    likely_score_assessment: {
      quality: typeof score?.quality === "string" ? score.quality : "",
      delivery_confidence:
        typeof score?.delivery_confidence === "string"
          ? score.delivery_confidence
          : "",
      risk: typeof score?.risk === "string" ? score.risk : "",
      competitiveness:
        typeof score?.competitiveness === "string"
          ? score.competitiveness
          : "",
    },
    improvement_recommendations: Array.isArray(
      result.improvement_recommendations,
    )
      ? result.improvement_recommendations
      : [],
    value_assessment: Array.isArray(result.value_assessment)
      ? result.value_assessment.filter(
          (item) => item && typeof item === "object",
        )
      : [],
    rewrite_suggestions: Array.isArray(result.rewrite_suggestions)
      ? result.rewrite_suggestions.filter(
          (item) => item && typeof item === "object",
        )
      : [],
    document_findings: Array.isArray(result.document_findings)
      ? result.document_findings.filter(
          (item) => item && typeof item === "object",
        )
      : [],
    requirement_coverage: sanitizeRequirementCoverage(coverage),
    architecture_comparison: {
      winner:
        comparison?.winner === "Systemløsning" ||
        comparison?.winner === "Arkitektløsning" ||
        comparison?.winner === "Uavgjort"
          ? comparison.winner
          : "Uavgjort",
      architect_solution_score:
        typeof comparison?.architect_solution_score === "number" &&
        Number.isFinite(comparison.architect_solution_score)
          ? Math.min(100, Math.max(0, comparison.architect_solution_score))
          : 0,
      system_solution_score:
        typeof comparison?.system_solution_score === "number" &&
        Number.isFinite(comparison.system_solution_score)
          ? Math.min(100, Math.max(0, comparison.system_solution_score))
          : 0,
      verdict:
        typeof comparison?.verdict === "string" ? comparison.verdict : "",
      strong_critique: Array.isArray(comparison?.strong_critique)
        ? comparison.strong_critique
        : [],
      pragmatic_reflections: Array.isArray(comparison?.pragmatic_reflections)
        ? comparison.pragmatic_reflections
        : [],
      strategy_improvement_advice: Array.isArray(
        comparison?.strategy_improvement_advice,
      )
        ? comparison.strategy_improvement_advice
        : [],
    },
  };
}

const EXECUTIVE_SUMMARY_EMPTY: ExecutiveSummaryResult = {
  source_solution_evaluation_present: false,
  executive_summary: "",
  fit_to_customer_needs: "",
  likely_score_assessment: {
    quality: "",
    delivery_confidence: "",
    risk: "",
    competitiveness: "",
  },
  strengths: [],
  weaknesses: [],
};

function mapSolutionEvaluationRow(row: SolutionEvaluationRow) {
  return sanitizeSolutionEvaluationResult({
    ...SOLUTION_EVALUATION_EMPTY,
    ...decryptJson(row.result_json, SOLUTION_EVALUATION_EMPTY),
    customer_document_id: row.customer_document_id,
    solution_document_id: row.solution_document_id,
    evaluated_generated_artifact_id:
      row.evaluated_generated_artifact_id ?? null,
    evaluation_provenance_mode:
      row.evaluation_provenance_mode ?? "legacy_unknown",
  });
}

function mapExecutiveSummaryRow(row: ExecutiveSummaryRow) {
  return decryptJson(row.result_json, EXECUTIVE_SUMMARY_EMPTY);
}

function parseSolutionEvaluationDependency(
  value: unknown,
): ArtifactSourceRevisions["solutionEvaluationDependency"] {
  const dependency =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  if (
    !dependency ||
    typeof dependency.id !== "string" ||
    typeof dependency.updated_at !== "string" ||
    typeof dependency.content_hash !== "string" ||
    !(
      dependency.evaluated_generated_artifact_id === null ||
      typeof dependency.evaluated_generated_artifact_id === "string"
    ) ||
    !(
      dependency.provenance_mode === "document_only" ||
      dependency.provenance_mode === "generated_artifact" ||
      dependency.provenance_mode === "legacy_unknown"
    )
  ) {
    return null;
  }
  return {
    id: dependency.id,
    updated_at: new Date(dependency.updated_at).toISOString(),
    content_hash: dependency.content_hash,
    evaluated_generated_artifact_id:
      dependency.evaluated_generated_artifact_id,
    provenance_mode: dependency.provenance_mode,
  };
}

export function mapCustomerAnalysis(row: CustomerAnalysisRow): CustomerAnalysisResult {
  return { ...decryptJson(row.result_json, CUSTOMER_ANALYSIS_EMPTY), ...(row.revision ? { revision: row.revision } : {}) };
}

export async function getProjectResultHistory(projectId: string, latestAnalysisOnly = false) {
  let query = createServiceClient().from("project_result_history")
    .select("id,kind,result_json,original_updated_at,archived_at,reason")
    .eq("project_id", projectId);
  if (latestAnalysisOnly) query = query.eq("kind", "customer_analyses");
  const { data, error } = await query.order("archived_at", { ascending: false })
    .order("id", { ascending: false }).limit(latestAnalysisOnly ? 1 : 30);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => ({ ...row, result_json: decryptJson(row.result_json, {}) }));
}

export async function saveCustomerAnalysis(
  projectId: string,
  sourceDocumentIds: string[],
  result: CustomerAnalysisResult,
  options: {
    expectedSourceRevision: number;
    expectedAnalysisRevision?: string | null;
    automaticRequestId?: string;
    previousAnalysis?: CustomerAnalysisResult | null;
    updatedSections?: CustomerAnalysisSection[];
    historySource?: CustomerAnalysisHistorySource;
  },
) {
  if (
    !Number.isSafeInteger(options.expectedSourceRevision) ||
    options.expectedSourceRevision < 0
  ) {
    throw new Error("Kundeanalysen mangler en gyldig source_revision.");
  }
  const dataApi = createServiceClient();
  const previousAnalysis =
    "previousAnalysis" in options
      ? (options.previousAnalysis ?? null)
      : await getFreshCustomerAnalysis(projectId);
  const resultWithHistory = appendCustomerAnalysisSectionHistory({
    previousAnalysis,
    nextAnalysis: withoutAnalysisRevision(result),
    sections: options.updatedSections ?? [...CUSTOMER_ANALYSIS_SECTIONS],
    source: options.historySource ?? "full_regeneration",
  });

  const projectKeywords = mergeKeywords(
    keywordsFromText(
      [
        result.customer_profile_summary,
        result.customer_goals_summary,
        result.high_level_solution_design,
        result.executive_summary,
      ].join(" "),
    ),
    result.signal_words ?? [],
  );

  const payload = {
    source_document_ids: sourceDocumentIds,
    expected_source_revision: options.expectedSourceRevision,
    ...(options.expectedAnalysisRevision !== undefined || previousAnalysis?.revision
      ? { expected_analysis_revision: options.expectedAnalysisRevision !== undefined ? options.expectedAnalysisRevision : previousAnalysis?.revision }
      : {}),
    ...(options.automaticRequestId ? { automatic_request_id: options.automaticRequestId } : {}),
    unchanged: analysisContentEqual(previousAnalysis, result),
    result_json: encryptJson(resultWithHistory),
    last_activity_at: new Date().toISOString(),
    context_keywords: projectKeywords,
  };
  const fencedSave =
    await runLeaseFencedCustomerAnalysisMutation<CustomerAnalysisRow>(
      projectId,
      payload,
    );
  if (fencedSave.fenced) {
    revalidateProjectCaches(projectId);
    return mapCustomerAnalysis(fencedSave.data);
  }

  const { data, error } = await dataApi.rpc(
    "save_customer_analysis_if_source_revision",
    {
      p_project_id: projectId,
      p_payload: payload,
    },
  );

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre kundeanalysen.");
  }

  revalidateProjectCaches(projectId);

  return mapCustomerAnalysis(data as CustomerAnalysisRow);
}

export async function getFreshCustomerAnalysis(projectId: string) {
  const dataApi = createServiceClient();
  const { data, error } = await dataApi
    .from("customer_analyses")
    .select("*")
    .eq("project_id", projectId)
    .eq("provenance_verified", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  const row = (data?.[0] as CustomerAnalysisRow | undefined) ?? null;
  return row ? mapCustomerAnalysis(row) : null;
}

export async function getCustomerAnalysis(projectId: string) {
  return unstable_cache(
    () => getFreshCustomerAnalysis(projectId),
    ["project-customer-analysis", projectId],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}

export async function saveSolutionEvaluation(
  projectId: string,
  input: {
    customerDocumentId: string | null;
    solutionDocumentId: string | null;
    sourceDocumentIds?: string[];
    analysisId?: string | null;
    expectedSourceRevision: number;
    evaluatedGeneratedArtifactId?: string | null;
    result: SolutionEvaluationResult;
  },
) {
  if (
    !Number.isSafeInteger(input.expectedSourceRevision) ||
    input.expectedSourceRevision < 0
  ) {
    throw new Error("Løsningsvurderingen mangler en gyldig source_revision.");
  }
  const encryptedResult = encryptJson(
    sanitizeSolutionEvaluationResult(input.result),
  );
  const sourceDocumentIds = [
    ...new Set(
      [
        input.customerDocumentId,
        ...(input.sourceDocumentIds ?? []).filter(
          (documentId) => documentId !== input.solutionDocumentId,
        ),
        input.solutionDocumentId,
      ].filter((documentId): documentId is string => Boolean(documentId)),
    ),
  ];
  const fencedSave =
    await runLeaseFencedSolutionEvaluationMutation<SolutionEvaluationRow>(
      projectId,
      {
        customer_document_id: input.customerDocumentId,
        solution_document_id: input.solutionDocumentId,
        analysis_id: input.analysisId ?? null,
        source_document_ids: sourceDocumentIds,
        expected_source_revision: input.expectedSourceRevision,
        evaluated_generated_artifact_id:
          input.evaluatedGeneratedArtifactId ?? null,
        result_json: encryptedResult,
        last_activity_at: new Date().toISOString(),
      },
    );
  if (!fencedSave.fenced) {
    throw new Error(
      "Løsningsvurderingen må lagres gjennom en aktiv, lease-fenced prosjektjobb.",
    );
  }

  revalidateProjectCaches(projectId);
  return mapSolutionEvaluationRow(fencedSave.data);
}

export async function saveExecutiveSummary(
  projectId: string,
  result: ExecutiveSummaryResult,
  inputSnapshot: unknown,
  solutionEvaluationDependency: NonNullable<
    ArtifactSourceRevisions["solutionEvaluationDependency"]
  >,
) {
  const fencedSave = await runLeaseFencedExecutiveSummaryMutation<ExecutiveSummaryRow>(
    projectId,
    {
      result_json: encryptJson(result),
      input_snapshot: encryptJson(inputSnapshot),
      solution_evaluation_dependency: solutionEvaluationDependency,
      last_activity_at: new Date().toISOString(),
    },
  );
  if (!fencedSave.fenced) {
    throw new Error(
      "Lederoppsummeringen må lagres gjennom en aktiv, evalueringsfencet prosjektjobb.",
    );
  }
  revalidateProjectCaches(projectId);
  return mapExecutiveSummaryRow(fencedSave.data);
}

export async function getFreshExecutiveSummary(projectId: string) {
  return (await getFreshProjectDerivedSnapshot(projectId))?.executiveSummary ?? null;
}

export async function getExecutiveSummary(projectId: string) {
  return unstable_cache(
    () => getFreshExecutiveSummary(projectId),
    ["project-executive-summary", projectId],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}

export async function isSolutionEvaluationCurrent(projectId: string) {
  const dataApi = createServiceClient();
  const { data, error } = await dataApi.rpc(
    "solution_evaluation_is_current",
    { p_project_id: projectId },
  );
  if (error || typeof data !== "boolean") {
    throw new Error(
      error?.message || "Kunne ikke verifisere vurderingens kildegrunnlag.",
    );
  }
  return data;
}

export async function getFreshSolutionEvaluationSnapshot(projectId: string) {
  const snapshot = await getFreshProjectDerivedSnapshot(projectId);
  return snapshot
    ? { evaluation: snapshot.evaluation, dependency: snapshot.dependency }
    : null;
}

export async function getFreshProjectDerivedSnapshot(projectId: string) {
  const dataApi = createServiceClient();
  const { data, error } = await dataApi.rpc(
    "get_current_project_derived_snapshot",
    { p_project_id: projectId },
  );
  if (error) {
    throw new Error(error.message);
  }
  if (data == null) return null;
  if (typeof data !== "object") {
    throw new Error("Databasen returnerte ugyldig vurderingsprovenance.");
  }
  const snapshot = data as Record<string, unknown>;
  if (!snapshot.evaluation_row || typeof snapshot.evaluation_row !== "object") {
    throw new Error("Databasen returnerte en vurdering uten autoritativ rad.");
  }
  const dependency = parseSolutionEvaluationDependency(snapshot.dependency);
  if (!dependency) {
    throw new Error("Databasen returnerte en vurdering uten autoritativ dependency.");
  }
  const row = snapshot.evaluation_row as unknown as SolutionEvaluationRow;
  if (
    row.id !== dependency.id ||
    new Date(row.updated_at).toISOString() !== dependency.updated_at
  ) {
    throw new Error("Vurderingsrad og dependency er ikke fra samme snapshot.");
  }
  return {
    evaluation: mapSolutionEvaluationRow(row),
    dependency,
    executiveSummary:
      snapshot.executive_summary_row &&
      typeof snapshot.executive_summary_row === "object"
        ? mapExecutiveSummaryRow(
            snapshot.executive_summary_row as unknown as ExecutiveSummaryRow,
          )
        : null,
  };
}

export async function getFreshSolutionEvaluation(projectId: string) {
  return (await getFreshSolutionEvaluationSnapshot(projectId))?.evaluation ?? null;
}

export async function getSolutionEvaluation(projectId: string) {
  return unstable_cache(
    () => getFreshSolutionEvaluation(projectId),
    ["project-solution-evaluation", projectId],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}
