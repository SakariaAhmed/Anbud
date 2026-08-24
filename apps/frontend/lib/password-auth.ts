export const AUTH_COOKIE_NAME = "bidsite_session";
export const AUTH_VERIFIED_HEADER = "x-bidsite-auth-verified";
export const AUTH_DISPLAY_NAME_HEADER = "x-bidsite-display-name";
export const AUTH_PRINCIPAL_HEADER = "x-bidsite-principal-id";
export const AUTH_IDENTITY_TYPE_HEADER = "x-bidsite-identity-type";
export const AUTH_IS_ADMIN_HEADER = "x-bidsite-is-admin";
export const AUTH_SESSION_HEADER = "x-bidsite-session-id";

const DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;
const MIN_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 15;
const MAX_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const DATABASE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATABASE_SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{40,80}$/u;

function configuredSessionMaxAgeSeconds() {
  const configured = Number(process.env.APP_SESSION_MAX_AGE_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS;
  }

  return Math.min(
    MAX_AUTH_COOKIE_MAX_AGE_SECONDS,
    Math.max(MIN_AUTH_COOKIE_MAX_AGE_SECONDS, Math.floor(configured)),
  );
}

export const AUTH_COOKIE_MAX_AGE_SECONDS = configuredSessionMaxAgeSeconds();

const encoder = new TextEncoder();
let signingKeyCache:
  | {
      secret: string;
      promise: Promise<CryptoKey>;
    }
  | null = null;

function getSigningSecret() {
  return process.env.APP_SESSION_SECRET?.trim() ?? "";
}

function toBase64Url(bytes: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sign(value: string) {
  const secret = getSigningSecret();
  if (!secret) {
    throw new Error("Missing APP_SESSION_SECRET.");
  }

  if (!signingKeyCache || signingKeyCache.secret !== secret) {
    signingKeyCache = {
      secret,
      promise: crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    };
  }

  const key = await signingKeyCache.promise;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toBase64Url(signature);
}

export function encodeDatabaseSessionToken(
  sessionId: string,
  secret: string,
) {
  if (
    !DATABASE_SESSION_ID_PATTERN.test(sessionId) ||
    !DATABASE_SESSION_SECRET_PATTERN.test(secret)
  ) {
    throw new Error("Invalid database session token.");
  }
  return `s4.${sessionId}.${secret}`;
}

export function parseDatabaseSessionToken(
  token: string | undefined | null,
) {
  if (!token || token.length > 256) return null;
  const [version, sessionId, secret, extra] = token.split(".");
  if (
    version !== "s4" ||
    extra !== undefined ||
    !sessionId ||
    !secret ||
    !DATABASE_SESSION_ID_PATTERN.test(sessionId) ||
    !DATABASE_SESSION_SECRET_PATTERN.test(secret)
  ) {
    return null;
  }
  return { sessionId, secret };
}

export function databaseSessionTokenHmac(
  sessionId: string,
  secret: string,
) {
  if (
    !DATABASE_SESSION_ID_PATTERN.test(sessionId) ||
    !DATABASE_SESSION_SECRET_PATTERN.test(secret)
  ) {
    throw new Error("Invalid database session token.");
  }
  return sign(`database-session:${sessionId}:${secret}`);
}

export async function deriveOwnerId(subject: string) {
  if (!subject.trim()) throw new Error("Missing Microsoft account subject.");
  return `u_${(await sign(`entra:${subject}`)).slice(0, 43)}`;
}
