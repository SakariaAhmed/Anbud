import "server-only";

import { headers } from "next/headers";
import { NextResponse } from "next/server";

import {
  PROJECT_ROLE_PERMISSIONS,
  globalAccessAllows,
  effectiveProjectPermissions,
  isIdentityType,
  isProjectRole,
  projectRoleAllows,
  type IdentityType,
  type ProjectPermission,
  type ProjectRole,
} from "@/lib/access-control";
import {
  AUTH_PRINCIPAL_HEADER,
  AUTH_SESSION_HEADER,
} from "@/lib/password-auth";
import { canonicalProjectId } from "@/lib/middleware-project-authorization";
import { isRecord } from "@/lib/unknown-values";
import { AuthBackendError } from "@/lib/server/auth-failure";
import { createServiceClient } from "@/lib/server/data-api";

export type RequestPrincipal = {
  id: string;
  identityType: IdentityType;
  isAdmin: boolean;
  sessionId: string | null;
};

export type AuthorizedProjectContext = {
  principal: RequestPrincipal;
  projectId: string;
  effectiveRole: ProjectRole | "admin";
  permissions: readonly ProjectPermission[];
};

export class AuthorizationError extends Error {
  readonly status: 401 | 403 | 404;

  constructor(message: string, status: 401 | 403 | 404 = 403) {
    super(message);
    this.name = "AuthorizationError";
    this.status = status;
  }
}

async function validatePrincipalFromDatabase(input: {
  principalId: string;
  sessionId: string | null;
}) {
  const dataApi = createServiceClient();
  if (input.sessionId) {
    const { data: session, error } = await dataApi
      .from("app_sessions")
      .select("id, principal_id, expires_at, revoked_at")
      .eq("id", input.sessionId)
      .eq("principal_id", input.principalId)
      .maybeSingle<{
        id: string;
        principal_id: string;
        expires_at: string;
        revoked_at: string | null;
      }>();
    if (error) throw new AuthBackendError("session", error);
    if (session === null) {
      throw new AuthorizationError("Økten er utløpt eller tilbakekalt.", 401);
    }
    if (
      !isRecord(session) ||
      session.id !== input.sessionId ||
      session.principal_id !== input.principalId ||
      typeof session.expires_at !== "string" ||
      !Number.isFinite(Date.parse(session.expires_at)) ||
      (session.revoked_at !== null && typeof session.revoked_at !== "string")
    ) {
      throw new AuthBackendError("session", { code: "invalid_shape" });
    }
    if (
      session.revoked_at ||
      new Date(session.expires_at).getTime() <= Date.now()
    ) {
      throw new AuthorizationError("Økten er utløpt eller tilbakekalt.", 401);
    }
  }

  const [{ data: principal, error: principalError }, { data: roleRows, error: roleError }] =
    await Promise.all([
      dataApi
        .from("app_principals")
        .select("id, identity_type, disabled_at")
        .eq("id", input.principalId)
        .maybeSingle<{
          id: string;
          identity_type: string;
          disabled_at: string | null;
        }>(),
      dataApi
        .from("app_principal_roles")
        .select("role")
        .eq("principal_id", input.principalId),
    ]);
  if (principalError) throw new AuthBackendError("principal", principalError);
  if (roleError) throw new AuthBackendError("global_roles", roleError);
  if (principal === null) {
    throw new AuthorizationError("Brukeren er ikke aktiv.", 401);
  }
  if (
    !isRecord(principal) ||
    principal.id !== input.principalId ||
    !isIdentityType(principal.identity_type) ||
    (principal.disabled_at !== null && typeof principal.disabled_at !== "string")
  ) {
    throw new AuthBackendError("principal", { code: "invalid_shape" });
  }
  if (!Array.isArray(roleRows) || !roleRows.every((row) => isRecord(row) && typeof row.role === "string")) {
    throw new AuthBackendError("global_roles", { code: "invalid_shape" });
  }
  if (principal.disabled_at) {
    throw new AuthorizationError("Brukeren er ikke aktiv.", 401);
  }

  return {
    identityType: principal.identity_type,
    isAdmin: roleRows.some((row) => row.role === "admin"),
  };
}

export async function requireRequestPrincipal(): Promise<RequestPrincipal> {
  const requestHeaders = await headers();
  const principalId = requestHeaders.get(AUTH_PRINCIPAL_HEADER);
  const sessionId = requestHeaders.get(AUTH_SESSION_HEADER);
  if (!principalId || !sessionId) {
    throw new AuthorizationError("Innlogging kreves.", 401);
  }
  const databaseIdentity = await validatePrincipalFromDatabase({
    principalId,
    sessionId,
  });
  return {
    id: principalId,
    identityType: databaseIdentity.identityType,
    isAdmin: databaseIdentity.isAdmin,
    sessionId,
  };
}

export async function getEffectiveProjectRole(
  principalId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  // Reuse the same database owner as middleware. One statement evaluates direct
  // grants, group grants and legacy ownership against a single current snapshot.
  const { data, error } = await createServiceClient().rpc("resolve_project_role", {
    p_principal_id: principalId,
    p_project_id: projectId,
  });
  if (error) {
    throw new AuthBackendError("project_role", error);
  }
  if (data === null) return null;
  if (!isProjectRole(data)) {
    throw new AuthBackendError("project_role", { code: "invalid_shape" });
  }
  return data;
}

export async function requireProjectPermission(
  projectId: string,
  permission: ProjectPermission,
): Promise<AuthorizedProjectContext> {
  const canonicalId = canonicalProjectId(projectId);
  if (!canonicalId) {
    throw new AuthorizationError("Ugyldig prosjekt-ID.", 404);
  }
  projectId = canonicalId;
  const principal = await requireRequestPrincipal();
  const effectiveRole = await getEffectiveProjectRole(principal.id, projectId);
  if (globalAccessAllows(principal.isAdmin, permission)) {
    const permissions = effectiveProjectPermissions(principal.isAdmin, effectiveRole);
    return { principal, projectId, effectiveRole: "admin", permissions };
  }

  if (!effectiveRole || !projectRoleAllows(effectiveRole, permission)) {
    throw new AuthorizationError("Du har ikke tilgang til denne handlingen.");
  }
  return {
    principal,
    projectId,
    effectiveRole,
    permissions: PROJECT_ROLE_PERMISSIONS[effectiveRole],
  };
}

export async function requireAdmin() {
  const principal = await requireRequestPrincipal();
  if (!principal.isAdmin) {
    throw new AuthorizationError("Administratortilgang kreves.");
  }
  return principal;
}

export function authorizationErrorResponse(error: unknown) {
  if (error instanceof AuthBackendError) {
    return NextResponse.json(
      { error: error.message, reference: error.reference },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof AuthorizationError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  }
  return null;
}

const ACCESS_PAGE_SIZE = 500;

async function readAccessIds(
  field: "id" | "project_id" | "group_id",
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: unknown;
    error: unknown;
  }>,
) {
  const ids: string[] = [];
  for (let offset = 0; ; offset += ACCESS_PAGE_SIZE) {
    const { data, error } = await fetchPage(offset, offset + ACCESS_PAGE_SIZE - 1);
    if (error) throw new AuthBackendError("project_access_list", error);
    if (!Array.isArray(data)) {
      throw new AuthBackendError("project_access_list", { code: "invalid_shape" });
    }
    for (const row of data) {
      if (!isRecord(row) || typeof row[field] !== "string") {
        throw new AuthBackendError("project_access_list", { code: "invalid_shape" });
      }
      ids.push(row[field]);
    }
    if (data.length < ACCESS_PAGE_SIZE) return ids;
  }
}

export async function listAccessibleProjectIds(
  principalId: string,
  options?: { admin?: boolean },
) {
  if (options?.admin) return null;
  const dataApi = createServiceClient();
  // Apply active-grant filters before pagination: revoked/expired history must
  // not consume the API's row cap and hide a current grant.
  const activeExpiryFilter = `expires_at.is.null,expires_at.gt.${new Date().toISOString()}`;
  const [directIds, groupIds, ownedIds] = await Promise.all([
    readAccessIds("project_id", (from, to) => dataApi
      .from("project_memberships")
      .select("project_id")
      .eq("principal_id", principalId)
      .is("revoked_at", null)
      .or(activeExpiryFilter)
      .order("project_id", { ascending: true })
      .range(from, to)),
    readAccessIds("group_id", (from, to) => dataApi
      .from("app_group_members")
      .select("group_id")
      .eq("principal_id", principalId)
      .order("group_id", { ascending: true })
      .range(from, to)),
    readAccessIds("id", (from, to) => dataApi
      .from("projects")
      .select("id")
      .eq("owner_id", principalId)
      .order("id", { ascending: true })
      .range(from, to)),
  ]);
  const projectIds = new Set([...directIds, ...ownedIds]);
  // Bound IN filters as well as response pages for users in many groups.
  for (let offset = 0; offset < groupIds.length; offset += 100) {
    const grantIds = await readAccessIds("project_id", (from, to) => dataApi
      .from("project_group_grants")
      .select("project_id")
      .in("group_id", groupIds.slice(offset, offset + 100))
      .is("revoked_at", null)
      .or(activeExpiryFilter)
      .order("project_id", { ascending: true })
      .order("group_id", { ascending: true })
      .range(from, to));
    for (const id of grantIds) projectIds.add(id);
  }
  return [...projectIds];
}
