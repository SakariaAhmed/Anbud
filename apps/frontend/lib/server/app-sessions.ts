import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  databaseSessionTokenHmac,
  encodeDatabaseSessionToken,
} from "@/lib/password-auth";
import { createServiceClient } from "@/lib/server/supabase";

export type AppSessionAuthMethod =
  | "entra"
  | "guest_code"
  | "admin_password";

export async function createAppSession(input: {
  principalId: string;
  authMethod: AppSessionAuthMethod;
  maxAgeSeconds?: number;
}) {
  const sessionId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const tokenHmac = await databaseSessionTokenHmac(sessionId, secret);
  const maxAgeSeconds = Math.min(
    AUTH_COOKIE_MAX_AGE_SECONDS,
    Math.max(15 * 60, input.maxAgeSeconds ?? AUTH_COOKIE_MAX_AGE_SECONDS),
  );
  const expiresAt = new Date(Date.now() + maxAgeSeconds * 1_000).toISOString();
  const supabase = createServiceClient();
  const { error } = await supabase.from("app_sessions").insert({
    id: sessionId,
    principal_id: input.principalId,
    token_hmac: tokenHmac,
    auth_method: input.authMethod,
    expires_at: expiresAt,
  });
  if (error) {
    throw new Error(`Kunne ikke opprette sikker økt: ${error.message}`);
  }
  return {
    sessionId,
    token: encodeDatabaseSessionToken(sessionId, secret),
    maxAgeSeconds,
    expiresAt,
  };
}

export async function revokeAppSession(sessionId: string | null | undefined) {
  if (!sessionId) return;
  const supabase = createServiceClient();
  await supabase
    .from("app_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("revoked_at", null);
}

export async function revokePrincipalSessions(principalId: string) {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("app_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("principal_id", principalId)
    .is("revoked_at", null);
  if (error) {
    throw new Error(`Kunne ikke tilbakekalle økter: ${error.message}`);
  }
}
