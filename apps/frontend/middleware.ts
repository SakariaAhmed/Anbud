import {
  NextResponse,
  type NextFetchEvent,
  type NextRequest,
} from "next/server";

import {
  dataApiConfiguration,
  dataApiHeaders,
} from "@/lib/data-api-config";

import {
  AUTH_COOKIE_NAME,
  AUTH_DISPLAY_NAME_HEADER,
  AUTH_IS_ADMIN_HEADER,
  AUTH_IDENTITY_TYPE_HEADER,
  AUTH_PRINCIPAL_HEADER,
  AUTH_SESSION_HEADER,
  AUTH_VERIFIED_HEADER,
  databaseSessionTokenHmac,
  parseDatabaseSessionToken,
} from "@/lib/password-auth";
import {
  normalizeAuthorizationPathname,
  projectIdFromAuthorizationPath,
  projectRoleAllowsAuthorizationPath,
} from "@/lib/middleware-project-authorization";

const CURRENT_PATH_HEADER = "x-current-pathname";
const CORRELATION_ID_HEADER = "x-correlation-id";
const NONCE_HEADER = "x-nonce";

function createNonce() {
  return btoa(crypto.randomUUID());
}

function contentSecurityPolicy(nonce: string) {
  const scriptSrc =
    process.env.NODE_ENV === "production"
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' blob:`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' blob:`;

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "media-src 'self' blob: data:",
  ].join("; ");
}

const PUBLIC_PATH_PREFIXES = [
  "/_next",
  "/favicon.ico",
  "/bidsite-logo.png",
];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function firstForwardedHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

function originFromHostAndProtocol(host: string, protocol: string) {
  const normalizedHost = host.trim();
  if (!normalizedHost) {
    return "";
  }

  const normalizedProtocol = protocol.trim().replace(/:$/, "") || "https";
  return `${normalizedProtocol}://${normalizedHost}`;
}

function configuredTrustedOrigins() {
  return [
    process.env.APP_PUBLIC_ORIGIN,
    process.env.APP_ALLOWED_ORIGINS,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function forwardedOriginCandidates(request: NextRequest) {
  const forwardedHost = firstForwardedHeaderValue(
    request.headers.get("x-forwarded-host"),
  );
  const forwardedProtocol =
    firstForwardedHeaderValue(request.headers.get("x-forwarded-proto")) ||
    request.nextUrl.protocol.replace(/:$/, "") ||
    "https";
  const host = firstForwardedHeaderValue(request.headers.get("host"));

  return [
    request.nextUrl.origin,
    originFromHostAndProtocol(host, forwardedProtocol),
    originFromHostAndProtocol(forwardedHost, forwardedProtocol),
    ...configuredTrustedOrigins(),
  ].filter(Boolean);
}

function isPublicPath(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/guest" ||
    (pathname === "/api/auth/microsoft" ||
      pathname.startsWith("/api/auth/microsoft/")) ||
    pathname === "/api/health/live" ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function isValidCorrelationId(value: string | null) {
  return Boolean(value && /^[a-zA-Z0-9_.:-]{8,128}$/.test(value));
}

function correlationIdFor(request: NextRequest) {
  const incoming = request.headers.get(CORRELATION_ID_HEADER);
  if (isValidCorrelationId(incoming)) {
    return incoming as string;
  }

  return crypto.randomUUID();
}

function applyResponseHeaders(
  response: NextResponse,
  correlationId: string,
  nonce = createNonce(),
) {
  response.headers.set(CORRELATION_ID_HEADER, correlationId);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );

  if (process.env.NODE_ENV === "production") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  return response;
}

function localRedirectUrl(request: NextRequest, pathname: string) {
  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = pathname.startsWith("/") && !pathname.startsWith("//")
    ? pathname
    : "/";
  redirectUrl.search = "";
  redirectUrl.hash = "";
  return redirectUrl;
}

function safeNextPath(pathname: string, search: string) {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    return "/";
  }

  const nextPath = `${pathname}${search}`;
  return nextPath.startsWith("//") ? "/" : nextPath;
}

function unauthorizedJson(correlationId: string) {
  return applyResponseHeaders(
    NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    correlationId,
  );
}

function forbiddenJson(correlationId: string) {
  return applyResponseHeaders(
    NextResponse.json({ error: "Forbidden request origin." }, { status: 403 }),
    correlationId,
  );
}

function invalidPathJson(correlationId: string) {
  return applyResponseHeaders(
    NextResponse.json({ error: "Invalid request path." }, { status: 400 }),
    correlationId,
  );
}

type MiddlewareIdentity = {
  principalId: string;
  identityType: "internal" | "guest";
  displayName: string | null;
  isAdmin: boolean;
  sessionId: string | null;
};

async function resolveDatabaseSession(
  sessionToken: string | undefined,
): Promise<MiddlewareIdentity | null> {
  const parsed = parseDatabaseSessionToken(sessionToken);
  const configuration = dataApiConfiguration();
  if (!parsed || !configuration) return null;
  const response = await fetch(
    `${configuration.baseUrl}/rpc/resolve_app_session`,
    {
      method: "POST",
      headers: dataApiHeaders(configuration.serviceKey),
      body: JSON.stringify({
        p_session_id: parsed.sessionId,
        p_token_hmac: await databaseSessionTokenHmac(
          parsed.sessionId,
          parsed.secret,
        ),
      }),
      cache: "no-store",
    },
  );
  if (!response.ok) return null;
  const rows = (await response.json()) as Array<{
    session_id: string;
    principal_id: string;
    identity_type: "internal" | "guest";
    display_name: string | null;
    global_roles: string[] | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    principalId: row.principal_id,
    identityType: row.identity_type,
    displayName: row.display_name,
    isAdmin: row.global_roles?.includes("admin") ?? false,
    sessionId: row.session_id,
  };
}

async function resolveProjectRole(
  projectId: string,
  identity: MiddlewareIdentity,
) {
  const configuration = dataApiConfiguration();
  if (!configuration) return null;
  const response = await fetch(
    `${configuration.baseUrl}/rpc/resolve_project_role`,
    {
      method: "POST",
      headers: dataApiHeaders(configuration.serviceKey),
      body: JSON.stringify({
        p_principal_id: identity.principalId,
        p_project_id: projectId,
      }),
      cache: "no-store",
    },
  );
  if (!response.ok) return null;
  return (await response.json()) as string | null;
}

async function recordRequestActivity(
  request: NextRequest,
  identity: MiddlewareIdentity,
  correlationId: string,
  projectId: string | null,
  pathname: string,
  result: "ok" | "denied" = "ok",
) {
  const configuration = dataApiConfiguration();
  if (!configuration) return;
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/health") ||
    pathname === "/favicon.ico"
  ) {
    return;
  }
  const segments = pathname.split("/").filter(Boolean);
  const documentIndex = segments.indexOf("documents");
  const entityId =
    documentIndex >= 0 &&
    /^[0-9a-f-]{36}$/iu.test(segments[documentIndex + 1] ?? "")
      ? segments[documentIndex + 1]
      : null;
  await fetch(`${configuration.baseUrl}/activity_events`, {
    method: "POST",
    headers: {
      ...dataApiHeaders(configuration.serviceKey),
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      actor_principal_id: identity.principalId,
      actor_session_id: identity.sessionId,
      action: `request.${request.method.toLocaleLowerCase("en-US")}`,
      result,
      project_id: projectId,
      entity_type: entityId ? "document" : projectId ? "project" : "route",
      entity_id: entityId ?? projectId,
      request_id: correlationId,
      metadata: {
        path: pathname.slice(0, 500),
        method: request.method,
      },
    }),
    cache: "no-store",
  }).catch(() => undefined);
}

async function resolveIdentity(sessionToken: string | undefined) {
  return resolveDatabaseSession(sessionToken);
}

function projectNotFoundResponse(
  request: NextRequest,
  correlationId: string,
  pathname: string,
) {
  return pathname.startsWith("/api/")
    ? applyResponseHeaders(
        NextResponse.json({ error: "Project not found." }, { status: 404 }),
        correlationId,
      )
    : applyResponseHeaders(
        NextResponse.redirect(localRedirectUrl(request, "/")),
        correlationId,
      );
}

function isTrustedOrigin(request: NextRequest, pathname: string) {
  if (SAFE_METHODS.has(request.method) || !pathname.startsWith("/api/")) {
    return true;
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }

  try {
    const requestOrigin = new URL(origin).origin;
    return forwardedOriginCandidates(request).some(
      (candidate) => new URL(candidate).origin === requestOrigin,
    );
  } catch {
    return false;
  }
}

function timingSafeTokenEqual(left: string | null, right: string) {
  if (!left || left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < right.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return diff === 0;
}

function nextWithRequestHeaders(
  request: NextRequest,
  authenticated: boolean,
  correlationId: string,
  pathname: string,
  identity?: MiddlewareIdentity | null,
) {
  const nonce = createNonce();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CURRENT_PATH_HEADER, pathname);
  requestHeaders.set(CORRELATION_ID_HEADER, correlationId);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  requestHeaders.delete(AUTH_VERIFIED_HEADER);
  requestHeaders.delete(AUTH_DISPLAY_NAME_HEADER);
  requestHeaders.delete(AUTH_PRINCIPAL_HEADER);
  requestHeaders.delete(AUTH_IDENTITY_TYPE_HEADER);
  requestHeaders.delete(AUTH_IS_ADMIN_HEADER);
  requestHeaders.delete(AUTH_SESSION_HEADER);

  if (authenticated && identity) {
    requestHeaders.set(AUTH_VERIFIED_HEADER, "1");
    requestHeaders.set(AUTH_PRINCIPAL_HEADER, identity.principalId);
    requestHeaders.set(AUTH_IDENTITY_TYPE_HEADER, identity.identityType);
    requestHeaders.set(AUTH_IS_ADMIN_HEADER, identity.isAdmin ? "1" : "0");
    if (identity.sessionId) {
      requestHeaders.set(AUTH_SESSION_HEADER, identity.sessionId);
    }
    if (identity.displayName) {
      requestHeaders.set(AUTH_DISPLAY_NAME_HEADER, identity.displayName);
    }
  }

  return applyResponseHeaders(
    NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    }),
    correlationId,
    nonce,
  );
}

export async function middleware(request: NextRequest, event: NextFetchEvent) {
  const correlationId = correlationIdFor(request);
  const pathname = normalizeAuthorizationPathname(request.nextUrl.pathname);
  if (!pathname) {
    return invalidPathJson(correlationId);
  }
  const sessionToken = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const identity = await resolveIdentity(sessionToken);
  const authenticated = Boolean(identity);
  const workerToken = process.env.PROJECT_JOB_WORKER_TOKEN?.trim();

  if (!isTrustedOrigin(request, pathname)) {
    return forbiddenJson(correlationId);
  }

  if (
    pathname === "/api/project-jobs/worker" &&
    workerToken &&
    timingSafeTokenEqual(request.headers.get("x-worker-token"), workerToken)
  ) {
    return nextWithRequestHeaders(request, true, correlationId, pathname);
  }

  if (pathname === "/login" && authenticated) {
    const redirectUrl = localRedirectUrl(request, "/");
    return applyResponseHeaders(NextResponse.redirect(redirectUrl), correlationId);
  }

  if (isPublicPath(pathname)) {
    return nextWithRequestHeaders(
      request,
      authenticated,
      correlationId,
      pathname,
      identity,
    );
  }

  if (authenticated) {
    if (
      identity?.identityType === "guest" &&
      (pathname === "/projects/new" ||
        pathname.startsWith("/service-descriptions") ||
        pathname.startsWith("/api/service-descriptions"))
    ) {
      await recordRequestActivity(
        request,
        identity,
        correlationId,
        projectIdFromAuthorizationPath(pathname),
        pathname,
        "denied",
      );
      return pathname.startsWith("/api/")
        ? projectNotFoundResponse(request, correlationId, pathname)
        : applyResponseHeaders(
            NextResponse.redirect(localRedirectUrl(request, "/")),
            correlationId,
          );
    }
    const projectId = projectIdFromAuthorizationPath(pathname);
    if (projectId && identity) {
      const role = await resolveProjectRole(projectId, identity);
      if (
        !projectRoleAllowsAuthorizationPath({
          method: request.method,
          pathname,
          role,
          isAdmin: identity.isAdmin,
        })
      ) {
        await recordRequestActivity(
          request,
          identity,
          correlationId,
          projectId,
          pathname,
          "denied",
        );
        return projectNotFoundResponse(request, correlationId, pathname);
      }
    }
    if (identity) {
      event.waitUntil(
        recordRequestActivity(
          request,
          identity,
          correlationId,
          projectId,
          pathname,
        ),
      );
    }
    return nextWithRequestHeaders(
      request,
      true,
      correlationId,
      pathname,
      identity,
    );
  }

  if (pathname.startsWith("/api/")) {
    return unauthorizedJson(correlationId);
  }

  const loginUrl = localRedirectUrl(request, "/login");
  loginUrl.searchParams.set("next", safeNextPath(pathname, request.nextUrl.search));
  return applyResponseHeaders(NextResponse.redirect(loginUrl), correlationId);
}

export const config = {
  matcher: ["/((?!.*\\..*).*)", "/api/:path*"],
};
