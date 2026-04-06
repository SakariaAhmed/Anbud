import { NextResponse } from "next/server";

import { analyzeCustomerDocuments } from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getPrimaryDocument,
  getProjectSnapshot,
  listSupportingDocuments,
  saveCustomerAnalysis,
} from "@/lib/server/projects-db";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const [customerDocument, supportingDocuments] = await Promise.all([
      getPrimaryDocument(id, "primary_customer_document"),
      listSupportingDocuments(id),
    ]);

    if (!customerDocument) {
      return NextResponse.json({ error: "Last opp et primært kundedokument først." }, { status: 400 });
    }

    const result = await analyzeCustomerDocuments({
      projectName: customerDocument.title,
      customerDocument,
      supportingDocuments,
    });

    const saved = await saveCustomerAnalysis(
      id,
      [customerDocument.id, ...supportingDocuments.map((document) => document.id)],
      result,
    );

    const project = await getProjectSnapshot(id);
    return NextResponse.json({ analysis: saved, project });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke generere kundeanalyse." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
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

    const [existingAnalysis, customerDocument, supportingDocuments] = await Promise.all([
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
      [customerDocument.id, ...supportingDocuments.map((document) => document.id)],
      {
        ...existingAnalysis,
        executive_summary: analysisText,
      },
    );

    const project = await getProjectSnapshot(id);
    return NextResponse.json({ analysis: saved, project });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke lagre analysen." },
      { status: 500 },
    );
  }
}
