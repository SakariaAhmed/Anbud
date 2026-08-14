import { NextResponse } from "next/server";

import { AUTH_COOKIE_NAME } from "@/lib/password-auth";
import { recordActivity } from "@/lib/server/activity";
import { revokeAppSession } from "@/lib/server/app-sessions";
import { requireRequestPrincipal } from "@/lib/server/authorization";

export async function POST() {
  const principal = await requireRequestPrincipal().catch(() => null);
  if (principal) {
    await revokeAppSession(principal.sessionId);
    await recordActivity({ principal, action: "auth.logout" });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return response;
}
