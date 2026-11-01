import "server-only";

import { randomUUID } from "node:crypto";

// Logs a login failure with a correlation reference the user can quote,
// keeping provider and database messages out of the log line.
export function reportAuthFailure(event: string, stage: string, error: unknown) {
  const reference = randomUUID();
  const code = error && typeof error === "object" && "errorCode" in error
    ? error.errorCode
    : error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  console.error(JSON.stringify({
    event,
    stage,
    reference,
    errorCode: typeof code === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(code)
      ? code
      : "internal_error",
  }));
  return reference;
}
