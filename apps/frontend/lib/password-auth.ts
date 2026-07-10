export const AUTH_COOKIE_NAME = "bidsite_session";
export const AUTH_VERIFIED_HEADER = "x-bidsite-auth-verified";

const DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;
const MIN_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 15;
const MAX_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

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

function getPassword() {
  return process.env.APP_ACCESS_PASSWORD?.trim() ?? "";
}

function getSigningSecret() {
  return process.env.APP_SESSION_SECRET?.trim() ?? "";
}

function toBase64Url(bytes: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return diff === 0;
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

export function isPasswordAuthConfigured() {
  return Boolean(getPassword() && getSigningSecret());
}

export function verifyPassword(input: string) {
  const password = getPassword();
  if (!password) {
    return false;
  }

  return timingSafeEqual(input, password);
}

export async function createSessionToken(now = Date.now()) {
  const issuedAt = String(now);
  const payload = `v1:${issuedAt}`;
  const signature = await sign(payload);
  return `${payload}.${signature}`;
}

export async function verifySessionToken(token: string | undefined | null, now = Date.now()) {
  if (!token) {
    return false;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return false;
  }

  const [version, issuedAtValue] = payload.split(":");
  const issuedAt = Number(issuedAtValue);
  if (version !== "v1" || !Number.isFinite(issuedAt)) {
    return false;
  }

  const ageSeconds = Math.floor((now - issuedAt) / 1000);
  if (ageSeconds < 0 || ageSeconds > AUTH_COOKIE_MAX_AGE_SECONDS) {
    return false;
  }

  try {
    return timingSafeEqual(signature, await sign(payload));
  } catch {
    return false;
  }
}
