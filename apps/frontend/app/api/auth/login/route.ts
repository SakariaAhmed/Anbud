import { NextResponse } from "next/server";

import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  createSessionToken,
  isPasswordAuthConfigured,
  verifyPassword,
} from "@/lib/password-auth";

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
  if (!isPasswordAuthConfigured()) {
    return NextResponse.json(
      { error: "APP_ACCESS_PASSWORD is not configured." },
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
