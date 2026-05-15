import { NextResponse, type NextRequest } from "next/server";

import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/password-auth";

const PUBLIC_PATH_PREFIXES = [
  "/_next",
  "/favicon.ico",
  "/bidsite-logo.png",
];

function isPublicPath(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/api/auth/login" ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function unauthorizedJson() {
  return NextResponse.json({ error: "Authentication required." }, { status: 401 });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authenticated = await verifySessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value);

  if (pathname === "/login" && authenticated) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (authenticated) {
    return NextResponse.next();
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
