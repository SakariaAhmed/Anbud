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
  effectiveRole: ProjectRole | "admin_read";
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
    if (
      error ||
      !session ||
      session.revoked_at ||
      new Date(session.expires_at).getTime() <= Date.now()
    ) {
      throw new AuthorizationError("Økten er utløpt eller tilbakekalt.", 401);
    }
  }

  const [{ data: principal, error: principalError }, { data: roleRows }] =
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
  if (
    principalError ||
    !principal ||
    principal.disabled_at ||
    !isIdentityType(principal.identity_type)
  ) {
    throw new AuthorizationError("Brukeren er ikke aktiv.", 401);
  }

  return {
    identityType: principal.identity_type,
    isAdmin: (roleRows ?? []).some((row) => row.role === "admin"),
  };
}

export async function requireRequestPrincipal(): Promise<RequestPrincipal> {
  const requestHeaders = await headers();
  const principalId = requestHeaders.get(AUTH_PRINCIPAL_HEADER);
  if (!principalId) {
    throw new AuthorizationError("Innlogging kreves.", 401);
  }
  const sessionId = requestHeaders.get(AUTH_SESSION_HEADER);
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

function activeGrantFilter<T extends {
  revoked_at: string | null;
  expires_at: string | null;
}>(rows: readonly T[]) {
  const now = Date.now();
  return rows.filter(
    (row) =>
      !row.revoked_at &&
      (!row.expires_at || new Date(row.expires_at).getTime() > now),
  );
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
    throw new Error(error.message || "Kunne ikke kontrollere prosjekttilgang.");
  }
  if (data === null) return null;
  if (!isProjectRole(data)) {
    throw new Error("Databasen returnerte en ugyldig prosjektrolle.");
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
    return { principal, projectId, effectiveRole: effectiveRole ?? "admin_read", permissions };
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
  if (error instanceof AuthorizationError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  }
  return null;
}

export async function listAccessibleProjectIds(
  principalId: string,
  options?: { admin?: boolean },
) {
  if (options?.admin) return null;
  const dataApi = createServiceClient();
  const [
    { data: directRows, error: directError },
    { data: groupRows, error: groupError },
    { data: ownedRows, error: ownedError },
  ] = await Promise.all([
    dataApi
      .from("project_memberships")
      .select("project_id, revoked_at, expires_at")
      .eq("principal_id", principalId),
    dataApi
      .from("app_group_members")
      .select("group_id")
      .eq("principal_id", principalId),
    dataApi.from("projects").select("id").eq("owner_id", principalId),
  ]);
  if (directError || groupError || ownedError) {
    throw new Error(
      directError?.message ||
        groupError?.message ||
        ownedError?.message ||
        "Kunne ikke hente prosjekttilganger.",
    );
  }
  const projectIds = new Set<string>(
    activeGrantFilter(
      (directRows ?? []) as Array<{
        project_id: string;
        revoked_at: string | null;
        expires_at: string | null;
      }>,
    ).map((row) => row.project_id),
  );
  for (const row of ownedRows ?? []) projectIds.add(row.id);

  const groupIds = (groupRows ?? []).map((row) => row.group_id);
  if (groupIds.length) {
    const { data: grantRows, error } = await dataApi
      .from("project_group_grants")
      .select("project_id, revoked_at, expires_at")
      .in("group_id", groupIds);
    if (error) throw new Error(error.message);
    for (const row of activeGrantFilter(
      (grantRows ?? []) as Array<{
        project_id: string;
        revoked_at: string | null;
        expires_at: string | null;
      }>,
    )) {
      projectIds.add(row.project_id);
    }
  }
  return [...projectIds];
}
