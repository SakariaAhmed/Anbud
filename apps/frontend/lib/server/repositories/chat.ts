import "server-only";
import { isRecord } from "@/lib/unknown-values";
import { parseChatSourceReferences as normalizeChatSourceReferences } from "@/lib/chat-source-references";

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
} from "@/lib/types";

const CHAT_MESSAGE_PAGE_SIZE = 100;
const CHAT_LEGACY_PAGE_SIZE = 100;
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


function sessionIdFromSnapshot(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = (snapshot as { chat_session_id?: unknown }).chat_session_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapChatMessage(row: ChatRow): ChatMessage {
  const contextSnapshot = decryptJson(row.context_snapshot, {});
  const snapshotRecord = isRecord(contextSnapshot) ? contextSnapshot : {};
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

export type ChatMessageCursor = { createdAt: string; id: string };

export class InvalidChatMessageCursorError extends Error {}

export function decodeChatMessageCursor(value: string | null): ChatMessageCursor | null {
  if (!value) return null;
  try {
    if (value.length > 256) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const cursor = parsed as Record<string, unknown>;
    if (typeof cursor.createdAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/u.test(cursor.createdAt) ||
        !Number.isFinite(Date.parse(cursor.createdAt)) ||
        typeof cursor.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(cursor.id)) throw new Error();
    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    throw new InvalidChatMessageCursorError("Ugyldig side i chathistorikken.");
  }
}

function encodeChatMessageCursor(row: ChatRow) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString("base64url");
}

/** Session filtering precedes the bound; (timestamp, id) gives stable tied-date pages. */
export async function listChatMessagePage(projectId: string, sessionId: string, before: ChatMessageCursor | null = null) {
  let query = createServiceClient().from("chat_messages").select("*")
    .eq("project_id", projectId).eq("session_id", sessionId)
    .order("created_at", { ascending: false }).order("id", { ascending: false });
  if (before) {
    query = query.or(`created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`);
  }
  const { data, error } = await query.limit(CHAT_MESSAGE_PAGE_SIZE + 1);
  if (error) throw new Error(error.message || "Kunne ikke hente chatmeldinger.");
  const rows = (data ?? []) as ChatRow[];
  const page = rows.slice(0, CHAT_MESSAGE_PAGE_SIZE);
  return {
    messages: page.slice().reverse().map(mapChatMessage),
    nextCursor: rows.length > CHAT_MESSAGE_PAGE_SIZE ? encodeChatMessageCursor(page[page.length - 1]) : null,
  };
}

/** Recent model context uses the same session scope, never another session's global slice. */
export async function listChatMessages(projectId: string, sessionId: string) {
  return (await listChatMessagePage(projectId, sessionId)).messages;
}

/**
 * Older clients stored only an encrypted snapshot session id. Materialize those
 * finite legacy rows in small pages without changing the encrypted evidence.
 * A failed/interrupted conversion resumes at the remaining NULL rows. Current
 * inserts always set session_id, so normal views do no history scan.
 */
async function materializeLegacyChatSessions(projectId: string) {
  const dataApi = createServiceClient();
  while (true) {
    const { data, error } = await dataApi.from("chat_messages").select("*")
      .eq("project_id", projectId).is("session_id", null)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .limit(CHAT_LEGACY_PAGE_SIZE);
    if (error) throw new Error(error.message || "Kunne ikke hente eldre chatmeldinger.");
    const rows = (data ?? []) as ChatRow[];
    if (!rows.length) return;
    for (const row of rows) {
      const snapshotValue = decryptJson<unknown>(row.context_snapshot, {});
      const snapshot = isRecord(snapshotValue) ? snapshotValue : {};
      const sessionId = sessionIdFromSnapshot(snapshot) ?? "legacy";
      const title = typeof snapshot.chat_session_title === "string" && snapshot.chat_session_title.trim()
        ? snapshot.chat_session_title.trim().slice(0, 72) : "Tidligere samtale";
      const inserted = await dataApi.from("chat_sessions").upsert({
        project_id: projectId, id: sessionId, title, created_at: row.created_at, updated_at: row.created_at,
      }, { onConflict: "project_id,id", ignoreDuplicates: true });
      if (inserted.error) throw new Error(inserted.error.message);
      const updated = await dataApi.from("chat_messages").update({ session_id: sessionId })
        .eq("project_id", projectId).eq("id", row.id).is("session_id", null);
      if (updated.error) throw new Error(updated.error.message);
    }
  }
}

export async function listChatSessions(projectId: string) {
  await materializeLegacyChatSessions(projectId);
  const sessions: ChatSessionSummary[] = [];
  // Session metadata uses the immutable id as its cursor. A
  // concurrently inserted session can appear on the next refresh; messages
  // themselves use keysets and never duplicate/skip on new writes.
  let afterId: string | null = null;
  while (true) {
    let query = createServiceClient().from("chat_sessions").select("*")
      .eq("project_id", projectId).order("id", { ascending: true }).limit(100);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw new Error(error.message || "Kunne ikke hente chat-samtaler.");
    const page = (data ?? []) as ChatSessionRow[];
    sessions.push(...page.map(mapChatSession));
    if (page.length < 100) break;
    afterId = page[page.length - 1].id;
  }
  return sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
}

export async function upsertChatSession(input: {
  projectId: string;
  sessionId: string;
  title: string;
  domainHints?: ChatDomainHint[];
}) {
  const dataApi = createServiceClient();
  const { error } = await dataApi.from("chat_sessions").upsert(
    {
      id: input.sessionId,
      project_id: input.projectId,
      title: input.title,
      domain_hints: input.domainHints ?? [],
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id,id", ignoreDuplicates: true },
  );
  if (error) {
    if (isMissingRelationColumn(error, "chat_sessions")) return;
    throw new Error(error.message || "Kunne ikke lagre chat-session.");
  }
}

/** Append with ciphertext CAS: concurrent completions re-read and retain the winning turn. */
export async function updateChatSessionMemory(input: {
  projectId: string;
  sessionId: string;
  appendSummary: (currentSummary: string) => string;
  domainHints: ChatDomainHint[];
}) {
  const dataApi = createServiceClient();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await dataApi.from("chat_sessions").select("summary_encrypted,domain_hints")
      .eq("project_id", input.projectId).eq("id", input.sessionId)
      .single<{ summary_encrypted: string; domain_hints: unknown }>();
    if (current.error || !current.data) throw new Error(current.error?.message || "Fant ikke chat-samtalen.");
    const previous = current.data.summary_encrypted;
    const summary = input.appendSummary(decryptString(previous));
    const domainHints = [...new Set([...normalizeChatDomainHints(current.data.domain_hints), ...input.domainHints])].slice(-4);
    const updated = await dataApi.rpc("compare_and_swap_chat_session_memory", {
      p_project_id: input.projectId, p_session_id: input.sessionId,
      p_expected_summary: previous, p_summary: encryptString(summary), p_domain_hints: domainHints,
    });
    if (updated.error) throw new Error(updated.error.message || "Kunne ikke oppdatere chat-minne.");
    if (updated.data === true) return;
  }
  throw new Error("Chat-minnet ble endret samtidig. Meldingen er lagret, men minnet kunne ikke oppdateres.");
}
