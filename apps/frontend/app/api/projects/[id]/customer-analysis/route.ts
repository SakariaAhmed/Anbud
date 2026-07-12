import { NextResponse } from "next/server";

import { CUSTOMER_ANALYSIS_SECTIONS } from "@/lib/customer-analysis-history";
import {
  analyzeCustomerDocuments,
  regenerateCustomerAnalysisSection,
} from "@/lib/server/ai";
import {
  getFreshCustomerAnalysis,
  saveCustomerAnalysis,
} from "@/lib/server/repositories/analyses";
import { listProjectDocumentsForAnalysis } from "@/lib/server/repositories/documents";
import {
  getProjectSnapshot,
  getProjectSourceRevision,
} from "@/lib/server/repositories/projects";
import { listProjectServiceDescriptions } from "@/lib/server/repositories/services";
import { selectProjectDocuments } from "@/lib/server/domain/project-documents";
import { prepareProjectAiJsonRoute } from "@/lib/server/project-ai-route";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";
import { assertCustomerAnalysisRequirementSourcesReady } from "@/lib/server/use-cases/solution-evaluation-readiness";
import {
  readStableProjectSourceSnapshot,
  readStableSolutionEvaluationSourceSnapshot,
} from "@/lib/server/use-cases/solution-evaluation-source-snapshot";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
import type {
  AnalysisRequirement,
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  RecommendedService,
  RequirementImportance,
  ValueOpportunity,
} from "@/lib/types";

export const maxDuration = 60;

const READ_CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
};

function isCustomerAnalysisSection(
  value: unknown,
): value is CustomerAnalysisSection {
  return CUSTOMER_ANALYSIS_SECTIONS.includes(value as CustomerAnalysisSection);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRequirementImportance(
  value: unknown,
): value is RequirementImportance {
  return value === "Kritisk" || value === "Viktig" || value === "Mindre viktig";
}

function isAnalysisRequirement(value: unknown): value is AnalysisRequirement {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    typeof value.category === "string" &&
    isRequirementImportance(value.importance) &&
    (value.kind === "Eksplisitt" || value.kind === "Implisitt") &&
    typeof value.source_reference === "string" &&
    typeof value.source_excerpt === "string"
  );
}

function isValueOpportunity(value: unknown): value is ValueOpportunity {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.value_categories) &&
    value.value_categories.every((item) => typeof item === "string") &&
    typeof value.profit_share_percent === "number"
  );
}

function isRecommendedService(value: unknown): value is RecommendedService {
  return (
    isRecord(value) &&
    (typeof value.service_id === "undefined" ||
      value.service_id === null ||
      typeof value.service_id === "string") &&
    typeof value.service_name === "string" &&
    typeof value.usefulness_percent === "number" &&
    typeof value.customer_need === "string" &&
    typeof value.recommendation_reason === "string" &&
    typeof value.evidence === "string" &&
    typeof value.risk_or_caveat === "string"
  );
}

type CustomerAnalysisSectionSnapshot = Record<string, unknown>;

type CustomerAnalysisSectionApplier = (
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
) => CustomerAnalysisResult;

function applySummarySnapshot(
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
): CustomerAnalysisResult {
  if (
    typeof snapshot.customer_profile_summary !== "string" ||
    typeof snapshot.customer_goals_summary !== "string"
  ) {
    throw new Error(
      "Oppsummering må inneholde tekstfeltene customer_profile_summary og customer_goals_summary.",
    );
  }

  return {
    ...analysis,
    customer_profile_summary: snapshot.customer_profile_summary,
    customer_goals_summary: snapshot.customer_goals_summary,
  };
}

function applyStrategySnapshot(
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
): CustomerAnalysisResult {
  if (
    typeof snapshot.executive_summary !== "string" ||
    !isStringArray(snapshot.positioning_recommendations)
  ) {
    throw new Error(
      "Strategi må inneholde executive_summary og positioning_recommendations.",
    );
  }

  return {
    ...analysis,
    executive_summary: snapshot.executive_summary,
    positioning_recommendations: snapshot.positioning_recommendations,
  };
}

function applyClarificationsSnapshot(
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
): CustomerAnalysisResult {
  if (
    !isStringArray(snapshot.ambiguities) ||
    !isStringArray(snapshot.expected_solution_direction) ||
    !isStringArray(snapshot.likely_evaluation_criteria)
  ) {
    throw new Error(
      "Avklaringer må inneholde tekstlistene ambiguities, expected_solution_direction og likely_evaluation_criteria.",
    );
  }

  return {
    ...analysis,
    ambiguities: snapshot.ambiguities,
    expected_solution_direction: snapshot.expected_solution_direction,
    likely_evaluation_criteria: snapshot.likely_evaluation_criteria,
  };
}

function applyDesignSnapshot(
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
): CustomerAnalysisResult {
  if (
    typeof snapshot.high_level_solution_design !== "string" ||
    typeof snapshot.high_level_architecture_mermaid !== "string"
  ) {
    throw new Error(
      "Design må inneholde high_level_solution_design og high_level_architecture_mermaid.",
    );
  }

  return {
    ...analysis,
    high_level_solution_design: snapshot.high_level_solution_design,
    high_level_architecture_mermaid: snapshot.high_level_architecture_mermaid,
  };
}

function applyRisksSnapshot(
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
): CustomerAnalysisResult {
  const risksForUs = snapshot.risks_for_us;
  const risksForCustomer = snapshot.risks_for_customer;

  if (
    !isStringArray(snapshot.risks) ||
    (typeof risksForUs !== "undefined" && !isStringArray(risksForUs)) ||
    ("risks_for_customer" in snapshot && !isStringArray(risksForCustomer))
  ) {
    throw new Error(
      "Risiko må inneholde tekstlister for risks, risks_for_us og risks_for_customer.",
    );
  }

  return {
    ...analysis,
    risks: snapshot.risks,
    risks_for_us: isStringArray(risksForUs) ? risksForUs : [],
    risks_for_customer: isStringArray(risksForCustomer)
      ? risksForCustomer
      : [],
  };
}

function isPrioritizedRequirement(value: unknown): value is {
  requirement: string;
  priority: RequirementImportance;
  reason: string;
} {
  return (
    isRecord(value) &&
    typeof value.requirement === "string" &&
    isRequirementImportance(value.priority) &&
    typeof value.reason === "string"
  );
}

function applyNeedsSnapshot(
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
): CustomerAnalysisResult {
  const implicitRequirements = snapshot.implicit_requirements;
  const prioritizedRequirements = snapshot.prioritized_requirements;

  if (
    !Array.isArray(implicitRequirements) ||
    !implicitRequirements.every(isAnalysisRequirement) ||
    !Array.isArray(prioritizedRequirements) ||
    !prioritizedRequirements.every(isPrioritizedRequirement)
  ) {
    throw new Error(
      "Behov må inneholde gyldige implicit_requirements og prioritized_requirements.",
    );
  }

  return {
    ...analysis,
    implicit_requirements: implicitRequirements,
    prioritized_requirements: prioritizedRequirements,
  };
}

function applyKeywordsSnapshot(
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
): CustomerAnalysisResult {
  if (
    !isStringArray(snapshot.signal_words) ||
    ("signal_word_counts" in snapshot && !isRecord(snapshot.signal_word_counts))
  ) {
    throw new Error(
      "Nøkkelord må inneholde signal_words og eventuelt signal_word_counts.",
    );
  }

  const signalWordCounts = isRecord(snapshot.signal_word_counts)
    ? snapshot.signal_word_counts
    : undefined;
  if (
    typeof signalWordCounts !== "undefined" &&
    !Object.values(signalWordCounts).every((value) => typeof value === "number")
  ) {
    throw new Error("signal_word_counts må ha tallverdier.");
  }

  return {
    ...analysis,
    signal_words: snapshot.signal_words,
    signal_word_counts: signalWordCounts as Record<string, number> | undefined,
  };
}

function applyServicesSnapshot(
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
): CustomerAnalysisResult {
  const recommendedServices = snapshot.recommended_services;

  if (
    !Array.isArray(recommendedServices) ||
    !recommendedServices.every(isRecommendedService)
  ) {
    throw new Error(
      "Anbefalte tjenester må inneholde en gyldig recommended_services-liste.",
    );
  }

  return {
    ...analysis,
    recommended_services: recommendedServices,
  };
}

function applyValueSnapshot(
  analysis: CustomerAnalysisResult,
  snapshot: CustomerAnalysisSectionSnapshot,
): CustomerAnalysisResult {
  const valueOpportunities = snapshot.value_opportunities;

  if (
    !Array.isArray(valueOpportunities) ||
    !valueOpportunities.every(isValueOpportunity)
  ) {
    throw new Error(
      "Verdi må inneholde en gyldig value_opportunities-liste.",
    );
  }

  return {
    ...analysis,
    value_opportunities: valueOpportunities,
  };
}

const SECTION_SNAPSHOT_APPLIERS: Record<
  CustomerAnalysisSection,
  CustomerAnalysisSectionApplier
> = {
  summary: applySummarySnapshot,
  strategy: applyStrategySnapshot,
  clarifications: applyClarificationsSnapshot,
  design: applyDesignSnapshot,
  risks: applyRisksSnapshot,
  needs: applyNeedsSnapshot,
  keywords: applyKeywordsSnapshot,
  services: applyServicesSnapshot,
  value: applyValueSnapshot,
};

function applySectionSnapshot(
  analysis: CustomerAnalysisResult,
  section: CustomerAnalysisSection,
  snapshot: unknown,
): CustomerAnalysisResult {
  if (!isRecord(snapshot)) {
    throw new Error("Seksjonsdata må være et gyldig sett med redigerbare felter.");
  }

  return SECTION_SNAPSHOT_APPLIERS[section](analysis, snapshot);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const preflight = await prepareProjectAiJsonRoute<{ section?: unknown }>(
      request,
      context,
      {
        scopePrefix: "customer-analysis",
        message: "For mange analyser på kort tid.",
        limit: 8,
        windowMs: 5 * 60_000,
        fallbackBody: {},
      },
    );
    if (preflight.response) {
      return preflight.response;
    }

    const { id, model, body } = preflight;

    if (
      typeof body.section !== "undefined" &&
      !isCustomerAnalysisSection(body.section)
    ) {
      return NextResponse.json(
        { error: "Ugyldig analyseseksjon." },
        { status: 400 },
      );
    }

    const section = isCustomerAnalysisSection(body.section)
      ? body.section
      : null;
    const sourceSnapshot = await readStableProjectSourceSnapshot({
      readSourceRevision: () => getProjectSourceRevision(id),
      readValue: async () => {
        const [projectDocuments, existingAnalysis, serviceCandidates] =
          await Promise.all([
            listProjectDocumentsForAnalysis(id),
            section ? getFreshCustomerAnalysis(id) : Promise.resolve(null),
            listProjectServiceDescriptions(id),
          ]);
        return { projectDocuments, existingAnalysis, serviceCandidates };
      },
    });
    const { projectDocuments, existingAnalysis, serviceCandidates } =
      sourceSnapshot.value;
    const { projectDocuments: analysisDocuments } =
      splitServiceDescriptionDetails(projectDocuments);
    const { customerDocument, supportingDocuments } =
      selectProjectDocuments(analysisDocuments);

    if (!customerDocument) {
      return NextResponse.json(
        { error: "Last opp minst ett dokument først." },
        { status: 400 },
      );
    }

    try {
      assertCustomerAnalysisRequirementSourcesReady([
        customerDocument,
        ...supportingDocuments,
      ]);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Dokumentgrunnlaget er ikke klart for kundeanalyse.",
        },
        { status: 400 },
      );
    }

    if (section && !existingAnalysis) {
      return NextResponse.json(
        { error: "Generer kundeanalyse før du redigerer en seksjon." },
        { status: 400 },
      );
    }

    const result =
      section && existingAnalysis
        ? await regenerateCustomerAnalysisSection({
            section,
            projectName: customerDocument.title,
            customerDocument,
            supportingDocuments,
            customerAnalysis: existingAnalysis,
            serviceCandidates,
            model,
          })
        : await analyzeCustomerDocuments({
            projectName: customerDocument.title,
            customerDocument,
            supportingDocuments,
            serviceCandidates,
            model,
          });

    const saved = await saveCustomerAnalysis(
      id,
      [
        customerDocument.id,
        ...supportingDocuments.map((document) => document.id),
      ],
      result,
      {
        expectedSourceRevision: sourceSnapshot.sourceRevision,
        previousAnalysis: existingAnalysis,
        updatedSections: section ? [section] : [...CUSTOMER_ANALYSIS_SECTIONS],
        historySource: section
          ? "section_regeneration"
          : "full_regeneration",
      },
    );

    const project = await getProjectSnapshot(id);
    return NextResponse.json({ analysis: saved, project });
  } catch (error) {
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(
          error,
          "Kunne ikke generere kundeanalyse.",
        ),
      },
      { status: 500 },
    );
  }
}

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const analysis = await getFreshCustomerAnalysis(id);

    return NextResponse.json({ analysis }, { headers: READ_CACHE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke hente kundeanalysen.",
      },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      analysis_text?: string;
      section?: unknown;
      section_snapshot?: unknown;
    };

    const section = isCustomerAnalysisSection(body.section)
      ? body.section
      : null;
    const analysisText =
      !section && typeof body.analysis_text === "string"
        ? body.analysis_text.trim()
        : "";

    if (typeof body.section !== "undefined" && !section) {
      return NextResponse.json(
        { error: "Ugyldig analyseseksjon." },
        { status: 400 },
      );
    }

    if (!section && !analysisText) {
      return NextResponse.json(
        { error: "Analysefeltet kan ikke være tomt." },
        { status: 400 },
      );
    }

    const sourceSnapshot = await readStableSolutionEvaluationSourceSnapshot({
      readSourceRevision: () => getProjectSourceRevision(id),
      readDocuments: () => listProjectDocumentsForAnalysis(id),
      readCustomerAnalysis: () => getFreshCustomerAnalysis(id),
    });
    const existingAnalysis = sourceSnapshot.customerAnalysis;
    const projectDocuments = sourceSnapshot.documents;
    const { projectDocuments: analysisDocuments } =
      splitServiceDescriptionDetails(projectDocuments);
    const { customerDocument, supportingDocuments } =
      selectProjectDocuments(analysisDocuments);

    if (!existingAnalysis) {
      return NextResponse.json(
        { error: "Generer kundeanalyse før du lagrer manuelle endringer." },
        { status: 400 },
      );
    }

    if (!customerDocument) {
      return NextResponse.json(
        { error: "Dokumentgrunnlaget mangler." },
        { status: 400 },
      );
    }

    const nextAnalysis = section
      ? applySectionSnapshot(existingAnalysis, section, body.section_snapshot)
      : {
          ...existingAnalysis,
          executive_summary: analysisText,
        };

    const saved = await saveCustomerAnalysis(
      id,
      [
        customerDocument.id,
        ...supportingDocuments.map((document) => document.id),
      ],
      nextAnalysis,
      {
        expectedSourceRevision: sourceSnapshot.sourceRevision,
        previousAnalysis: existingAnalysis,
        updatedSections: [section ?? "strategy"],
        historySource: "manual_edit",
      },
    );

    const project = await getProjectSnapshot(id);
    return NextResponse.json({ analysis: saved, project });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Kunne ikke lagre analysen.",
      },
      { status: 500 },
    );
  }
}
