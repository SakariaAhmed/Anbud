import {
  globalAccessAllows,
  isProjectRole,
  projectRoleAllows,
  type ProjectPermission,
} from "@/lib/access-control";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PROJECT_ID_PATH = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function canonicalProjectId(value: string) {
  return new RegExp(`^${PROJECT_ID_PATH}$`, "iu").test(value)
    ? value.toLowerCase()
    : null;
}

export function normalizeAuthorizationPathname(pathname: string) {
  try {
    if (/%(?:2f|5c)/iu.test(pathname)) return null;
    const normalized = decodeURIComponent(pathname);
    if (
      !normalized.startsWith("/") ||
      normalized.startsWith("//") ||
      /[\u0000-\u001f\u007f]/u.test(normalized)
    ) {
      return null;
    }
    const projectSegment = normalized.match(/^\/(?:api\/)?projects\/([^/]+)(?:\/|$)/iu)?.[1];
    // A dynamic project route must never become an unscoped authenticated route.
    // /projects/new is the sole non-project page below this prefix.
    if (projectSegment && !/^\/projects\/new\/?$/u.test(normalized) && !canonicalProjectId(projectSegment)) {
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
  return match ? canonicalProjectId(match[1]) : null;
}

export function requiredProjectPermission(
  method: string,
  pathname: string,
): ProjectPermission {
  if (!pathname.startsWith("/api/")) return "project.read";
  if (
    method === "POST" &&
    new RegExp(
      `^/api/projects/${PROJECT_ID_PATH}/page-view/?$`,
      "iu",
    ).test(pathname)
  ) {
    return "project.read";
  }
  if (SAFE_METHODS.has(method)) {
    if (
      new RegExp(`^/api/projects/${PROJECT_ID_PATH}/documents/[^/]+/?$`, "iu").test(pathname)
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
