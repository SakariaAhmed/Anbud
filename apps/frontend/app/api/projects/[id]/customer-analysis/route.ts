import { NextResponse } from "next/server";

import { CUSTOMER_ANALYSIS_SECTIONS } from "@/lib/customer-analysis-history";
import {
  analyzeCustomerDocuments,
  regenerateCustomerAnalysisSection,
  resolveOpenAIModelOverride,
} from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getProjectSnapshot,
  listProjectDocuments,
  saveCustomerAnalysis,
} from "@/lib/server/projects-db";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
import type {
  AnalysisRequirement,
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  RequirementImportance,
  ValueOpportunity,
} from "@/lib/types";

export const maxDuration = 60;

const READ_CACHE_HEADERS = {
  "Cache-Control": "private, max-age=30, stale-while-revalidate=300",
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

function applySectionSnapshot(
  analysis: CustomerAnalysisResult,
  section: CustomerAnalysisSection,
  snapshot: unknown,
): CustomerAnalysisResult {
  if (!isRecord(snapshot)) {
    throw new Error("Seksjonsdata må være et gyldig sett med redigerbare felter.");
  }

  switch (section) {
    case "summary": {
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
    case "strategy": {
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
    case "clarifications": {
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
    case "design": {
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
        high_level_architecture_mermaid:
          snapshot.high_level_architecture_mermaid,
      };
    }
    case "risks": {
      const risksForUs = snapshot.risks_for_us;
      const risksForCustomer = snapshot.risks_for_customer;

      if (
        !isStringArray(snapshot.risks) ||
        (typeof risksForUs !== "undefined" && !isStringArray(risksForUs)) ||
        ("risks_for_customer" in snapshot &&
          !isStringArray(risksForCustomer))
      ) {
        throw new Error(
          "Risiko må inneholde tekstlister for risks, risks_for_us og risks_for_customer.",
        );
      }

      const nextRisksForUs = isStringArray(risksForUs) ? risksForUs : [];
      const nextRisksForCustomer = isStringArray(risksForCustomer)
        ? risksForCustomer
        : [];

      return {
        ...analysis,
        risks: snapshot.risks,
        risks_for_us: nextRisksForUs,
        risks_for_customer: nextRisksForCustomer,
      };
    }
    case "needs": {
      if (
        !Array.isArray(snapshot.implicit_requirements) ||
        !snapshot.implicit_requirements.every(isAnalysisRequirement) ||
        !Array.isArray(snapshot.prioritized_requirements) ||
        !snapshot.prioritized_requirements.every(
          (item) =>
            isRecord(item) &&
            typeof item.requirement === "string" &&
            isRequirementImportance(item.priority) &&
            typeof item.reason === "string",
        )
      ) {
        throw new Error(
          "Behov må inneholde gyldige implicit_requirements og prioritized_requirements.",
        );
      }

      return {
        ...analysis,
        implicit_requirements: snapshot.implicit_requirements,
        prioritized_requirements: snapshot.prioritized_requirements,
      };
    }
    case "keywords": {
      if (
        !isStringArray(snapshot.signal_words) ||
        ("signal_word_counts" in snapshot &&
          !isRecord(snapshot.signal_word_counts))
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
        !Object.values(signalWordCounts).every(
          (value) => typeof value === "number",
        )
      ) {
        throw new Error("signal_word_counts må ha tallverdier.");
      }

      return {
        ...analysis,
        signal_words: snapshot.signal_words,
        signal_word_counts: signalWordCounts as
          | Record<string, number>
          | undefined,
      };
    }
    case "value": {
      if (
        !Array.isArray(snapshot.value_opportunities) ||
        !snapshot.value_opportunities.every(isValueOpportunity)
      ) {
        throw new Error(
          "Verdi må inneholde en gyldig value_opportunities-liste.",
        );
      }

      return {
        ...analysis,
        value_opportunities: snapshot.value_opportunities,
      };
    }
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const model = await resolveOpenAIModelOverride(
      request.headers.get("x-openai-model"),
    );
    const body = (await request.json().catch(() => ({}))) as {
      section?: unknown;
    };

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
    const [projectDocuments, existingAnalysis] =
      await Promise.all([
        listProjectDocuments(id),
        section ? getCustomerAnalysis(id) : Promise.resolve(null),
      ]);
    const { projectDocuments: analysisDocuments } =
      splitServiceDescriptionDetails(projectDocuments);
    const [customerDocument, ...supportingDocuments] = analysisDocuments;

    if (!customerDocument) {
      return NextResponse.json(
        { error: "Last opp minst ett dokument først." },
        { status: 400 },
      );
    }

    if (!customerDocument.raw_text.trim()) {
      return NextResponse.json(
        {
          error:
            "Dokumentgrunnlaget har ingen lesbar tekst. Last opp dokumentet på nytt som tekstbasert PDF/DOCX/Excel-fil, eller bruk OCR først.",
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
            model,
          })
        : await analyzeCustomerDocuments({
            projectName: customerDocument.title,
            customerDocument,
            supportingDocuments,
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
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke generere kundeanalyse.",
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
    const analysis = await getCustomerAnalysis(id);

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

    const [existingAnalysis, projectDocuments] =
      await Promise.all([
        getCustomerAnalysis(id),
        listProjectDocuments(id),
      ]);
    const { projectDocuments: analysisDocuments } =
      splitServiceDescriptionDetails(projectDocuments);
    const [customerDocument, ...supportingDocuments] = analysisDocuments;

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
