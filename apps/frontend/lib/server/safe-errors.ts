import { createHash } from "node:crypto";

const SAFE_REQUEST_ID = /^[a-z0-9_.:-]{1,128}$/i;

function errorText(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}:${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error ?? "UnknownError");
}

function safeRequestId(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return SAFE_REQUEST_ID.test(normalized) ? normalized : null;
}

function requestIdFromHeaders(headers: unknown) {
  if (headers instanceof Headers) {
    return safeRequestId(
      headers.get("x-request-id") ?? headers.get("request-id"),
    );
  }
  if (!headers || typeof headers !== "object") {
    return null;
  }
  const record = headers as Record<string, unknown>;
  return safeRequestId(
    record["x-request-id"] ?? record["request-id"] ?? record.request_id,
  );
}

export function errorHash(error: unknown) {
  return createHash("sha256").update(errorText(error)).digest("hex").slice(0, 24);
}

export function errorRequestId(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }
  const record = error as Record<string, unknown>;
  return (
    safeRequestId(record.request_id) ??
    safeRequestId(record.requestId) ??
    safeRequestId(record._request_id) ??
    requestIdFromHeaders(record.headers)
  );
}

export function safeErrorTelemetry(error: unknown, requestId?: string | null) {
  return {
    request_id: safeRequestId(requestId) ?? errorRequestId(error),
    error_hash: errorHash(error),
  };
}

export function productionSafeErrorMessage(
  error: unknown,
  fallback: string,
  requestId?: string | null,
) {
  if (process.env.NODE_ENV !== "production") {
    return error instanceof Error ? error.message : String(error ?? fallback);
  }

  const reference = safeErrorTelemetry(error, requestId);
  return `${fallback} Referanse: ${reference.request_id ?? reference.error_hash}. Feilhash: ${reference.error_hash}.`;
}

export function redactedModelOutputError(
  output: string,
  requestId: string,
) {
  const outputHash = createHash("sha256")
    .update(output)
    .digest("hex")
    .slice(0, 24);
  const error = Object.assign(
    new Error(
      `AI returnerte ugyldig JSON (request_id=${requestId}; output_sha256=${outputHash}).`,
    ),
    {
      request_id: requestId,
      output_sha256: outputHash,
    },
  );
  error.name = "InvalidAiJsonError";
  return error;
}
