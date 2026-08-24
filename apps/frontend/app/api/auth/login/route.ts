import { NextResponse } from "next/server";

import { safeRedirectPath } from "@/lib/auth-redirect";
import {
  AUTH_COOKIE_NAME,
} from "@/lib/password-auth";
import {
  setAdminStatus,
  upsertInternalPrincipal,
} from "@/lib/server/access-control-repository";
import {
  adminDisplayName,
  adminPrincipalId,
  isAdminPasswordAuthConfigured,
  verifyAdminPassword,
} from "@/lib/server/admin-password-auth";
import { recordActivity } from "@/lib/server/activity";
import { createAppSession } from "@/lib/server/app-sessions";
import { checkRateLimit } from "@/lib/server/observability";

export async function POST(request: Request) {
  const globalRateLimit = await checkRateLimit(request, "auth-login-global", {
    limit: 40,
    windowMs: 60_000,
    identityMode: "global",
    fallbackLimit: 10,
  });
  if (!globalRateLimit.allowed) {
    return NextResponse.json(
      { error: "For mange innloggingsforsøk. Prøv igjen om litt." },
      {
        status: 429,
        headers: { "Retry-After": String(globalRateLimit.retryAfterSeconds) },
      },
    );
  }

  const rateLimit = await checkRateLimit(request, "auth-login", {
    limit: 8,
    windowMs: 60_000,
    fallbackLimit: 4,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "For mange innloggingsforsøk. Prøv igjen om litt." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  if (!isAdminPasswordAuthConfigured()) {
    return NextResponse.json(
      { error: "Innlogging med tilgangspassord er ikke konfigurert." },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    password?: unknown;
    next?: unknown;
  };

  if (
    typeof body.password !== "string" ||
    !(await verifyAdminPassword(body.password))
  ) {
    return NextResponse.json({ error: "Feil tilgangspassord." }, { status: 401 });
  }

  const principal = await upsertInternalPrincipal({
    candidateId: adminPrincipalId(),
    displayName: adminDisplayName(),
    email: null,
  });
  await setAdminStatus({
    principalId: principal.id,
    isAdmin: true,
    grantedBy: principal.id,
  });
  const session = await createAppSession({
    principalId: principal.id,
    authMethod: "admin_password",
  });
  await recordActivity({
    principal: {
      id: principal.id,
      identityType: "internal",
      isAdmin: true,
      sessionId: session.sessionId,
    },
    action: "auth.admin_password.login",
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
