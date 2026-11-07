import { requireProjectPermission } from "@/lib/server/authorization";
import { randomUUID } from "node:crypto";
import { recordWorkflowPerformance } from "@/lib/server/workflow-performance";
import { NextResponse } from "next/server";

import { CHAT_SESSION_MEMORY_STORAGE_LIMIT, inferProjectChatDomains, streamProjectChat, type ChatPromptAttachment } from "@/lib/server/ai/project-chat";
import { resolveOpenAIModelOverride } from "@/lib/server/ai/model-config";
import { selectProjectDocuments } from "@/lib/server/domain/project-documents";
import { extractTextFromUpload } from "@/lib/server/documents";
import {
  parseBoundedMultipartFormData,
} from "@/lib/server/multipart";
import {
  appendChatMessage,
  listChatSessions,
  listChatMessagePage,
  decodeChatMessageCursor,
  InvalidChatMessageCursorError,
  listChatMessages,
  updateChatSessionMemory,
  upsertChatSession,
} from "@/lib/server/repositories/chat";
import { getFreshCustomerAnalysis } from "@/lib/server/repositories/analyses";
import { getProjectGenerationContext } from "@/lib/server/repositories/data-store";
import { checkRateLimit } from "@/lib/server/observability";
import { listCurrentGeneratedArtifactsFresh } from "@/lib/server/repositories/artifacts";
import { listProjectDocumentsForAnalysis } from "@/lib/server/repositories/data-store";
import {
  productionSafeErrorMessage,
  safeErrorTelemetry,
} from "@/lib/server/safe-errors";
import type {
  ChatDomainHint,
} from "@/lib/types";
import { routeErrorResponse } from "@/lib/server/api-responses";
import { optionalTextField, readJsonObject } from "@/lib/server/request-body";

const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_CHAT_MULTIPART_BYTES = MAX_CHAT_ATTACHMENT_BYTES + 1024 * 1024;
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

    const body = await readJsonObject(request);
    return {
      message: optionalTextField(body, "message") ?? "",
      sessionId: optionalTextField(body, "session_id"),
      sessionTitle: optionalTextField(body, "session_title"),
      attachments: [],
      attachmentMetadata: [],
    };
  }

  const formData = await parseBoundedMultipartFormData(request, {
    maxBodyBytes: MAX_CHAT_MULTIPART_BYTES,
    maxFileBytes: MAX_CHAT_ATTACHMENT_BYTES,
    maxFiles: MAX_CHAT_ATTACHMENTS,
  });
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
    await requireProjectPermission(id, "chat.read");
    const params = new URL(request.url).searchParams;
    const requestedSessionId = params.get("session_id");
    const before = decodeChatMessageCursor(params.get("before"));
    const sessions = (await listChatSessions(id)).filter(session => session.status !== "archived");
    const activeSessionId = normalizeSessionId(requestedSessionId) ?? sessions[0]?.id ?? null;
    const page = activeSessionId ? await listChatMessagePage(id, activeSessionId, before) : { messages: [], nextCursor: null };
    return NextResponse.json({
      messages: page.messages,
      sessions,
      active_session_id: activeSessionId,
      next_cursor: page.nextCursor,
    });
  } catch (error) {
    if (error instanceof InvalidChatMessageCursorError) return NextResponse.json({ error: error.message }, { status: 400 });
    return routeErrorResponse(error, "Kunne ikke hente chatten.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  let trace: { projectId: string; traceId: string } | null = null;
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "chat.write");
    const traceId = randomUUID();
    trace = { projectId: id, traceId };
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
      storedSessions,
    ] = await Promise.all([
      getProjectGenerationContext(id),
      getFreshCustomerAnalysis(id),
      listProjectDocumentsForAnalysis(id),
      listCurrentGeneratedArtifactsFresh(id),
      listChatSessions(id),
    ]);
    const { customerDocument, solutionDocument, supportingDocuments } = selectProjectDocuments(documents);

    const chatHistoryForSession = await listChatMessages(id, sessionId);
    const activeSession =
      storedSessions.find((session) => session.id === sessionId) ?? null;
    const domainHints = inferProjectChatDomains({
      question: message,
      recentMessages: chatHistoryForSession,
      sessionSummary: activeSession?.summary,
    });
    const contextSnapshot = {
      customer_analysis_present: Boolean(customerAnalysis),
      solution_evaluation_present: Boolean(project.solutionEvaluationSnapshot),
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
    });

    await appendChatMessage(id, "user", message, contextSnapshot, {
      sessionId,
    });

    const chatStream = await streamProjectChat({
      traceId,
      signal: request.signal,
      projectId: id,
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solutionEvaluationSnapshot?.evaluation ?? null,
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
    recordWorkflowPerformance({ traceId, projectId: id, sourceRevision: project.snapshot_revision, operation: "chat", phase: "context_assembly", durationMs: Date.now() - startedAt });
    const assistantContextSnapshot = {
      ...contextSnapshot,
      domain_hints: chatStream.domainHints,
      retrieval_plan: chatStream.retrievalPlan,
      retrieval_telemetry: chatStream.retrievalTelemetry,
    };

    const responseHeaders = new Headers({
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Workflow-Trace-Id": traceId,
          "X-Chat-Session-Id": sessionId,
          "X-Chat-Session-Title": encodeURIComponent(sessionTitle),
          "X-Chat-Domains": encodeURIComponent(
            JSON.stringify(chatStream.domainHints),
          ),
          "X-Retrieval-Quality": encodeURIComponent(
            JSON.stringify(chatStream.retrievalTelemetry?.quality ?? null),
          ),
    });

    return new NextResponse(
      new ReadableStream({
        async start(controller) {
          let assistantMessage = "";
          let pendingWhitespace = "";
          let firstToken = true;

          try {
            for await (const chunk of chatStream.stream) {
              // Persisted chat trims the answer's outer whitespace. Hold only
              // the trailing whitespace until another visible chunk arrives,
              // so the client receives exactly the transcript we save.
              const pending = pendingWhitespace + (assistantMessage ? chunk : chunk.trimStart());
              const visible = pending.trimEnd();
              pendingWhitespace = pending.slice(visible.length);
              if (!visible) continue;
              if (firstToken) {
                firstToken = false;
                recordWorkflowPerformance({ traceId, projectId: id, operation: "chat", phase: "first_token", durationMs: Date.now() - startedAt });
              }
              assistantMessage += visible;
              controller.enqueue(encoder.encode(visible));
            }

            const cleanedAssistantMessage = assistantMessage.trim();
            if (!cleanedAssistantMessage) {
              throw new Error("AI returnerte tomt svar.");
            }
            const validationStartedAt = Date.now();
            const verifiedSources = chatStream.validateAnswer(cleanedAssistantMessage);
            recordWorkflowPerformance({ traceId, projectId: id, operation: "chat", phase: "validation", durationMs: Date.now() - validationStartedAt });
            const persistenceStartedAt = Date.now();
            request.signal.throwIfAborted();

            await appendChatMessage(
              id,
              "assistant",
              cleanedAssistantMessage,
              { ...assistantContextSnapshot, source_references: verifiedSources, source_check_status: chatStream.sourceValidationFailed ? "needs_clarification" : "passed" },
              { sessionId },
            );
            recordWorkflowPerformance({ traceId, projectId: id, operation: "chat", phase: "persistence", durationMs: Date.now() - persistenceStartedAt });
            recordWorkflowPerformance({ traceId, projectId: id, operation: "chat", phase: "total", durationMs: Date.now() - startedAt, status: chatStream.sourceValidationFailed ? "failed" : "completed" });

            await updateChatSessionMemory({
              projectId: id,
              sessionId,
              appendSummary: (previousSummary) => buildNextSessionMemory({
                previousSummary,
                question: message,
                answer: cleanedAssistantMessage,
                domainHints: chatStream.domainHints,
              }),
              domainHints: chatStream.domainHints,
            }).catch((memoryError) => {
              console.warn(JSON.stringify({ event: "project_chat_memory_update_failed", session_id: sessionId, ...safeErrorTelemetry(memoryError) }));
            });

            controller.close();
          } catch (error) {
            recordWorkflowPerformance({ traceId, projectId: id, operation: "chat", phase: "total", durationMs: Date.now() - startedAt, status: "failed" });
            console.warn(
              JSON.stringify({
                event: "project_chat_stream_failed",
                session_id: sessionId,
                ...safeErrorTelemetry(error),
              }),
            );
            controller.error(
              new Error(
                productionSafeErrorMessage(
                  error,
                  "Chatstrømmen feilet. Kontakt support med feilreferansen.",
                ),
              ),
            );
          }
        },
      }),
      {
        headers: responseHeaders,
      },
    );
  } catch (error) {
    if (trace) recordWorkflowPerformance({ ...trace, operation: "chat", phase: "total", durationMs: Date.now() - startedAt, status: "failed" });
    if (error instanceof ChatRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return routeErrorResponse(error, "Kunne ikke sende chatmelding.");
  }
}
