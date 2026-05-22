import "server-only";

import { createHash } from "node:crypto";

import { createServiceClient } from "@/lib/server/supabase";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __anbudRateLimits: Map<string, RateLimitBucket> | undefined;
}

const MAX_RATE_LIMIT_BUCKETS = 20_000;
let databaseRateLimitAvailable: boolean | null = null;

function getRateLimitStore() {
  if (!globalThis.__anbudRateLimits) {
    globalThis.__anbudRateLimits = new Map();
  }
  return globalThis.__anbudRateLimits;
}

function cleanupRateLimitStore(store: Map<string, RateLimitBucket>, now: number) {
  if (store.size < MAX_RATE_LIMIT_BUCKETS) {
    return;
  }

  for (const [key, bucket] of store) {
    if (bucket.resetAt <= now) {
      store.delete(key);
    }

    if (store.size < MAX_RATE_LIMIT_BUCKETS * 0.8) {
      return;
    }
  }
}

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

function requestIdentity(request: Request) {
  const forwardedFor = firstHeaderValue(request.headers.get("x-forwarded-for"));
  const realIp = firstHeaderValue(request.headers.get("x-real-ip"));
  const cloudflareIp = firstHeaderValue(request.headers.get("cf-connecting-ip"));
  const clientIp = firstHeaderValue(request.headers.get("x-client-ip"));
  const userAgent = request.headers.get("user-agent") ?? "";
  const source = `${cloudflareIp || realIp || forwardedFor || clientIp || "local"}:${userAgent}`;
  return createHash("sha256").update(source).digest("hex").slice(0, 24);
}

function checkMemoryRateLimit(
  request: Request,
  scope: string,
  options: {
    limit: number;
    windowMs: number;
  },
): RateLimitResult & { identityHash: string } {
  const now = Date.now();
  const identityHash = requestIdentity(request);
  const key = `${scope}:${identityHash}`;
  const store = getRateLimitStore();
  cleanupRateLimitStore(store, now);
  const current = store.get(key);

  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, retryAfterSeconds: 0, identityHash };
  }

  if (current.count >= options.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      identityHash,
    };
  }

  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0, identityHash };
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function checkDatabaseRateLimit(input: {
  scope: string;
  identityHash: string;
  limit: number;
  windowMs: number;
}): Promise<RateLimitResult | null> {
  if (databaseRateLimitAvailable === false) {
    return null;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    databaseRateLimitAvailable = false;
    return null;
  }

  try {
    const supabase = createServiceClient();
    const result = await withTimeout(
      supabase.rpc("check_app_rate_limit", {
        p_identity_hash: input.identityHash,
        p_limit: input.limit,
        p_scope: input.scope,
        p_window_ms: input.windowMs,
      }),
      200,
    );

    if (!result || result.error) {
      databaseRateLimitAvailable = false;
      return null;
    }

    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row || typeof row !== "object") {
      databaseRateLimitAvailable = false;
      return null;
    }

    databaseRateLimitAvailable = true;
    return {
      allowed: Boolean((row as { allowed?: unknown }).allowed),
      retryAfterSeconds: Math.max(
        0,
        Number((row as { retry_after_seconds?: unknown }).retry_after_seconds) || 0,
      ),
    };
  } catch {
    databaseRateLimitAvailable = false;
    return null;
  }
}

export async function checkRateLimit(
  request: Request,
  scope: string,
  options: {
    limit: number;
    windowMs: number;
  },
) {
  const memoryLimit = checkMemoryRateLimit(request, scope, options);
  if (!memoryLimit.allowed) {
    return memoryLimit;
  }

  const databaseLimit = await checkDatabaseRateLimit({
    scope,
    identityHash: memoryLimit.identityHash,
    limit: options.limit,
    windowMs: options.windowMs,
  });

  return databaseLimit ?? memoryLimit;
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
