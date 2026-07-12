import "server-only";

import { NextResponse } from "next/server";

import { checkRateLimit } from "@/lib/server/observability";

function rateLimitExceededResponse(
  message: string,
  retryAfterSeconds: number,
) {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}

export async function enforceRateLimit(
  request: Request,
  scope: string,
  options: {
    limit: number;
    windowMs: number;
    fallbackLimit?: number;
  },
  message: string,
) {
  const rateLimit = await checkRateLimit(request, scope, options);
  return rateLimit.allowed
    ? null
    : rateLimitExceededResponse(message, rateLimit.retryAfterSeconds);
}

export async function enforceProjectRouteRateLimit(
  request: Request,
  context: { params: Promise<{ id: string }> },
  input: {
    scopePrefix: string;
    message: string;
    limit: number;
    windowMs: number;
    fallbackLimit?: number;
  },
) {
  const { id } = await context.params;
  const response = await enforceRateLimit(
    request,
    `${input.scopePrefix}:${id}`,
    {
      limit: input.limit,
      windowMs: input.windowMs,
      fallbackLimit: input.fallbackLimit,
    },
    input.message,
  );

  return { id, response };
}

export function enforceServiceDescriptionWriteRateLimit(request: Request) {
  return enforceRateLimit(
    request,
    "service-descriptions-write",
    {
      limit: 16,
      windowMs: 60_000,
    },
    "For mange tjenesteendringer på kort tid.",
  );
}
