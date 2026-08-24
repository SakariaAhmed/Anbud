import "server-only";

import {
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
} from "@/lib/server/crypto";
import { revalidateProjectCaches } from "@/lib/server/repositories/repository-cache";
import { isMissingRelationColumn } from "@/lib/server/repositories/postgrest-compat";
import { createServiceClient } from "@/lib/server/data-api";
import type {
  ChatDomainHint,
  ChatMessage,
  ChatMessageRole,
  ChatSessionSummary,
  ChatSourceReference,
} from "@/lib/types";

const CHAT_MESSAGE_LIST_LIMIT = 1200;
const CHAT_DOMAIN_HINTS = new Set<ChatDomainHint>([
  "Kunde og behov",
  "Krav og etterlevelse",
  "Risiko",
  "Verdi og gevinst",
  "Arkitektur og løsning",
  "Tilbudsstrategi og posisjonering",
  "Leveranse og drift",
  "Kontrakt og kommersielt",
  "Dokument og kildegrunnlag",
]);

interface ChatRow {
  id: string;
  project_id: string;
  session_id?: string | null;
  role: ChatMessageRole;
  content: string;
  context_snapshot: unknown;
  created_at: string;
}

interface ChatSessionRow {
  id: string;
  project_id: string;
  title: string;
  summary_encrypted: string | null;
  domain_hints: string[] | null;
  pinned: boolean | null;
  status: string | null;
  message_count: number | null;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeChatDomainHints(value: unknown): ChatDomainHint[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (item): item is ChatDomainHint =>
          typeof item === "string" &&
          CHAT_DOMAIN_HINTS.has(item as ChatDomainHint),
      ),
    ),
  ).slice(0, 4);
}

function normalizeChatSourceReferences(value: unknown): ChatSourceReference[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object",
    )
    .map((item) => ({
      document_title:
        typeof item.document_title === "string" ? item.document_title : "",
      reference: typeof item.reference === "string" ? item.reference : "",
      heading_path: Array.isArray(item.heading_path)
        ? item.heading_path.filter(
            (part): part is string => typeof part === "string",
          )
        : [],
      page_start:
        typeof item.page_start === "number" && Number.isFinite(item.page_start)
          ? item.page_start
          : null,
      page_end:
        typeof item.page_end === "number" && Number.isFinite(item.page_end)
          ? item.page_end
          : null,
      source_type:
        item.source_type === "service_document"
          ? ("service_document" as const)
          : ("project_document" as const),
      source_id: typeof item.source_id === "string" ? item.source_id : "",
    }))
    .filter((item) => item.document_title || item.reference)
    .slice(0, 8);
}

function sessionIdFromSnapshot(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = (snapshot as { chat_session_id?: unknown }).chat_session_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapChatMessage(row: ChatRow): ChatMessage {
  const contextSnapshot = decryptJson(row.context_snapshot, {});
  const snapshotRecord = contextSnapshot as Record<string, unknown>;
  return {
    id: row.id,
    project_id: row.project_id,
    session_id: row.session_id ?? sessionIdFromSnapshot(contextSnapshot),
    role: row.role,
    content: row.content,
    context_snapshot: contextSnapshot,
    source_references: normalizeChatSourceReferences(
      snapshotRecord.source_references,
    ),
    domain_hints: normalizeChatDomainHints(snapshotRecord.domain_hints),
    created_at: row.created_at,
  };
}

function mapChatSession(row: ChatSessionRow): ChatSessionSummary {
  return {
    id: row.id,
    title: row.title,
    summary:
      typeof row.summary_encrypted === "string"
        ? decryptString(row.summary_encrypted)
        : "",
    domain_hints: normalizeChatDomainHints(row.domain_hints),
    pinned: Boolean(row.pinned),
    status: row.status === "archived" ? "archived" : "active",
    message_count: Math.max(0, Number(row.message_count ?? 0)),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message_preview: row.last_message_preview ?? "",
  };
}

export async function appendChatMessage(
  projectId: string,
  role: ChatMessageRole,
  content: string,
  contextSnapshot: unknown,
  options: { sessionId?: string | null } = {},
) {
  const dataApi = createServiceClient();
  const payload = {
    project_id: projectId,
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    role,
    content,
    context_snapshot: encryptJson(contextSnapshot),
  };
  let result = await dataApi
    .from("chat_messages")
    .insert(payload)
    .select("*")
    .single<ChatRow>();

  if (
    result.error &&
    options.sessionId &&
    isMissingRelationColumn(result.error, "chat_messages")
  ) {
    result = await dataApi
      .from("chat_messages")
      .insert({
        project_id: projectId,
        role,
        content,
        context_snapshot: encryptJson(contextSnapshot),
      })
      .select("*")
      .single<ChatRow>();
  }
  if (result.error || !result.data) {
    throw new Error(result.error?.message || "Kunne ikke lagre chatmeldingen.");
  }
  await dataApi
    .from("projects")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", projectId);
  revalidateProjectCaches(projectId);
  return mapChatMessage(result.data);
}

export async function listChatMessages(projectId: string) {
  const dataApi = createServiceClient();
  const { data, error } = await dataApi
    .from("chat_messages")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(CHAT_MESSAGE_LIST_LIMIT);
  if (error) throw new Error(error.message || "Kunne ikke hente chatmeldinger.");
  return ((data ?? []) as ChatRow[]).reverse().map(mapChatMessage);
}

export async function listChatSessions(projectId: string) {
  const dataApi = createServiceClient();
  const { data, error } = await dataApi
    .from("chat_sessions")
    .select("*")
    .eq("project_id", projectId)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) {
    if (isMissingRelationColumn(error, "chat_sessions")) return [];
    throw new Error(error.message || "Kunne ikke hente chat-sessions.");
  }
  return ((data ?? []) as ChatSessionRow[]).map(mapChatSession);
}

export async function upsertChatSession(input: {
  projectId: string;
  sessionId: string;
  title: string;
  domainHints?: ChatDomainHint[];
  lastMessagePreview?: string;
  messageCount?: number;
}) {
  const dataApi = createServiceClient();
  const { error } = await dataApi.from("chat_sessions").upsert(
    {
      id: input.sessionId,
      project_id: input.projectId,
      title: input.title,
      domain_hints: input.domainHints ?? [],
      last_message_preview: input.lastMessagePreview ?? "",
      message_count: input.messageCount ?? 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id,id" },
  );
  if (error) {
    if (isMissingRelationColumn(error, "chat_sessions")) return;
    throw new Error(error.message || "Kunne ikke lagre chat-session.");
  }
}

export async function updateChatSessionMemory(input: {
  projectId: string;
  sessionId: string;
  summary: string;
  domainHints: ChatDomainHint[];
  lastMessagePreview: string;
  messageCount: number;
}) {
  const dataApi = createServiceClient();
  const { error } = await dataApi
    .from("chat_sessions")
    .update({
      summary_encrypted: encryptString(input.summary),
      domain_hints: input.domainHints,
      last_message_preview: input.lastMessagePreview,
      message_count: input.messageCount,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", input.projectId)
    .eq("id", input.sessionId);
  if (error && !isMissingRelationColumn(error, "chat_sessions")) {
    throw new Error(error.message || "Kunne ikke oppdatere chat-minne.");
  }
}
