import {
  globalAccessAllows,
  isProjectRole,
  projectRoleAllows,
  type ProjectPermission,
} from "@/lib/access-control";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PROJECT_ID_PATH = "[0-9a-f-]{36}";

export function normalizeAuthorizationPathname(pathname: string) {
  try {
    const normalized = decodeURIComponent(pathname);
    if (
      !normalized.startsWith("/") ||
      normalized.startsWith("//") ||
      /[\u0000-\u001f\u007f]/u.test(normalized)
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

export function projectIdFromAuthorizationPath(pathname: string) {
  const match = pathname.match(
    new RegExp(`^/(?:api/)?projects/(${PROJECT_ID_PATH})(?:/|$)`, "iu"),
  );
  return match?.[1] ?? null;
}

export function requiredProjectPermission(
  method: string,
  pathname: string,
): ProjectPermission {
  if (!pathname.startsWith("/api/")) return "project.read";
  if (SAFE_METHODS.has(method)) {
    if (
      new RegExp(`/documents/${PROJECT_ID_PATH}$`, "iu").test(pathname)
    ) {
      return "document.download";
    }
    return "project.read";
  }
  if (
    new RegExp(
      `^/api/projects/${PROJECT_ID_PATH}/access(?:/|$)`,
      "iu",
    ).test(pathname)
  ) {
    return "project.share";
  }
  if (
    method === "DELETE" &&
    new RegExp(`^/api/projects/${PROJECT_ID_PATH}/?$`, "iu").test(pathname)
  ) {
    return "project.delete";
  }
  return "project.update";
}

export function projectRoleAllowsAuthorizationPath(input: {
  method: string;
  pathname: string;
  role: string | null;
  isAdmin: boolean;
}) {
  const permission = requiredProjectPermission(input.method, input.pathname);
  if (globalAccessAllows(input.isAdmin, permission)) {
    return true;
  }
  return isProjectRole(input.role) && projectRoleAllows(input.role, permission);
}
