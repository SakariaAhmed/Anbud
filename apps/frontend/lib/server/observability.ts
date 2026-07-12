import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  beginDistributedRateLimitAttempt,
  createDistributedRateLimitCircuitState,
  recordDistributedRateLimitFailure,
  recordDistributedRateLimitSuccess,
  withAbortTimeout,
  type DistributedRateLimitCircuitState,
} from "@/lib/server/distributed-rate-limit-circuit";
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
  var __anbudRateLimits: Map<string, RateLimitBucket> | undefined;
  var __anbudDatabaseRateLimitCircuit:
    | DistributedRateLimitCircuitState
    | undefined;
}

const MAX_RATE_LIMIT_BUCKETS = 20_000;
const DATABASE_RATE_LIMIT_TIMEOUT_MS = 250;
const REQUIRED_AUDIT_WRITE_ATTEMPTS = 3;
const AUDIT_RETRY_BASE_DELAY_MS = 25;
const DEFAULT_AUDIT_WRITE_TIMEOUT_MS = 2_000;

type AuditWriteFailure = {
  code?: string;
  message?: string;
};

type AuditInsertResult = {
  error: AuditWriteFailure | null;
};

function auditWriteTimeoutMs() {
  const configured = Number(process.env.AUDIT_WRITE_TIMEOUT_MS?.trim());
  return Number.isFinite(configured) && configured >= 1
    ? Math.min(configured, 10_000)
    : DEFAULT_AUDIT_WRITE_TIMEOUT_MS;
}

async function insertAuditEventWithTimeout(payload: Record<string, unknown>) {
  return withAbortTimeout<AuditInsertResult>((signal) => {
    const query = createServiceClient()
      .from("audit_events")
      .insert(payload) as unknown as PromiseLike<AuditInsertResult> & {
      abortSignal?: (abortSignal: AbortSignal) => PromiseLike<AuditInsertResult>;
    };
    return typeof query.abortSignal === "function"
      ? query.abortSignal(signal)
      : query;
  }, auditWriteTimeoutMs());
}

export class AuditEventPersistenceError extends Error {
  readonly action: string;
  readonly eventId: string;

  constructor(input: {
    action: string;
    eventId: string;
    message: string;
  }) {
    super(input.message);
    this.name = "AuditEventPersistenceError";
    this.action = input.action;
    this.eventId = input.eventId;
  }
}

function getRateLimitStore() {
  if (!globalThis.__anbudRateLimits) {
    globalThis.__anbudRateLimits = new Map();
  }
  return globalThis.__anbudRateLimits;
}

function getDatabaseRateLimitCircuit() {
  if (!globalThis.__anbudDatabaseRateLimitCircuit) {
    globalThis.__anbudDatabaseRateLimitCircuit =
      createDistributedRateLimitCircuitState();
  }
  return globalThis.__anbudDatabaseRateLimitCircuit;
}

function logDatabaseRateLimitCircuitTransition(
  previousStatus: DistributedRateLimitCircuitState["status"],
  outcome: "success" | "failure",
) {
  const state = getDatabaseRateLimitCircuit();
  if (state.status === previousStatus) {
    return;
  }
  console.warn(
    JSON.stringify({
      event: "distributed_rate_limit_circuit_transition",
      previous_status: previousStatus,
      status: state.status,
      outcome,
      consecutive_failures: state.consecutiveFailures,
      retry_after_ms:
        state.status === "open" ? Math.max(0, state.openUntil - Date.now()) : 0,
    }),
  );
}

function recordDatabaseRateLimitFailure(now: number) {
  const state = getDatabaseRateLimitCircuit();
  const previousStatus = state.status;
  recordDistributedRateLimitFailure(state, now);
  logDatabaseRateLimitCircuitTransition(previousStatus, "failure");
}

function recordDatabaseRateLimitSuccess() {
  const state = getDatabaseRateLimitCircuit();
  const previousStatus = state.status;
  recordDistributedRateLimitSuccess(state);
  logDatabaseRateLimitCircuitTransition(previousStatus, "success");
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

function shouldTrustForwardedRateLimitHeaders() {
  const value = process.env.TRUST_FORWARDED_RATE_LIMIT_HEADERS
    ?.trim()
    .toLowerCase();
  if (!value) {
    return process.env.NODE_ENV !== "production";
  }

  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function requestIdentity(request: Request, mode: "request" | "global") {
  if (mode === "global") {
    return createHash("sha256").update("global").digest("hex").slice(0, 24);
  }

  const trustedForwardedHeaders = shouldTrustForwardedRateLimitHeaders();
  const forwardedFor = trustedForwardedHeaders
    ? firstHeaderValue(request.headers.get("x-forwarded-for"))
    : "";
  const realIp = trustedForwardedHeaders
    ? firstHeaderValue(request.headers.get("x-real-ip"))
    : "";
  const cloudflareIp = trustedForwardedHeaders
    ? firstHeaderValue(request.headers.get("cf-connecting-ip"))
    : "";
  const clientIp = trustedForwardedHeaders
    ? firstHeaderValue(request.headers.get("x-client-ip"))
    : "";
  const source = cloudflareIp || realIp || forwardedFor || clientIp || "direct";
  return createHash("sha256").update(source).digest("hex").slice(0, 24);
}

function checkMemoryRateLimit(
  request: Request,
  scope: string,
  options: {
    limit: number;
    windowMs: number;
    identityMode?: "request" | "global";
  },
): RateLimitResult & { identityHash: string } {
  const now = Date.now();
  const identityHash = requestIdentity(request, options.identityMode ?? "request");
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

async function checkDatabaseRateLimit(input: {
  scope: string;
  identityHash: string;
  limit: number;
  windowMs: number;
}): Promise<RateLimitResult | null> {
  const now = Date.now();
  const circuit = getDatabaseRateLimitCircuit();
  if (!beginDistributedRateLimitAttempt(circuit, now)) {
    return null;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    recordDatabaseRateLimitFailure(now);
    return null;
  }

  try {
    const supabase = createServiceClient();
    const result = await withAbortTimeout(
      (signal) =>
        supabase
          .rpc("check_app_rate_limit", {
            p_identity_hash: input.identityHash,
            p_limit: input.limit,
            p_scope: input.scope,
            p_window_ms: input.windowMs,
          })
          .abortSignal(signal),
      DATABASE_RATE_LIMIT_TIMEOUT_MS,
    );

    if (!result || result.error) {
      recordDatabaseRateLimitFailure(now);
      return null;
    }

    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row || typeof row !== "object") {
      recordDatabaseRateLimitFailure(now);
      return null;
    }

    recordDatabaseRateLimitSuccess();
    return {
      allowed: Boolean((row as { allowed?: unknown }).allowed),
      retryAfterSeconds: Math.max(
        0,
        Number((row as { retry_after_seconds?: unknown }).retry_after_seconds) || 0,
      ),
    };
  } catch {
    recordDatabaseRateLimitFailure(now);
    return null;
  }
}

export async function checkRateLimit(
  request: Request,
  scope: string,
  options: {
    limit: number;
    windowMs: number;
    identityMode?: "request" | "global";
    fallbackLimit?: number;
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

  if (databaseLimit) {
    return databaseLimit;
  }

  const configuredFallbackLimit = Number(options.fallbackLimit);
  if (
    Number.isFinite(configuredFallbackLimit) &&
    configuredFallbackLimit > 0 &&
    configuredFallbackLimit < options.limit
  ) {
    return checkMemoryRateLimit(request, `${scope}:distributed-fallback`, {
      ...options,
      limit: Math.floor(configuredFallbackLimit),
    });
  }

  return memoryLimit;
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
  eventId?: string;
  action: string;
  projectId?: string | null;
  entityType?: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  required?: boolean;
}) {
  const eventId = input.eventId ?? randomUUID();
  const payload = {
    id: eventId,
    action: input.action,
    project_id: input.projectId ?? null,
    subject_project_id: input.projectId ?? null,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    metadata: input.metadata ?? {},
    created_at: new Date().toISOString(),
  };

  console.info(JSON.stringify({ event: "audit", ...payload }));

  const attempts = input.required ? REQUIRED_AUDIT_WRITE_ATTEMPTS : 1;
  let lastFailure: AuditWriteFailure = {
    message: "Ukjent feil ved lagring av revisjonshendelse.",
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const insertResult = await insertAuditEventWithTimeout(payload);
      const error =
        insertResult === null
          ? {
              code: "AUDIT_WRITE_TIMEOUT",
              message: "Tidsgrensen for lagring av revisjonshendelsen ble nådd.",
            }
          : insertResult.error;
      if (!error) {
        return { eventId, persisted: true as const };
      }
      if (
        error.code === "23505" &&
        /audit_events_pkey|duplicate key value.*audit_events/iu.test(
          error.message ?? "",
        )
      ) {
        return { eventId, persisted: true as const };
      }
      lastFailure = error;
    } catch (error) {
      lastFailure = {
        message:
          error instanceof Error
            ? error.message
            : String(error ?? "Ukjent revisjonsloggfeil."),
      };
    }

    if (attempt < attempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, AUDIT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)),
      );
    }
  }

  const failureMessage =
    lastFailure.message || "Kunne ikke lagre revisjonshendelsen.";
  console.error(
    JSON.stringify({
      event: "audit_persistence_failed",
      audit_event_id: eventId,
      action: input.action,
      project_id: input.projectId ?? null,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      required: Boolean(input.required),
      attempts,
      error_code: lastFailure.code ?? null,
      error: failureMessage,
    }),
  );

  if (input.required) {
    throw new AuditEventPersistenceError({
      action: input.action,
      eventId,
      message: `Kunne ikke lagre obligatorisk revisjonshendelse: ${failureMessage}`,
    });
  }

  return {
    eventId,
    persisted: false as const,
    error: failureMessage,
  };
}
