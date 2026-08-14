import { NextResponse } from "next/server";

import { safeRedirectPath } from "@/lib/auth-redirect";
import {
  AUTH_COOKIE_NAME,
} from "@/lib/password-auth";
import { authenticateGuestCode } from "@/lib/server/access-control-repository";
import { recordActivity } from "@/lib/server/activity";
import { createAppSession } from "@/lib/server/app-sessions";
import { checkRateLimit } from "@/lib/server/observability";

export async function POST(request: Request) {
  const globalLimit = await checkRateLimit(request, "guest-login-global", {
    limit: 80,
    windowMs: 60_000,
    identityMode: "global",
    fallbackLimit: 20,
  });
  const identityLimit = await checkRateLimit(request, "guest-login", {
    limit: 8,
    windowMs: 60_000,
    fallbackLimit: 4,
  });
  if (!globalLimit.allowed || !identityLimit.allowed) {
    const retryAfterSeconds = Math.max(
      globalLimit.retryAfterSeconds,
      identityLimit.retryAfterSeconds,
    );
    return NextResponse.json(
      { error: "For mange kodeforsøk. Vent litt før du prøver igjen." },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown;
    next?: unknown;
  };
  if (typeof body.code !== "string" || body.code.length > 80) {
    return NextResponse.json({ error: "Ugyldig gjestekode." }, { status: 401 });
  }

  const principal = await authenticateGuestCode(body.code);
  if (!principal) {
    await recordActivity({
      action: "auth.guest_code.login",
      result: "denied",
      metadata: { reason: "invalid_or_inactive" },
    });
    return NextResponse.json(
      { error: "Koden er ugyldig, utløpt eller tilbakekalt." },
      { status: 401 },
    );
  }

  const session = await createAppSession({
    principalId: principal.id,
    authMethod: "guest_code",
  });
  const requestPrincipal = {
    id: principal.id,
    identityType: "guest" as const,
    isAdmin: false,
    sessionId: session.sessionId,
  };
  await recordActivity({
    principal: requestPrincipal,
    action: "auth.guest_code.login",
  });

  const response = NextResponse.json({
    ok: true,
    redirectTo: safeRedirectPath(body.next),
  });
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: session.token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: session.maxAgeSeconds,
  });
  return response;
}
