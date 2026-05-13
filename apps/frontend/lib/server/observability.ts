import "server-only";

import { createHash } from "node:crypto";

import { createServiceClient } from "@/lib/server/supabase";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __anbudRateLimits: Map<string, RateLimitBucket> | undefined;
}

function getRateLimitStore() {
  if (!globalThis.__anbudRateLimits) {
    globalThis.__anbudRateLimits = new Map();
  }
  return globalThis.__anbudRateLimits;
}

function requestIdentity(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const realIp = request.headers.get("x-real-ip") ?? "";
  const userAgent = request.headers.get("user-agent") ?? "";
  const source = `${forwardedFor.split(",")[0].trim() || realIp || "local"}:${userAgent}`;
  return createHash("sha256").update(source).digest("hex").slice(0, 24);
}

export function checkRateLimit(
  request: Request,
  scope: string,
  options: {
    limit: number;
    windowMs: number;
  },
) {
  const now = Date.now();
  const key = `${scope}:${requestIdentity(request)}`;
  const store = getRateLimitStore();
  const current = store.get(key);

  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (current.count >= options.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function withTiming<T>(
  label: string,
  metadata: Record<string, unknown>,
  action: () => Promise<T>,
) {
  const start = performance.now();
  try {
    return await action();
  } finally {
    const durationMs = Math.round(performance.now() - start);
    console.info(
      JSON.stringify({
        event: "route_timing",
        label,
        duration_ms: durationMs,
        ...metadata,
      }),
    );
  }
}

export async function auditEvent(input: {
  action: string;
  projectId?: string | null;
  entityType?: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const payload = {
    action: input.action,
    project_id: input.projectId ?? null,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    metadata: input.metadata ?? {},
    created_at: new Date().toISOString(),
  };

  console.info(JSON.stringify({ event: "audit", ...payload }));

  try {
    const supabase = createServiceClient();
    await supabase.from("audit_events").insert(payload);
  } catch {
    // Databases without the audit_events migration still get structured logs.
  }
}
