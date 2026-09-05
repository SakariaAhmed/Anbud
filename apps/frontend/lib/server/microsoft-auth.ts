import "server-only";

import { randomUUID } from "node:crypto";

import {
  ConfidentialClientApplication,
  CryptoProvider,
  LogLevel,
} from "@azure/msal-node";

export const MICROSOFT_PKCE_COOKIE_NAME = "bidsite_microsoft_pkce";
export const MICROSOFT_STATE_COOKIE_NAME = "bidsite_microsoft_state";
export const MICROSOFT_NONCE_COOKIE_NAME = "bidsite_microsoft_nonce";
export const MICROSOFT_AUTH_COOKIE_PATH = "/api/auth/microsoft";
export const MICROSOFT_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 10;

type MicrosoftFlowState = {
  csrf: string;
  next: string;
};

let authorityMetadataCache:
  | {
      url: string;
      promise: Promise<string>;
    }
  | undefined;

function configuredPublicOrigin() {
  const value = process.env.APP_PUBLIC_ORIGIN?.trim();
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.hostname === "localhost") {
      return url.origin;
    }
  } catch {
    return null;
  }

  return null;
}

function configuredAuthority() {
  const tenantSubdomain = process.env.MICROSOFT_ENTRA_TENANT_SUBDOMAIN?.trim();
  if (!tenantSubdomain || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(tenantSubdomain)) {
    return null;
  }

  return new URL(
    `https://${tenantSubdomain}.ciamlogin.com/${tenantSubdomain}.onmicrosoft.com/`,
  );
}

function configuredCredentials() {
  const clientId = process.env.MICROSOFT_ENTRA_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_ENTRA_CLIENT_SECRET?.trim();
  const authority = configuredAuthority();

  if (!clientId || !clientSecret || !authority) {
    return null;
  }

  const tenantSubdomain = process.env.MICROSOFT_ENTRA_TENANT_SUBDOMAIN?.trim();
  if (!tenantSubdomain) {
    return null;
  }

  return {
    authority,
    authorityMetadataUrl: new URL(
      `/${tenantSubdomain}.onmicrosoft.com/v2.0/.well-known/openid-configuration`,
      authority,
    ).toString(),
    clientId,
    clientSecret,
  };
}

export function isMicrosoftAuthConfigured() {
  return Boolean(
    configuredCredentials() &&
      process.env.APP_SESSION_SECRET?.trim() &&
      (process.env.NODE_ENV !== "production" || configuredPublicOrigin()),
  );
}

export function publicAppOrigin(request: Request) {
  const configuredOrigin = configuredPublicOrigin();
  if (configuredOrigin) {
    return configuredOrigin;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_PUBLIC_ORIGIN must be configured in production.");
  }

  return new URL(request.url).origin;
}

export function microsoftCallbackUrl(request: Request) {
  return new URL(
    "/api/auth/microsoft/callback",
    publicAppOrigin(request),
  ).toString();
}

async function getAuthorityMetadata(url: string) {
  if (!authorityMetadataCache || authorityMetadataCache.url !== url) {
    authorityMetadataCache = {
      url,
      promise: fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error("Could not resolve Microsoft Entra authority metadata.");
        }
        return JSON.stringify(await response.json());
      }),
    };
  }

  const pending = authorityMetadataCache;
  try {
    return await pending.promise;
  } catch (error) {
    // A transient discovery failure must not poison every later login on this replica.
    if (authorityMetadataCache === pending) authorityMetadataCache = undefined;
    throw error;
  }
}

export function reportMicrosoftAuthFailure(
  stage: "start" | "token" | "identity" | "session" | "activity",
  error: unknown,
) {
  const reference = randomUUID();
  const code = error && typeof error === "object" && "errorCode" in error
    ? error.errorCode
    : error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  console.error(JSON.stringify({
    event: "microsoft_auth_failed",
    stage,
    reference,
    errorCode: typeof code === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(code)
      ? code
      : "internal_error",
  }));
  return reference;
}

export async function createMicrosoftAuthClient() {
  const credentials = configuredCredentials();
  if (!credentials) {
    throw new Error("Microsoft Entra ID authentication is not configured.");
  }

  return new ConfidentialClientApplication({
    auth: {
      authority: credentials.authority.toString(),
      authorityMetadata: await getAuthorityMetadata(
        credentials.authorityMetadataUrl,
      ),
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      knownAuthorities: [credentials.authority.hostname],
    },
    system: {
      loggerOptions: {
        loggerCallback(level, message, containsPii) {
          if (!containsPii && level <= LogLevel.Warning) {
            console.warn(message);
          }
        },
        logLevel: LogLevel.Warning,
        piiLoggingEnabled: false,
      },
    },
  });
}

export async function createMicrosoftFlowState(nextPath: string) {
  const cryptoProvider = new CryptoProvider();
  const csrf = cryptoProvider.createNewGuid();
  const nonce = cryptoProvider.createNewGuid();
  const pkce = await cryptoProvider.generatePkceCodes();
  const state = Buffer.from(
    JSON.stringify({ csrf, next: nextPath } satisfies MicrosoftFlowState),
  ).toString("base64url");

  return { csrf, nonce, pkce, state };
}

export function parseMicrosoftFlowState(value: string | null) {
  if (!value || value.length > 2_048) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<MicrosoftFlowState>;
    if (typeof parsed.csrf !== "string" || typeof parsed.next !== "string") {
      return null;
    }
    return { csrf: parsed.csrf, next: parsed.next };
  } catch {
    return null;
  }
}
