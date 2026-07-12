export function safeRedirectPath(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/";
  }

  try {
    const url = new URL(value, "https://bidsite.local");
    if (url.origin !== "https://bidsite.local") {
      return "/";
    }

    if (
      url.pathname === "/login" ||
      url.pathname.startsWith("/login/") ||
      url.pathname.startsWith("/api/")
    ) {
      return "/";
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
