import "server-only";

import { isRecord } from "@/lib/unknown-values";

/** A malformed request body: the caller's mistake, reported as 400. */
export class RequestBodyError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "RequestBodyError";
  }
}

/**
 * Reads a JSON object body. An empty body reads as `{}`; malformed JSON or a
 * non-object body is rejected. Field values stay `unknown` until checked.
 */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestBodyError("Forespørselen inneholder ugyldig JSON.");
  }
  if (!isRecord(value)) {
    throw new RequestBodyError("Forespørselen må være et JSON-objekt.");
  }
  return value;
}

/** A trimmed text field; absent, null or blank reads as null. */
export function optionalTextField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new RequestBodyError(`Feltet ${key} må være tekst.`);
  }
  return value.trim() || null;
}

/** A list of strings; absent reads as an empty list. */
export function stringListField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new RequestBodyError(`Feltet ${key} må være en liste med tekst.`);
  }
  return value;
}
