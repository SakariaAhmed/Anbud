import "server-only";

import { headers } from "next/headers";

import type { AuthorizedProjectContext, RequestPrincipal } from "@/lib/server/authorization";
import { requestContextHmac } from "@/lib/server/identity-crypto";
import { createServiceClient } from "@/lib/server/supabase";

const SENSITIVE_METADATA_KEYS =
  /(code|token|secret|password|prompt|content|raw|base64|authorization|cookie)/iu;

function sanitizeMetadata(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 3) return "[redacted-depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.slice(0, 500);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [
          key,
          SENSITIVE_METADATA_KEYS.test(key)
            ? "[redacted]"
            : sanitizeMetadata(item, depth + 1),
        ]),
    );
  }
  return String(value ?? "").slice(0, 200);
}

async function requestContext() {
  const requestHeaders = await headers();
  const forwardedFor = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    requestId: requestHeaders.get("x-correlation-id"),
    ipHmac: forwardedFor ? requestContextHmac(forwardedFor) : null,
    userAgentHmac: requestContextHmac(
      requestHeaders.get("user-agent") ?? "",
    ),
  };
}

export async function recordActivity(input: {
  principal?: RequestPrincipal | null;
  context?: AuthorizedProjectContext | null;
  action: string;
  result?: "ok" | "denied" | "error";
  projectId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const principal = input.principal ?? input.context?.principal ?? null;
  const context = await requestContext().catch(() => ({
    requestId: null,
    ipHmac: null,
    userAgentHmac: null,
  }));
  const supabase = createServiceClient();
  const { error } = await supabase.from("activity_events").insert({
    actor_principal_id: principal?.id ?? null,
    actor_session_id: principal?.sessionId ?? null,
    action: input.action,
    result: input.result ?? "ok",
    project_id: input.projectId ?? input.context?.projectId ?? null,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    request_id: context.requestId,
    ip_hmac: context.ipHmac,
    user_agent_hmac: context.userAgentHmac,
    metadata: sanitizeMetadata(input.metadata ?? {}),
  });
  if (error) {
    console.error(
      JSON.stringify({
        event: "activity_persistence_failed",
        action: input.action,
        error: error.message,
      }),
    );
    return { persisted: false as const };
  }
  return { persisted: true as const };
}

export async function listActivity(input?: {
  projectId?: string | null;
  principalId?: string | null;
  action?: string | null;
  from?: string | null;
  limit?: number;
}) {
  const supabase = createServiceClient();
  const limit = Math.min(500, Math.max(1, input?.limit ?? 200));
  let query = supabase
    .from("activity_events")
    .select(
      "id, occurred_at, actor_principal_id, actor_session_id, action, result, project_id, entity_type, entity_id, request_id, metadata",
    )
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (input?.projectId) query = query.eq("project_id", input.projectId);
  if (input?.principalId) {
    query = query.eq("actor_principal_id", input.principalId);
  }
  if (input?.action) query = query.ilike("action", `%${input.action}%`);
  if (input?.from) query = query.gte("occurred_at", input.from);
  const { data: events, error } = await query;
  if (error) throw new Error(error.message);

  const principalIds = [
    ...new Set(
      (events ?? [])
        .map((event) => event.actor_principal_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const projectIds = [
    ...new Set(
      (events ?? [])
        .map((event) => event.project_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const [{ data: principals }, projectResult] = await Promise.all([
    principalIds.length
      ? supabase
          .from("app_principals")
          .select("id, display_name, identity_type, email_masked")
          .in("id", principalIds)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length
      ? supabase.from("projects").select("id, name").in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  let projects = projectResult.data as
    | Array<{ id: string; name?: string | null; title?: string | null }>
    | null;
  if (projectIds.length && projectResult.error) {
    const legacy = await supabase
      .from("projects")
      .select("id, title")
      .in("id", projectIds);
    if (legacy.error) throw new Error(legacy.error.message);
    projects = legacy.data;
  }
  const principalMap = new Map(
    (principals ?? []).map((principal) => [principal.id, principal]),
  );
  const projectMap = new Map(
    (projects ?? []).map((project) => [
      project.id,
      {
        id: project.id,
        name: project.name ?? project.title ?? "Prosjekt",
      },
    ]),
  );
  const enriched = (events ?? []).map((event) => ({
    ...event,
    actor: event.actor_principal_id
      ? principalMap.get(event.actor_principal_id) ?? null
      : null,
    project: event.project_id
      ? projectMap.get(event.project_id) ?? null
      : null,
  }));
  const uniqueUsers = new Set(
    enriched.map((event) => event.actor_principal_id).filter(Boolean),
  ).size;
  const downloads = enriched.filter(
    (event) =>
      String(event.action).includes("download") ||
      ((event.metadata as { path?: string; method?: string } | null)?.method ===
        "GET" &&
        (event.metadata as { path?: string } | null)?.path?.includes(
          "/documents/",
        )),
  ).length;
  const writes = enriched.filter((event) =>
    ["post", "put", "patch", "delete", "create", "update", "upload"].some(
      (marker) => String(event.action).includes(marker),
    ),
  ).length;
  return {
    events: enriched,
    summary: {
      total: enriched.length,
      uniqueUsers,
      downloads,
      writes,
    },
  };
}
