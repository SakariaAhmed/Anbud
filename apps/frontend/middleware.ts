import { NextResponse, type NextRequest } from "next/server";

import {
  AUTH_COOKIE_NAME,
  AUTH_VERIFIED_HEADER,
  verifySessionToken,
} from "@/lib/password-auth";

const CURRENT_PATH_HEADER = "x-current-pathname";
const CORRELATION_ID_HEADER = "x-correlation-id";

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
    pathname === "/api/health" ||
    pathname.startsWith("/api/health/") ||
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

function applyResponseHeaders(response: NextResponse, correlationId: string) {
  response.headers.set(CORRELATION_ID_HEADER, correlationId);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
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

function isTrustedOrigin(request: NextRequest) {
  if (SAFE_METHODS.has(request.method) || !request.nextUrl.pathname.startsWith("/api/")) {
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
) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CURRENT_PATH_HEADER, request.nextUrl.pathname);
  requestHeaders.set(CORRELATION_ID_HEADER, correlationId);
  requestHeaders.delete(AUTH_VERIFIED_HEADER);

  if (authenticated) {
    requestHeaders.set(AUTH_VERIFIED_HEADER, "1");
  }

  return applyResponseHeaders(
    NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    }),
    correlationId,
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const correlationId = correlationIdFor(request);
  const authenticated = await verifySessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value);
  const workerToken = process.env.PROJECT_JOB_WORKER_TOKEN?.trim();

  if (!isTrustedOrigin(request)) {
    return forbiddenJson(correlationId);
  }

  if (
    pathname === "/api/project-jobs/worker" &&
    workerToken &&
    timingSafeTokenEqual(request.headers.get("x-worker-token"), workerToken)
  ) {
    return nextWithRequestHeaders(request, true, correlationId);
  }

  if (pathname === "/login" && authenticated) {
    const redirectUrl = localRedirectUrl(request, "/");
    return applyResponseHeaders(NextResponse.redirect(redirectUrl), correlationId);
  }

  if (isPublicPath(pathname)) {
    return nextWithRequestHeaders(request, authenticated, correlationId);
  }

  if (authenticated) {
    return nextWithRequestHeaders(request, true, correlationId);
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
