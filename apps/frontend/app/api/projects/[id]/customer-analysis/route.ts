import { NextResponse } from "next/server";

import {
  analyzeCustomerDocuments,
  regenerateCustomerAnalysisSection,
} from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getPrimaryDocument,
  getProjectSnapshot,
  listSupportingDocuments,
  saveCustomerAnalysis,
} from "@/lib/server/projects-db";
import type { CustomerAnalysisSection } from "@/lib/types";

function isCustomerAnalysisSection(
  value: unknown,
): value is CustomerAnalysisSection {
  return (
    value === "summary" ||
    value === "strategy" ||
    value === "design" ||
    value === "risks" ||
    value === "needs" ||
    value === "keywords" ||
    value === "value"
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
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
    const [customerDocument, supportingDocuments, existingAnalysis] =
      await Promise.all([
        getPrimaryDocument(id, "primary_customer_document"),
        listSupportingDocuments(id),
        section ? getCustomerAnalysis(id) : Promise.resolve(null),
      ]);

    if (!customerDocument) {
      return NextResponse.json(
        { error: "Last opp et primært kundedokument først." },
        { status: 400 },
      );
    }

    if (section && !existingAnalysis) {
      return NextResponse.json(
        { error: "Generer kundeanalyse før du regenererer en seksjon." },
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
          })
        : await analyzeCustomerDocuments({
            projectName: customerDocument.title,
            customerDocument,
            supportingDocuments,
          });

    const saved = await saveCustomerAnalysis(
      id,
      [
        customerDocument.id,
        ...supportingDocuments.map((document) => document.id),
      ],
      result,
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

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      analysis_text?: string;
    };

    const analysisText =
      typeof body.analysis_text === "string" ? body.analysis_text.trim() : "";

    if (!analysisText) {
      return NextResponse.json(
        { error: "Analysefeltet kan ikke være tomt." },
        { status: 400 },
      );
    }

    const [existingAnalysis, customerDocument, supportingDocuments] =
      await Promise.all([
        getCustomerAnalysis(id),
        getPrimaryDocument(id, "primary_customer_document"),
        listSupportingDocuments(id),
      ]);

    if (!existingAnalysis) {
      return NextResponse.json(
        { error: "Generer kundeanalyse før du lagrer manuelle endringer." },
        { status: 400 },
      );
    }

    if (!customerDocument) {
      return NextResponse.json(
        { error: "Primært kundedokument mangler." },
        { status: 400 },
      );
    }

    const saved = await saveCustomerAnalysis(
      id,
      [
        customerDocument.id,
        ...supportingDocuments.map((document) => document.id),
      ],
      {
        ...existingAnalysis,
        executive_summary: analysisText,
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
