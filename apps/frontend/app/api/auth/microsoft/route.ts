import { NextRequest, NextResponse } from "next/server";

import { safeRedirectPath } from "@/lib/auth-redirect";
import {
  MICROSOFT_AUTH_COOKIE_MAX_AGE_SECONDS,
  MICROSOFT_AUTH_COOKIE_PATH,
  MICROSOFT_PKCE_COOKIE_NAME,
  MICROSOFT_STATE_COOKIE_NAME,
  createMicrosoftAuthClient,
  createMicrosoftFlowState,
  isMicrosoftAuthConfigured,
  microsoftCallbackUrl,
  publicAppOrigin,
} from "@/lib/server/microsoft-auth";
import { checkRateLimit } from "@/lib/server/observability";

function loginErrorRedirect(request: Request, code: string, nextPath: string) {
  const url = new URL("/login", publicAppOrigin(request));
  url.searchParams.set("authError", code);
  url.searchParams.set("next", nextPath);
  return NextResponse.redirect(url, 302);
}

export async function GET(request: NextRequest) {
  const nextPath = safeRedirectPath(request.nextUrl.searchParams.get("next"));

  const rateLimit = await checkRateLimit(request, "auth-microsoft", {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return loginErrorRedirect(request, "rate_limited", nextPath);
  }

  if (!isMicrosoftAuthConfigured()) {
    return loginErrorRedirect(request, "microsoft_not_configured", nextPath);
  }

  try {
    const { csrf, nonce, pkce, state } = await createMicrosoftFlowState(nextPath);
    const microsoft = await createMicrosoftAuthClient();
    const url = await microsoft.getAuthCodeUrl({
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
      nonce,
      redirectUri: microsoftCallbackUrl(request),
      responseMode: "query",
      scopes: [],
      state,
    });
    const response = NextResponse.redirect(url, 302);
    const cookieOptions = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: MICROSOFT_AUTH_COOKIE_PATH,
      maxAge: MICROSOFT_AUTH_COOKIE_MAX_AGE_SECONDS,
    };
    response.cookies.set({
      name: MICROSOFT_PKCE_COOKIE_NAME,
      value: pkce.verifier,
      ...cookieOptions,
    });
    response.cookies.set({
      name: MICROSOFT_STATE_COOKIE_NAME,
      value: csrf,
      ...cookieOptions,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("Could not initiate Microsoft authentication.", error);
    return loginErrorRedirect(request, "microsoft_start_failed", nextPath);
  }
}
