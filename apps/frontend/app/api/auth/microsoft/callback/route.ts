import { NextRequest, NextResponse } from "next/server";

import { safeRedirectPath } from "@/lib/auth-redirect";
import {
  AUTH_COOKIE_NAME,
  deriveOwnerId,
} from "@/lib/password-auth";
import { upsertInternalPrincipal } from "@/lib/server/access-control-repository";
import { recordActivity } from "@/lib/server/activity";
import { createAppSession } from "@/lib/server/app-sessions";
import {
  MICROSOFT_AUTH_COOKIE_PATH,
  MICROSOFT_NONCE_COOKIE_NAME,
  MICROSOFT_PKCE_COOKIE_NAME,
  MICROSOFT_STATE_COOKIE_NAME,
  createMicrosoftAuthClient,
  isMicrosoftAuthConfigured,
  microsoftCallbackUrl,
  parseMicrosoftFlowState,
  publicAppOrigin,
} from "@/lib/server/microsoft-auth";

function clearMicrosoftFlowCookies(response: NextResponse) {
  for (const name of [
    MICROSOFT_PKCE_COOKIE_NAME,
    MICROSOFT_STATE_COOKIE_NAME,
    MICROSOFT_NONCE_COOKIE_NAME,
  ]) {
    response.cookies.set({
      name,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: MICROSOFT_AUTH_COOKIE_PATH,
      maxAge: 0,
    });
  }
}

function redirectToLogin(request: Request, code: string, nextPath = "/") {
  const url = new URL("/login", publicAppOrigin(request));
  url.searchParams.set("authError", code);
  url.searchParams.set("next", safeRedirectPath(nextPath));
  const response = NextResponse.redirect(url, 302);
  clearMicrosoftFlowCookies(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function timingSafeEqual(left: string | undefined, right: string) {
  if (!left || left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < right.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export async function GET(request: NextRequest) {
  const stateValue = request.nextUrl.searchParams.get("state");
  const flowState = parseMicrosoftFlowState(stateValue);
  const nextPath = safeRedirectPath(flowState?.next);

  if (request.nextUrl.searchParams.has("error")) {
    return redirectToLogin(request, "microsoft_cancelled", nextPath);
  }

  const code = request.nextUrl.searchParams.get("code");
  const codeVerifier = request.cookies.get(MICROSOFT_PKCE_COOKIE_NAME)?.value;
  const expectedCsrf = request.cookies.get(MICROSOFT_STATE_COOKIE_NAME)?.value;
  const expectedNonce = request.cookies.get(MICROSOFT_NONCE_COOKIE_NAME)?.value;
  if (
    !isMicrosoftAuthConfigured() ||
    !flowState ||
    !timingSafeEqual(expectedCsrf, flowState.csrf) ||
    !code ||
    !codeVerifier ||
    !expectedNonce
  ) {
    return redirectToLogin(request, "microsoft_callback_invalid", nextPath);
  }

  try {
    const microsoft = await createMicrosoftAuthClient();
    const result = await microsoft.acquireTokenByCode(
      {
        code,
        codeVerifier,
        redirectUri: microsoftCallbackUrl(request),
        scopes: [],
      },
      {
        code,
        state: stateValue ?? "",
        nonce: expectedNonce,
      },
    );

    if (!result?.account || !result.idToken) {
      return redirectToLogin(request, "microsoft_callback_failed", nextPath);
    }

    const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
    const emailCandidate = [
      claims.email,
      claims.preferred_username,
      result.account.username,
    ].find(
      (value): value is string =>
        typeof value === "string" && value.includes("@"),
    );
    const principal = await upsertInternalPrincipal({
      candidateId: await deriveOwnerId(
        result.account.localAccountId || result.account.homeAccountId,
      ),
      displayName: result.account.name || "Bidsite-bruker",
      email: emailCandidate ?? null,
    });
    const session = await createAppSession({
      principalId: principal.id,
      authMethod: "entra",
    });
    await recordActivity({
      principal: {
        id: principal.id,
        identityType: "internal",
        isAdmin: false,
        sessionId: session.sessionId,
      },
      action: "auth.entra.login",
    });
    const response = NextResponse.redirect(
      new URL(nextPath, publicAppOrigin(request)),
      302,
    );
    response.cookies.set({
      name: AUTH_COOKIE_NAME,
      value: session.token,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: session.maxAgeSeconds,
    });
    clearMicrosoftFlowCookies(response);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("Could not complete Microsoft authentication.", error);
    return redirectToLogin(request, "microsoft_callback_failed", nextPath);
  }
}
