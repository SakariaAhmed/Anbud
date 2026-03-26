import { NextResponse } from "next/server";

import { analyzeCustomerDocuments } from "@/lib/server/ai";
import { getPrimaryDocument, getProjectSnapshot, listSupportingDocuments, saveCustomerAnalysis } from "@/lib/server/projects-db";

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
