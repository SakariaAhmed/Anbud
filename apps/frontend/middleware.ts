import { NextResponse, type NextRequest } from "next/server";

import {
  AUTH_COOKIE_NAME,
  AUTH_VERIFIED_HEADER,
  verifySessionToken,
} from "@/lib/password-auth";

export const CURRENT_PATH_HEADER = "x-current-pathname";

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
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function unauthorizedJson() {
  return NextResponse.json({ error: "Authentication required." }, { status: 401 });
}

function forbiddenJson() {
  return NextResponse.json({ error: "Forbidden request origin." }, { status: 403 });
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

function nextWithRequestHeaders(request: NextRequest, authenticated: boolean) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CURRENT_PATH_HEADER, request.nextUrl.pathname);
  requestHeaders.delete(AUTH_VERIFIED_HEADER);

  if (authenticated) {
    requestHeaders.set(AUTH_VERIFIED_HEADER, "1");
  }

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authenticated = await verifySessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value);
  const workerToken = process.env.PROJECT_JOB_WORKER_TOKEN?.trim();

  if (!isTrustedOrigin(request)) {
    return forbiddenJson();
  }

  if (
    pathname === "/api/project-jobs/worker" &&
    workerToken &&
    request.headers.get("x-worker-token") === workerToken
  ) {
    return nextWithRequestHeaders(request, true);
  }

  if (pathname === "/login" && authenticated) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  if (isPublicPath(pathname)) {
    return nextWithRequestHeaders(request, authenticated);
  }

  if (authenticated) {
    return nextWithRequestHeaders(request, true);
  }

  if (pathname.startsWith("/api/")) {
    return unauthorizedJson();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!.*\\..*).*)", "/api/:path*"],
};
