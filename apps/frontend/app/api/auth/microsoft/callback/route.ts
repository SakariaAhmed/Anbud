import { NextRequest, NextResponse } from "next/server";

import { safeRedirectPath } from "@/lib/auth-redirect";
import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  createUserSessionToken,
  deriveOwnerId,
} from "@/lib/password-auth";
import {
  MICROSOFT_AUTH_COOKIE_PATH,
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
  if (
    !isMicrosoftAuthConfigured() ||
    !flowState ||
    !timingSafeEqual(expectedCsrf, flowState.csrf) ||
    !code ||
    !codeVerifier
  ) {
    return redirectToLogin(request, "microsoft_callback_invalid", nextPath);
  }

  try {
    const microsoft = await createMicrosoftAuthClient();
    const result = await microsoft.acquireTokenByCode({
      code,
      codeVerifier,
      redirectUri: microsoftCallbackUrl(request),
      scopes: [],
    });

    if (!result?.account || !result.idToken) {
      return redirectToLogin(request, "microsoft_callback_failed", nextPath);
    }

    const response = NextResponse.redirect(
      new URL(nextPath, publicAppOrigin(request)),
      302,
    );
    response.cookies.set({
      name: AUTH_COOKIE_NAME,
      value: await createUserSessionToken(
        await deriveOwnerId(result.account.localAccountId || result.account.homeAccountId),
        result.account.name || "Bidsite-bruker",
      ),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
    });
    clearMicrosoftFlowCookies(response);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("Could not complete Microsoft authentication.", error);
    return redirectToLogin(request, "microsoft_callback_failed", nextPath);
  }
}
