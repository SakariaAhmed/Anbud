import { NextResponse } from "next/server";

import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  createSessionToken,
  isPasswordAuthConfigured,
  verifyPassword,
} from "@/lib/password-auth";
import { checkRateLimit } from "@/lib/server/observability";

function safeRedirectPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  if (value.startsWith("/api/") || value.startsWith("/login")) {
    return "/";
  }

  return value;
}

export async function POST(request: Request) {
  const globalRateLimit = await checkRateLimit(request, "auth-login-global", {
    limit: 40,
    windowMs: 60_000,
    identityMode: "global",
  });
  if (!globalRateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(globalRateLimit.retryAfterSeconds) },
      },
    );
  }

  const rateLimit = await checkRateLimit(request, "auth-login", {
    limit: 8,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  if (!isPasswordAuthConfigured()) {
    return NextResponse.json(
      { error: "Password authentication is not configured." },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    password?: unknown;
    next?: unknown;
  };

  if (typeof body.password !== "string" || !verifyPassword(body.password)) {
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, redirectTo: safeRedirectPath(body.next) });
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: await createSessionToken(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  });

  return response;
}
