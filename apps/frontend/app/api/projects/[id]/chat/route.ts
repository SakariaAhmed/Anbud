import { NextResponse } from "next/server";

import { answerProjectChat } from "@/lib/server/ai";
import {
  appendChatMessage,
  getCustomerAnalysis,
  getProjectDetail,
  listChatMessages,
  listProjectDocuments,
} from "@/lib/server/projects-db";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const messages = await listChatMessages(id);
    return NextResponse.json({ messages });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke hente chatten." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { message?: string };
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "Meldingen kan ikke være tom." }, { status: 400 });
    }

    const [project, customerAnalysis, documents] = await Promise.all([
      getProjectDetail(id),
      getCustomerAnalysis(id),
      listProjectDocuments(id),
    ]);
    const customerDocument = documents[0] ?? null;
    const solutionDocument = documents[1] ?? null;

    await appendChatMessage(id, "user", message, {
      customer_analysis_present: Boolean(customerAnalysis),
      solution_evaluation_present: Boolean(project.solution_evaluation),
    });

    const assistantMessage = await answerProjectChat({
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      recentMessages: project.chat_messages.concat([
        {
          id: "pending-user",
          project_id: id,
          role: "user",
          content: message,
          context_snapshot: {},
          created_at: new Date().toISOString(),
        },
      ]),
      customerDocument,
      solutionDocument,
      question: message,
    });

    await appendChatMessage(id, "assistant", assistantMessage, {
      customer_analysis_present: Boolean(customerAnalysis),
      solution_evaluation_present: Boolean(project.solution_evaluation),
    });

    const encoder = new TextEncoder();
    const chunks = assistantMessage.match(/.{1,160}(\s|$)/g) ?? [assistantMessage];

    return new NextResponse(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      }),
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke sende chatmelding." },
      { status: 500 },
    );
  }
}
