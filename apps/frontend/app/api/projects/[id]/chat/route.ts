import { NextResponse } from "next/server";

import {
  CHAT_SESSION_MEMORY_STORAGE_LIMIT,
  inferProjectChatDomains,
  resolveOpenAIModelOverride,
  streamProjectChat,
  type ChatPromptAttachment,
} from "@/lib/server/ai";
import { extractTextFromUpload } from "@/lib/server/documents";
import {
  appendChatMessage,
  listChatSessions,
  listChatMessages,
  updateChatSessionMemory,
  upsertChatSession,
} from "@/lib/server/repositories/chat";
import { getFreshCustomerAnalysis } from "@/lib/server/repositories/analyses";
import { getProjectDetail } from "@/lib/server/repositories/projects";
import { checkRateLimit } from "@/lib/server/observability";
import { listGeneratedArtifacts } from "@/lib/server/repositories/artifacts";
import { listProjectDocumentsForAnalysis } from "@/lib/server/repositories/documents";
import type {
  ChatDomainHint,
  ChatMessage,
  ChatSessionSummary,
} from "@/lib/types";

const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_CHAT_ATTACHMENTS = 1;

class ChatRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function truncateTitle(value: string, limit = 64) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trim()}…`;
}

async function parseChatRequest(request: Request): Promise<{
  message: string;
  sessionId: string | null;
  sessionTitle: string | null;
  attachments: ChatPromptAttachment[];
  attachmentMetadata: Array<{
    title: string;
    file_name: string;
    file_format: string;
    file_size_bytes: number;
    text_length: number;
  }>;
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    if (contentType && !contentType.toLowerCase().includes("application/json")) {
      throw new ChatRequestError("Chatmeldingen må sendes som JSON eller skjemadata.", 415);
    }

    const body = (await request.json().catch(() => ({}))) as {
      message?: string;
      session_id?: string;
      session_title?: string;
    };
    return {
      message: body.message?.trim() ?? "",
      sessionId: body.session_id ?? null,
      sessionTitle: body.session_title ?? null,
      attachments: [],
      attachmentMetadata: [],
    };
  }

  const formData = await request.formData();
  const message = `${formData.get("message") || ""}`.trim();
  const sessionId = `${formData.get("session_id") || ""}`.trim() || null;
  const sessionTitle = `${formData.get("session_title") || ""}`.trim() || null;
  const fileEntries = formData
    .getAll("attachment")
    .filter((entry): entry is File => entry instanceof File);

  if (fileEntries.length > MAX_CHAT_ATTACHMENTS) {
    throw new ChatRequestError("Maks ett chat-vedlegg per melding.", 400);
  }

  const attachments: ChatPromptAttachment[] = [];
  const attachmentMetadata: Array<{
    title: string;
    file_name: string;
    file_format: string;
    file_size_bytes: number;
    text_length: number;
  }> = [];

  for (const file of fileEntries) {
    if (file.size <= 0) {
      throw new ChatRequestError(
        "Vedlegget er tomt. Last opp et dokument med innhold.",
        400,
      );
    }
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new ChatRequestError(
        "Vedlegget er for stort. Maksimal størrelse er 25 MB.",
        413,
      );
    }

    const parsed = await extractTextFromUpload(file, undefined, {
      useDocling: false,
    });
    const rawText = parsed.rawText.trim();
    if (!rawText) {
      throw new ChatRequestError("Vedlegget har ingen lesbar tekst.", 400);
    }

    const title =
      `${formData.get("attachment_title") || ""}`.trim() ||
      parsed.fileName.replace(/\.[^.]+$/, "") ||
      parsed.fileName;
    attachments.push({
      title,
      fileName: parsed.fileName,
      fileFormat: parsed.fileFormat,
      rawText,
    });
    attachmentMetadata.push({
      title,
      file_name: parsed.fileName,
      file_format: parsed.fileFormat,
      file_size_bytes: file.size,
      text_length: rawText.length,
    });
  }

  return {
    message,
    sessionId,
    sessionTitle,
    attachments,
    attachmentMetadata,
  };
}

function sessionIdFromMessage(message: ChatMessage) {
  if (message.session_id?.trim()) {
    return message.session_id.trim();
  }

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

function mergeDomainHints(...groups: Array<ChatDomainHint[] | undefined>) {
  return Array.from(new Set(groups.flatMap((group) => group ?? []))).slice(0, 4);
}

function buildChatSessionsFromMessages(messages: ChatMessage[]): ChatSessionSummary[] {
  const sessionMap = new Map<string, ChatSessionSummary>();

  for (const message of messages) {
    const id = sessionIdFromMessage(message);
    const existing = sessionMap.get(id);
    const preview = truncateTitle(message.content, 120);

    if (!existing) {
      sessionMap.set(id, {
        id,
        title: sessionTitleFromMessage(message),
        summary: "",
        domain_hints: message.domain_hints ?? [],
        pinned: false,
        status: "active",
        message_count: 1,
        created_at: message.created_at,
        updated_at: message.created_at,
        last_message_preview: preview,
      });
      continue;
    }

    existing.message_count += 1;
    existing.domain_hints = mergeDomainHints(
      existing.domain_hints,
      message.domain_hints,
    );
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
    Number(right.pinned) - Number(left.pinned) ||
    right.updated_at.localeCompare(left.updated_at),
  );
}

function mergeChatSessions(
  storedSessions: ChatSessionSummary[],
  messages: ChatMessage[],
) {
  const messageSessions = buildChatSessionsFromMessages(messages);
  const byId = new Map<string, ChatSessionSummary>();

  for (const session of storedSessions) {
    byId.set(session.id, session);
  }

  for (const session of messageSessions) {
    const existing = byId.get(session.id);
    if (!existing) {
      byId.set(session.id, session);
      continue;
    }

    byId.set(session.id, {
      ...existing,
      message_count: Math.max(existing.message_count, session.message_count),
      created_at:
        session.created_at < existing.created_at
          ? session.created_at
          : existing.created_at,
      updated_at:
        session.updated_at > existing.updated_at
          ? session.updated_at
          : existing.updated_at,
      last_message_preview:
        session.updated_at >= existing.updated_at
          ? session.last_message_preview
          : existing.last_message_preview,
      domain_hints: mergeDomainHints(existing.domain_hints, session.domain_hints),
    });
  }

  return [...byId.values()]
    .filter((session) => session.status !== "archived")
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.updated_at.localeCompare(left.updated_at),
    );
}

function trimSessionMemory(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= CHAT_SESSION_MEMORY_STORAGE_LIMIT) {
    return normalized;
  }

  return `Eldre minne er komprimert bort. ${normalized.slice(
    normalized.length - CHAT_SESSION_MEMORY_STORAGE_LIMIT + 32,
  )}`;
}

function buildNextSessionMemory(input: {
  previousSummary: string;
  question: string;
  answer: string;
  domainHints: ChatDomainHint[];
}) {
  const answerSignals =
    input.answer
      .split("\n")
      .map((line) => line.replace(/^[-#*\d.\s]+/, "").trim())
      .filter((line) => line.length > 20)
      .slice(0, 8)
      .join(" ") || input.answer;
  const entry = [
    `Dato: ${new Date().toISOString()}`,
    input.domainHints.length ? `Domener: ${input.domainHints.join(", ")}` : "",
    `Brukerbehov: ${truncateTitle(input.question, 900)}`,
    `Svar/konklusjon: ${truncateTitle(answerSignals, 2600)}`,
  ]
    .filter(Boolean)
    .join("\n");

  return trimSessionMemory(
    [input.previousSummary.trim(), "Nyeste samtalepunkt:", entry]
      .filter(Boolean)
      .join("\n\n"),
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
    const [allMessages, storedSessions] = await Promise.all([
      listChatMessages(id),
      listChatSessions(id),
    ]);
    const sessions = mergeChatSessions(storedSessions, allMessages);
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
    const rateLimit = await checkRateLimit(request, `project-chat:${id}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "For mange chatmeldinger på kort tid." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }

    const model = await resolveOpenAIModelOverride(
      request.headers.get("x-openai-model"),
    );
    const chatRequest = await parseChatRequest(request);
    const message = chatRequest.message;

    if (!message) {
      return NextResponse.json({ error: "Meldingen kan ikke være tom." }, { status: 400 });
    }
    if (message.length > 8000) {
      return NextResponse.json(
        { error: "Meldingen er for lang." },
        { status: 413 },
      );
    }
    const sessionId = normalizeSessionId(chatRequest.sessionId) ?? crypto.randomUUID();
    const sessionTitle = normalizeSessionTitle(chatRequest.sessionTitle, message);

    const [
      project,
      customerAnalysis,
      documents,
      generatedArtifacts,
      chatHistory,
      storedSessions,
    ] = await Promise.all([
      getProjectDetail(id),
      getFreshCustomerAnalysis(id),
      listProjectDocumentsForAnalysis(id),
      listGeneratedArtifacts(id),
      listChatMessages(id),
      listChatSessions(id),
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
    const activeSession =
      storedSessions.find((session) => session.id === sessionId) ?? null;
    const domainHints = inferProjectChatDomains({
      question: message,
      recentMessages: chatHistoryForSession,
      sessionSummary: activeSession?.summary,
    });
    const contextSnapshot = {
      customer_analysis_present: Boolean(customerAnalysis),
      solution_evaluation_present: Boolean(project.solution_evaluation),
      chat_session_id: sessionId,
      chat_session_title: sessionTitle,
      domain_hints: domainHints,
      prompt_attachments: chatRequest.attachmentMetadata,
    };

    await upsertChatSession({
      projectId: id,
      sessionId,
      title: sessionTitle,
      domainHints,
      lastMessagePreview: truncateTitle(message, 120),
      messageCount: chatHistoryForSession.length + 1,
    });

    await appendChatMessage(id, "user", message, contextSnapshot, {
      sessionId,
    });

    const chatStream = await streamProjectChat({
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
      promptAttachments: chatRequest.attachments,
      model,
      sessionSummary: activeSession?.summary,
      domainHints,
    });
    const encoder = new TextEncoder();
    const assistantContextSnapshot = {
      ...contextSnapshot,
      domain_hints: chatStream.domainHints,
      source_references: chatStream.sourceReferences,
      retrieval_plan: chatStream.retrievalPlan,
      retrieval_telemetry: chatStream.retrievalTelemetry,
    };

    return new NextResponse(
      new ReadableStream({
        async start(controller) {
          let assistantMessage = "";

          try {
            for await (const chunk of chatStream.stream) {
              assistantMessage += chunk;
              controller.enqueue(encoder.encode(chunk));
            }

            const cleanedAssistantMessage = assistantMessage.trim();
            if (!cleanedAssistantMessage) {
              throw new Error("AI returnerte tomt svar.");
            }

            await appendChatMessage(
              id,
              "assistant",
              cleanedAssistantMessage,
              assistantContextSnapshot,
              { sessionId },
            );

            await updateChatSessionMemory({
              projectId: id,
              sessionId,
              summary: buildNextSessionMemory({
                previousSummary: activeSession?.summary ?? "",
                question: message,
                answer: cleanedAssistantMessage,
                domainHints: chatStream.domainHints,
              }),
              domainHints: mergeDomainHints(
                activeSession?.domain_hints,
                chatStream.domainHints,
              ),
              lastMessagePreview: truncateTitle(cleanedAssistantMessage, 120),
              messageCount: chatHistoryForSession.length + 2,
            }).catch((memoryError) => {
              console.error("Kunne ikke oppdatere chat-minne.", memoryError);
            });

            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      }),
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Chat-Session-Id": sessionId,
          "X-Chat-Session-Title": encodeURIComponent(sessionTitle),
          "X-Chat-Domains": encodeURIComponent(
            JSON.stringify(chatStream.domainHints),
          ),
          "X-Retrieval-Quality": encodeURIComponent(
            JSON.stringify(chatStream.retrievalTelemetry?.quality ?? null),
          ),
        },
      },
    );
  } catch (error) {
    if (error instanceof ChatRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke sende chatmelding." },
      { status: 500 },
    );
  }
}
