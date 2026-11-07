import { NextResponse } from "next/server";

import { AUTH_COOKIE_NAME } from "@/lib/password-auth";
import { recordActivity } from "@/lib/server/activity";
import { revokeAppSession } from "@/lib/server/app-sessions";
import { AuthorizationError, authorizationErrorResponse, requireRequestPrincipal } from "@/lib/server/authorization";

export async function POST() {
  try {
    let principal;
    try {
      principal = await requireRequestPrincipal();
    } catch (error) {
      // An absent, revoked or expired session is already signed out. An outage
      // must retain the cookie so a retry can still revoke that server session.
      if (!(error instanceof AuthorizationError) || error.status !== 401) throw error;
    }
    if (principal) {
      await revokeAppSession(principal.sessionId);
      await recordActivity({ principal, action: "auth.logout" });
    }
  } catch (error) {
    const response = authorizationErrorResponse(error);
    if (response) return response;
    throw error;
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
