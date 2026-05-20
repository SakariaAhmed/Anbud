import { NextResponse } from "next/server";

import { answerProjectChat, resolveOpenAIModelOverride } from "@/lib/server/ai";
import {
  appendChatMessage,
  getCustomerAnalysis,
  getProjectDetail,
  listGeneratedArtifacts,
  listChatMessages,
  listProjectDocuments,
} from "@/lib/server/projects-db";
import type { ChatMessage, ChatSessionSummary } from "@/lib/types";

function truncateTitle(value: string, limit = 64) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trim()}…`;
}

function sessionIdFromMessage(message: ChatMessage) {
  const snapshot = message.context_snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return "legacy";
  }

  const value = (snapshot as { chat_session_id?: unknown }).chat_session_id;
  return typeof value === "string" && value.trim() ? value.trim() : "legacy";
}

function sessionTitleFromMessage(message: ChatMessage) {
  const snapshot = message.context_snapshot;
  if (snapshot && typeof snapshot === "object") {
    const value = (snapshot as { chat_session_title?: unknown })
      .chat_session_title;
    if (typeof value === "string" && value.trim()) {
      return truncateTitle(value, 72);
    }
  }

  if (message.role === "user" && message.content.trim()) {
    return truncateTitle(message.content, 72);
  }

  return "Tidligere samtale";
}

function buildChatSessions(messages: ChatMessage[]): ChatSessionSummary[] {
  const sessionMap = new Map<string, ChatSessionSummary>();

  for (const message of messages) {
    const id = sessionIdFromMessage(message);
    const existing = sessionMap.get(id);
    const preview = truncateTitle(message.content, 120);

    if (!existing) {
      sessionMap.set(id, {
        id,
        title: sessionTitleFromMessage(message),
        message_count: 1,
        created_at: message.created_at,
        updated_at: message.created_at,
        last_message_preview: preview,
      });
      continue;
    }

    existing.message_count += 1;
    if (message.role === "user" && existing.title === "Tidligere samtale") {
      existing.title = sessionTitleFromMessage(message);
    }
    if (message.created_at < existing.created_at) {
      existing.created_at = message.created_at;
    }
    if (message.created_at >= existing.updated_at) {
      existing.updated_at = message.created_at;
      existing.last_message_preview = preview;
    }
  }

  return [...sessionMap.values()].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  );
}

function normalizeSessionId(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\s<>"'`]/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function normalizeSessionTitle(value: unknown, fallback: string) {
  return truncateTitle(
    typeof value === "string" && value.trim() ? value : fallback,
    72,
  );
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const requestedSessionId = new URL(request.url).searchParams.get("session_id");
    const allMessages = await listChatMessages(id);
    const sessions = buildChatSessions(allMessages);
    const activeSessionId =
      normalizeSessionId(requestedSessionId) ?? sessions[0]?.id ?? null;
    const messages = activeSessionId
      ? allMessages.filter((message) => sessionIdFromMessage(message) === activeSessionId)
      : [];

    return NextResponse.json({
      messages,
      sessions,
      active_session_id: activeSessionId,
    });
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
    const model = await resolveOpenAIModelOverride(
      request.headers.get("x-openai-model"),
    );
    const body = (await request.json()) as {
      message?: string;
      session_id?: string;
      session_title?: string;
    };
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "Meldingen kan ikke være tom." }, { status: 400 });
    }
    const sessionId = normalizeSessionId(body.session_id) ?? crypto.randomUUID();
    const sessionTitle = normalizeSessionTitle(body.session_title, message);

    const [
      project,
      customerAnalysis,
      documents,
      generatedArtifacts,
      chatHistory,
    ] = await Promise.all([
      getProjectDetail(id),
      getCustomerAnalysis(id),
      listProjectDocuments(id),
      listGeneratedArtifacts(id),
      listChatMessages(id),
    ]);
    const customerDocument =
      documents.find((document) => document.role === "primary_customer_document") ??
      documents[0] ??
      null;
    const solutionDocument =
      documents.find((document) => document.role === "primary_solution_document") ??
      null;
    const supportingDocuments = documents.filter(
      (document) => document.role === "supporting_document",
    );

    const chatHistoryForSession = chatHistory.filter(
      (chatMessage) => sessionIdFromMessage(chatMessage) === sessionId,
    );
    const contextSnapshot = {
      customer_analysis_present: Boolean(customerAnalysis),
      solution_evaluation_present: Boolean(project.solution_evaluation),
      chat_session_id: sessionId,
      chat_session_title: sessionTitle,
    };

    await appendChatMessage(id, "user", message, contextSnapshot);

    const assistantMessage = await answerProjectChat({
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      generatedArtifacts,
      recentMessages: chatHistoryForSession.concat([
        {
          id: "pending-user",
          project_id: id,
          role: "user",
          content: message,
          context_snapshot: contextSnapshot,
          created_at: new Date().toISOString(),
        },
      ]),
      customerDocument,
      solutionDocument,
      supportingDocuments,
      question: message,
      model,
    });

    await appendChatMessage(id, "assistant", assistantMessage, contextSnapshot);

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
          "X-Chat-Session-Id": sessionId,
          "X-Chat-Session-Title": encodeURIComponent(sessionTitle),
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
