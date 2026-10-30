import "server-only";

import { NextResponse } from "next/server";

import { authorizationErrorResponse } from "@/lib/server/authorization";
import { DatabaseUpdateRequiredError } from "@/lib/server/database-update-required";
import { MultipartRequestError } from "@/lib/server/multipart";
import { checkRateLimit } from "@/lib/server/observability";
import { RequestBodyError } from "@/lib/server/request-body";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";
import { workflowError } from "@/lib/server/workflow-errors";

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

/**
 * Maps a route failure to a response: authorization and request errors keep
 * their status, known domain errors use their own status, and anything else
 * gets `status` (500 by default) with a production-safe message.
 */
export function routeErrorResponse(
  error: unknown,
  fallbackMessage: string,
  options: { status?: number; headers?: HeadersInit } = {},
) {
  const authorizationResponse = authorizationErrorResponse(error);
  if (authorizationResponse) return authorizationResponse;
  if (error instanceof RequestBodyError || error instanceof MultipartRequestError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers: options.headers },
    );
  }
  if (error instanceof DatabaseUpdateRequiredError) {
    return NextResponse.json(
      { error: error.userMessage, code: error.code },
      { status: error.status, headers: options.headers },
    );
  }
  const known = workflowError(error);
  // The code lets clients react to a known conflict (for example by
  // refreshing project jobs) without parsing the Norwegian message.
  return NextResponse.json(
    {
      error: productionSafeErrorMessage(error, fallbackMessage),
      ...(known ? { code: known.code } : {}),
    },
    {
      status: known?.status ?? options.status ?? 500,
      headers: options.headers,
    },
  );
}
