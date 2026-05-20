"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderOpen,
  History,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { ProjectChatTab } from "@/components/projects/project-chat-tab";
import { cn } from "@/lib/utils";
import type {
  ChatMessage,
  ChatSessionSummary,
  ProjectSummary,
} from "@/lib/types";

type ChatPayload = {
  messages?: ChatMessage[];
  sessions?: ChatSessionSummary[];
  active_session_id?: string | null;
  error?: string;
};

const MODEL_STORAGE_KEY = "anbud-openai-model";

function makeLocalMessage(input: {
  projectId: string;
  role: ChatMessage["role"];
  content: string;
  sessionId: string;
  sessionTitle: string;
}) {
  const createdAt = new Date().toISOString();
  return {
    id: `local-${input.role}-${createdAt}`,
    project_id: input.projectId,
    role: input.role,
    content: input.content,
    context_snapshot: {
      chat_session_id: input.sessionId,
      chat_session_title: input.sessionTitle,
    },
    created_at: createdAt,
  } satisfies ChatMessage;
}

function compactTitle(value: string, limit = 72) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized || "Ny chat";
  }

  return `${normalized.slice(0, limit - 1).trim()}…`;
}

function formatSessionDate(value: string) {
  try {
    return new Intl.DateTimeFormat("no-NO", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

async function readJsonPayload<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T & { error?: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T & { error?: string };
  }

  return { error: fallbackMessage } as T & { error?: string };
}

export function ProjectChatPopoutPage({
  projectId,
  projectName,
  customerName,
  projects,
  initialSessionId,
}: {
  projectId: string;
  projectName: string;
  customerName: string | null;
  projects: ProjectSummary[];
  initialSessionId: string | null;
}) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [streamingMessage, setStreamingMessage] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatLoading, setChatLoading] = useState(true);
  const [chatError, setChatError] = useState("");
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    initialSessionId,
  );
  const [activePanel, setActivePanel] = useState<"history" | "projects" | null>(
    null,
  );
  const chatContainerRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  const loadChat = useCallback(
    async (sessionId?: string | null, options?: { showLoading?: boolean }) => {
      if (options?.showLoading !== false) {
        setChatLoading(true);
      }
      setChatError("");

      try {
        const params = new URLSearchParams();
        if (sessionId) {
          params.set("session_id", sessionId);
        }
        const response = await fetch(
          `/api/projects/${projectId}/chat${params.toString() ? `?${params}` : ""}`,
          { cache: "no-store" },
        );
        const payload = await readJsonPayload<ChatPayload>(
          response,
          "Kunne ikke hente chatten.",
        );
        if (!response.ok || !payload.messages || !payload.sessions) {
          throw new Error(payload.error || "Kunne ikke hente chatten.");
        }

        setChatMessages(payload.messages);
        setSessions(payload.sessions);
        setActiveSessionId(payload.active_session_id ?? sessionId ?? null);
      } catch (err) {
        setChatError(
          err instanceof Error ? err.message : "Kunne ikke hente chatten.",
        );
      } finally {
        setChatLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void loadChat(initialSessionId);
  }, [initialSessionId, loadChat]);

  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior: streamingMessage ? "auto" : "smooth",
    });
  }, [chatMessages, streamingMessage]);

  useEffect(() => {
    if (!activeSessionId) {
      window.history.replaceState(null, "", `/projects/${projectId}/chat`);
      return;
    }

    const params = new URLSearchParams();
    params.set("session_id", activeSessionId);
    window.history.replaceState(
      null,
      "",
      `/projects/${projectId}/chat?${params.toString()}`,
    );
  }, [activeSessionId, projectId]);

  function startNewChat() {
    const nextSessionId = crypto.randomUUID();
    setActiveSessionId(nextSessionId);
    setChatMessages([]);
    setStreamingMessage("");
    setChatError("");
    setActivePanel(null);
  }

  async function selectSession(sessionId: string) {
    setActivePanel(null);
    await loadChat(sessionId);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message || chatBusy) {
      return;
    }

    const nextSessionId = activeSessionId ?? crypto.randomUUID();
    const sessionTitle = activeSession?.title ?? compactTitle(message);
    const userMessage = makeLocalMessage({
      projectId,
      role: "user",
      content: message,
      sessionId: nextSessionId,
      sessionTitle,
    });

    setActiveSessionId(nextSessionId);
    setChatInput("");
    setChatError("");
    setChatBusy(true);
    setStreamingMessage("");
    setChatMessages((current) => [...current, userMessage]);

    try {
      const selectedModel =
        window.localStorage.getItem(MODEL_STORAGE_KEY)?.trim() ?? "";
      const response = await fetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(selectedModel ? { "X-OpenAI-Model": selectedModel } : {}),
        },
        body: JSON.stringify({
          message,
          session_id: nextSessionId,
          session_title: sessionTitle,
        }),
      });

      if (!response.ok) {
        const payload = await readJsonPayload<{ error?: string }>(
          response,
          "Kunne ikke sende chatmelding.",
        );
        throw new Error(payload.error || "Kunne ikke sende chatmelding.");
      }

      const responseSessionId =
        response.headers.get("x-chat-session-id") ?? nextSessionId;
      const responseSessionTitle = compactTitle(
        decodeURIComponent(
          response.headers.get("x-chat-session-title") ?? sessionTitle,
        ),
      );
      const decoder = new TextDecoder();
      const reader = response.body?.getReader();
      let assistantText = "";

      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          assistantText += decoder.decode(value, { stream: true });
          setStreamingMessage(assistantText);
        }
        assistantText += decoder.decode();
      } else {
        assistantText = await response.text();
      }

      const cleanedAssistantText = assistantText.trim();
      if (!cleanedAssistantText) {
        throw new Error("Chatten returnerte ikke noe svar.");
      }

      const assistantMessage = makeLocalMessage({
        projectId,
        role: "assistant",
        content: cleanedAssistantText,
        sessionId: responseSessionId,
        sessionTitle: responseSessionTitle,
      });

      setStreamingMessage("");
      setActiveSessionId(responseSessionId);
      setChatMessages((current) => [...current, assistantMessage]);
      await loadChat(responseSessionId, { showLoading: false });
    } catch (err) {
      setStreamingMessage("");
      setChatMessages((current) =>
        current.filter((item) => item.id !== userMessage.id),
      );
      setChatInput(message);
      setChatError(
        err instanceof Error ? err.message : "Kunne ikke sende chatmelding.",
      );
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="flex h-screen overflow-hidden">
        <aside
          className={cn(
            "hidden shrink-0 overflow-hidden border-r border-slate-200 bg-white transition-[width] duration-200 md:block",
            activePanel ? "w-80" : "w-0",
          )}
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-slate-200 px-4 py-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                    {activePanel === "projects" ? "Prosjekter" : "Tidligere chats"}
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    {activePanel === "projects"
                      ? "Bytt til chatten for et annet prosjekt."
                      : "Velg en samtale og fortsett fra historikken."}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setActivePanel(null)}
                >
                  <PanelLeftClose className="size-4" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {activePanel === "projects" ? (
                <div className="grid gap-2">
                  {projects.map((project) => (
                    <Link
                      key={project.id}
                      href={`/projects/${project.id}/chat`}
                      className={cn(
                        "rounded-lg border px-3 py-3 text-left transition-colors",
                        project.id === projectId
                          ? "border-slate-900 bg-slate-950 text-white"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
                      )}
                    >
                      <span className="block truncate text-sm font-semibold">
                        {project.name}
                      </span>
                      <span
                        className={cn(
                          "mt-1 block truncate text-xs",
                          project.id === projectId
                            ? "text-slate-300"
                            : "text-slate-500",
                        )}
                      >
                        {project.customer_name ?? project.industry ?? "Prosjekt"}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : sessions.length ? (
                <div className="grid gap-2">
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => void selectSession(session.id)}
                      className={cn(
                        "rounded-lg border px-3 py-3 text-left transition-colors",
                        session.id === activeSessionId
                          ? "border-slate-900 bg-slate-950 text-white"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
                      )}
                    >
                      <span className="block truncate text-sm font-semibold">
                        {session.title}
                      </span>
                      <span
                        className={cn(
                          "mt-1 block truncate text-xs",
                          session.id === activeSessionId
                            ? "text-slate-300"
                            : "text-slate-500",
                        )}
                      >
                        {session.message_count} meldinger ·{" "}
                        {formatSessionDate(session.updated_at)}
                      </span>
                      {session.last_message_preview ? (
                        <span
                          className={cn(
                            "mt-2 line-clamp-2 block text-xs leading-5",
                            session.id === activeSessionId
                              ? "text-slate-300"
                              : "text-slate-500",
                          )}
                        >
                          {session.last_message_preview}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
                  Ingen tidligere chats ennå.
                </div>
              )}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-white">
          <header className="border-b border-slate-200 px-4 py-3 md:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
                  <MessageSquareText className="size-4" />
                </span>
                <div className="min-w-0">
                  <h1 className="truncate text-base font-semibold text-slate-950">
                    Sparring
                  </h1>
                  <p className="truncate text-sm text-slate-500">
                    {projectName}
                    {customerName ? ` · ${customerName}` : ""}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9"
                  onClick={() =>
                    setActivePanel((panel) =>
                      panel === "projects" ? null : "projects",
                    )
                  }
                >
                  {activePanel === "projects" ? (
                    <PanelLeftClose data-icon="inline-start" />
                  ) : (
                    <FolderOpen data-icon="inline-start" />
                  )}
                  Prosjekter
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9"
                  onClick={() =>
                    setActivePanel((panel) =>
                      panel === "history" ? null : "history",
                    )
                  }
                >
                  {activePanel === "history" ? (
                    <PanelLeftClose data-icon="inline-start" />
                  ) : (
                    <PanelLeftOpen data-icon="inline-start" />
                  )}
                  Tidligere chats
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9"
                  onClick={startNewChat}
                >
                  <Plus data-icon="inline-start" />
                  Ny chat
                </Button>
              </div>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col bg-slate-50/70 p-3 md:p-4">
            <div className="mb-3 flex min-h-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
              <History className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {activeSession
                  ? `Fortsetter: ${activeSession.title}`
                  : "Ny samtale. Første melding lager en ny chat i historikken."}
              </span>
            </div>
            <ProjectChatTab
              variant="drawer"
              chatMessages={chatMessages}
              chatInput={chatInput}
              streamingMessage={streamingMessage}
              busy={chatBusy}
              loading={chatLoading}
              error={chatError}
              chatContainerRef={chatContainerRef}
              onChatInputChange={setChatInput}
              onSubmit={onSubmit}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
