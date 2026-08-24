import "server-only";

import { randomBytes } from "node:crypto";

import {
  PROJECT_ROLE_LABELS,
  isProjectRole,
  type ProjectRole,
} from "@/lib/access-control";
import { decryptString } from "@/lib/server/crypto";
import { sendGuestAccessEmail } from "@/lib/server/guest-email";
import {
  emailHmac,
  encryptEmail,
  generateGuestCode,
  guestCodeHmac,
  guestCodeLastFour,
  maskEmail,
  normalizeEmail,
  validateEmail,
} from "@/lib/server/identity-crypto";
import { createServiceClient } from "@/lib/server/data-api";

function newGuestPrincipalId() {
  return `g_${randomBytes(24).toString("base64url")}`;
}

function normalizedName(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase("nb-NO");
}

type ExpiringAccessRow = {
  revoked_at: string | null;
  expires_at: string | null;
};

function activeAccessRows<T extends ExpiringAccessRow>(
  rows: readonly T[] | null | undefined,
  now = Date.now(),
) {
  return (rows ?? []).filter(
    (row) =>
      !row.revoked_at &&
      (!row.expires_at || new Date(row.expires_at).getTime() > now),
  );
}

function isShareableProjectRole(
  value: unknown,
): value is Exclude<ProjectRole, "owner"> {
  return isProjectRole(value) && value !== "owner";
}

function configuredEmailSet(name: string) {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((email) => normalizeEmail(email))
      .filter(Boolean),
  );
}

async function syncBootstrapRoles(principalId: string, email?: string | null) {
  if (!email) return;
  const normalized = normalizeEmail(email);
  if (!configuredEmailSet("APP_ADMIN_EMAILS").has(normalized)) return;
  const dataApi = createServiceClient();
  const { error } = await dataApi.from("app_principal_roles").upsert(
    {
      principal_id: principalId,
      role: "admin",
      granted_by: principalId,
    },
    { onConflict: "principal_id,role" },
  );
  if (error) throw new Error(error.message);
}

export async function upsertInternalPrincipal(input: {
  candidateId: string;
  displayName: string;
  email?: string | null;
}) {
  const dataApi = createServiceClient();
  const normalizedEmail = input.email ? validateEmail(input.email) : null;
  const lookup = normalizedEmail ? emailHmac(normalizedEmail) : null;
  const { data, error } = await dataApi.rpc("upsert_internal_principal", {
    p_candidate_principal_id: input.candidateId,
    p_display_name:
      input.displayName.trim().slice(0, 120) || "Bidsite-bruker",
    p_email_hmac: lookup,
    p_email_encrypted: normalizedEmail ? encryptEmail(normalizedEmail) : null,
    p_email_masked: normalizedEmail ? maskEmail(normalizedEmail) : null,
  });
  if (error || !Array.isArray(data) || !data[0]) {
    throw new Error(error?.message || "Kunne ikke lagre brukeridentitet.");
  }
  const row = data[0] as {
    principal_id: string;
    identity_type: "internal";
    display_name: string;
  };
  await syncBootstrapRoles(row.principal_id, normalizedEmail);
  return {
    id: row.principal_id,
    identity_type: row.identity_type,
    display_name: row.display_name,
  };
}

export async function inviteEmailToProject(input: {
  projectId: string;
  projectName: string;
  email: string;
  displayName: string;
  guestDescription: string;
  role: Exclude<ProjectRole, "owner">;
  additionalProjectGrants?: Array<{
    projectId: string;
    projectName: string;
    role: Exclude<ProjectRole, "owner">;
  }>;
  groupIds?: string[];
  expiresAt?: string | null;
  createdBy: string;
}) {
  const email = validateEmail(input.email);
  if (!isShareableProjectRole(input.role)) {
    throw new Error("Ugyldig rolle for invitert bruker.");
  }
  const displayName = input.displayName.trim();
  const guestDescription = input.guestDescription.trim();
  if (displayName.length < 2 || displayName.length > 120) {
    throw new Error("Navnet må være mellom 2 og 120 tegn.");
  }
  if (guestDescription.length < 3 || guestDescription.length > 240) {
    throw new Error("Gjestebeskrivelsen må være mellom 3 og 240 tegn.");
  }
  const projectGrants = [
    {
      projectId: input.projectId,
      projectName: input.projectName,
      role: input.role,
    },
    ...(input.additionalProjectGrants ?? []),
  ];
  if (
    projectGrants.length > 100 ||
    new Set(projectGrants.map((grant) => grant.projectId)).size !==
      projectGrants.length ||
    projectGrants.some((grant) => !isShareableProjectRole(grant.role))
  ) {
    throw new Error("Ugyldige prosjekttilganger for invitasjonen.");
  }
  const groupIds = [...new Set(input.groupIds ?? [])];
  if (groupIds.length > 100) {
    throw new Error("Invitasjonen inneholder for mange grupper.");
  }
  const code = generateGuestCode();
  const dataApi = createServiceClient();
  const { data, error } = await dataApi.rpc("grant_guest_project_access_batch", {
    p_candidate_principal_id: newGuestPrincipalId(),
    p_email_hmac: emailHmac(email),
    p_email_encrypted: encryptEmail(email),
    p_email_masked: maskEmail(email),
    p_display_name: displayName,
    p_guest_description: guestDescription,
    p_project_ids: projectGrants.map((grant) => grant.projectId),
    p_roles: projectGrants.map((grant) => grant.role),
    p_group_ids: groupIds,
    p_expires_at: input.expiresAt ?? null,
    p_created_by: input.createdBy,
    p_code_hmac: guestCodeHmac(code),
    p_code_last_four: guestCodeLastFour(code),
  });
  if (error || !Array.isArray(data) || !data[0]) {
    throw new Error(error?.message || "Kunne ikke opprette prosjekttilgang.");
  }
  const row = data[0] as {
    principal_id: string;
    identity_type: "internal" | "guest";
    credential_created: boolean;
  };
  const guestCode =
    row.identity_type === "guest" && row.credential_created ? code : null;
  const projectAccesses = projectGrants.map((grant) => ({
    projectName: grant.projectName,
    roleLabel: PROJECT_ROLE_LABELS[grant.role],
  }));
  const emailResult = await sendGuestAccessEmail({
    email,
    displayName,
    projectName: input.projectName,
    roleLabel: PROJECT_ROLE_LABELS[input.role],
    projectAccesses,
    identityType: row.identity_type,
    guestCode,
    expiresAt: input.expiresAt ?? null,
  }).catch((emailError) => ({
    delivered: false as const,
    reason:
      emailError instanceof Error
        ? emailError.message
        : "E-postleveringen feilet.",
  }));
  return {
    principalId: row.principal_id,
    identityType: row.identity_type,
    credentialCreated: row.credential_created,
    guestCode,
    email: maskEmail(email),
    emailDelivery: emailResult,
  };
}

export async function rotateGuestCode(input: {
  principalId: string;
  rotatedBy: string;
  projectName?: string;
}) {
  const dataApi = createServiceClient();
  const { data: principal, error: principalError } = await dataApi
    .from("app_principals")
    .select("display_name, email_encrypted")
    .eq("id", input.principalId)
    .eq("identity_type", "guest")
    .is("disabled_at", null)
    .single<{ display_name: string; email_encrypted: string }>();
  if (principalError || !principal) {
    throw new Error(principalError?.message || "Fant ikke en aktiv gjestebruker.");
  }

  const code = generateGuestCode();
  const { data, error } = await dataApi.rpc("rotate_guest_credential", {
    p_principal_id: input.principalId,
    p_code_hmac: guestCodeHmac(code),
    p_code_last_four: guestCodeLastFour(code),
    p_rotated_by: input.rotatedBy,
  });
  if (error) throw new Error(error.message);
  const result = {
    code,
    version: Number(data),
    email: decryptString(principal.email_encrypted),
    displayName: principal.display_name,
  };
  const emailDelivery = input.projectName
    ? await sendGuestAccessEmail({
        email: result.email,
        displayName: result.displayName,
        projectName: input.projectName,
        roleLabel: "Oppdatert gjestetilgang",
        guestCode: result.code,
        expiresAt: null,
      }).catch((emailError) => ({
        delivered: false as const,
        reason:
          emailError instanceof Error
            ? emailError.message
            : "E-postleveringen feilet.",
      }))
    : null;
  return { ...result, emailDelivery };
}

export async function guestLoginProjectName(principalId: string) {
  const dataApi = createServiceClient();
  const { data: memberships, error } = await dataApi
    .from("project_memberships")
    .select("project_id, expires_at, revoked_at, created_at")
    .eq("principal_id", principalId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const now = Date.now();
  const projectId = (memberships ?? []).find(
    (membership) =>
      !membership.revoked_at &&
      (!membership.expires_at ||
        new Date(membership.expires_at).getTime() > now),
  )?.project_id;
  if (!projectId) {
    throw new Error("Gjestebrukeren har ingen aktiv prosjekttilgang.");
  }
  const modern = await dataApi
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .single<{ name: string | null }>();
  if (!modern.error && modern.data) {
    return modern.data.name?.trim() || "Bidsite-prosjekt";
  }
  const legacy = await dataApi
    .from("projects")
    .select("title")
    .eq("id", projectId)
    .single<{ title: string | null }>();
  if (legacy.error || !legacy.data) {
    throw new Error(legacy.error?.message || "Fant ikke prosjektet.");
  }
  return legacy.data.title?.trim() || "Bidsite-prosjekt";
}

export async function authenticateGuestCode(code: string) {
  const dataApi = createServiceClient();
  const lookup = guestCodeHmac(code);
  const { data: credential, error } = await dataApi
    .from("guest_credentials")
    .select("principal_id, code_hmac, revoked_at")
    .eq("code_hmac", lookup)
    .maybeSingle<{
      principal_id: string;
      code_hmac: string;
      revoked_at: string | null;
    }>();
  if (error || !credential || credential.revoked_at) {
    return null;
  }
  const [{ data: principal }, { data: memberships }] = await Promise.all([
    dataApi
      .from("app_principals")
      .select("id, display_name, identity_type, disabled_at")
      .eq("id", credential.principal_id)
      .eq("identity_type", "guest")
      .maybeSingle<{
        id: string;
        display_name: string;
        identity_type: "guest";
        disabled_at: string | null;
      }>(),
    dataApi
      .from("project_memberships")
      .select("project_id, expires_at, revoked_at")
      .eq("principal_id", credential.principal_id),
  ]);
  const now = Date.now();
  const hasActiveMembership = (memberships ?? []).some(
    (membership) =>
      !membership.revoked_at &&
      (!membership.expires_at ||
        new Date(membership.expires_at).getTime() > now),
  );
  if (!principal || principal.disabled_at || !hasActiveMembership) return null;

  await Promise.all([
    dataApi
      .from("guest_credentials")
      .update({ last_used_at: new Date().toISOString() })
      .eq("principal_id", principal.id),
    dataApi
      .from("app_principals")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", principal.id),
    dataApi
      .from("project_memberships")
      .update({ accepted_at: new Date().toISOString() })
      .eq("principal_id", principal.id)
      .is("accepted_at", null)
      .is("revoked_at", null),
  ]);
  return principal;
}

export async function listProjectAccess(projectId: string) {
  const dataApi = createServiceClient();
  const [
    { data: memberships, error: membershipError },
    { data: groupGrants, error: grantError },
  ] = await Promise.all([
    dataApi
      .from("project_memberships")
      .select(
        "principal_id, role, invitation_sent_at, accepted_at, expires_at, revoked_at",
      )
      .eq("project_id", projectId)
      .is("revoked_at", null),
    dataApi
      .from("project_group_grants")
      .select("group_id, role, expires_at, revoked_at")
      .eq("project_id", projectId)
      .is("revoked_at", null),
  ]);
  if (membershipError || grantError) {
    throw new Error(membershipError?.message || grantError?.message);
  }
  const activeMemberships = activeAccessRows(memberships);
  const activeGroupGrants = activeAccessRows(groupGrants);
  const principalIds = activeMemberships.map((row) => row.principal_id);
  const groupIds = activeGroupGrants.map((row) => row.group_id);
  const [
    { data: principals, error: principalError },
    { data: groups, error: groupError },
    { data: groupMembers, error: groupMemberError },
    { data: principalRoles, error: roleError },
  ] = await Promise.all([
    dataApi
      .from("app_principals")
      .select(
        "id, identity_type, display_name, guest_description, email_masked, disabled_at",
      )
      .is("disabled_at", null)
      .order("display_name")
      .limit(500),
    groupIds.length
      ? dataApi
          .from("app_groups")
          .select("id, name")
          .in("id", groupIds)
      : Promise.resolve({ data: [], error: null }),
    groupIds.length
      ? dataApi
          .from("app_group_members")
          .select("group_id, principal_id")
          .in("group_id", groupIds)
      : Promise.resolve({ data: [], error: null }),
    dataApi.from("app_principal_roles").select("principal_id, role"),
  ]);
  if (principalError || groupError || groupMemberError || roleError) {
    throw new Error(
      principalError?.message ||
        groupError?.message ||
        groupMemberError?.message ||
        roleError?.message,
    );
  }
  const principalMap = new Map(
    (principals ?? []).map((principal) => [principal.id, principal]),
  );
  const groupMap = new Map((groups ?? []).map((group) => [group.id, group]));
  const adminIds = new Set(
    (principalRoles ?? [])
      .filter((role) => role.role === "admin")
      .map((role) => role.principal_id),
  );
  const inheritedGroupsFor = (principalId: string) =>
    (groupMembers ?? [])
      .filter((member) => member.principal_id === principalId)
      .map((member) => {
        const grant = activeGroupGrants.find(
          (candidate) => candidate.group_id === member.group_id,
        );
        return {
          id: member.group_id,
          name: groupMap.get(member.group_id)?.name ?? "Gruppe",
          role: grant?.role ?? "restricted_viewer",
        };
      });
  const directPrincipalIds = new Set(principalIds);
  return {
    members: activeMemberships.map((membership) => ({
      ...membership,
      principal: principalMap.get(membership.principal_id) ?? null,
      inheritedGroups: inheritedGroupsFor(membership.principal_id),
    })),
    groups: activeGroupGrants.map((grant) => ({
      ...grant,
      group: groupMap.get(grant.group_id) ?? null,
      memberCount: (groupMembers ?? []).filter(
        (member) => member.group_id === grant.group_id,
      ).length,
    })),
    availablePrincipals: (principals ?? [])
      .filter(
        (principal) =>
          !directPrincipalIds.has(principal.id) && !adminIds.has(principal.id),
      )
      .map((principal) => ({
        ...principal,
        inheritedGroups: inheritedGroupsFor(principal.id),
      })),
  };
}

export async function updateProjectMemberRole(input: {
  projectId: string;
  principalId: string;
  role: ProjectRole;
}) {
  if (!isProjectRole(input.role) || input.role === "owner") {
    throw new Error("Eierrollen kan ikke endres fra delingsdialogen.");
  }
  const dataApi = createServiceClient();
  const { error } = await dataApi
    .from("project_memberships")
    .update({ role: input.role })
    .eq("project_id", input.projectId)
    .eq("principal_id", input.principalId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
}

export async function revokeProjectMember(input: {
  projectId: string;
  principalId: string;
}) {
  const dataApi = createServiceClient();
  const { error } = await dataApi.rpc("revoke_project_member_access", {
    p_project_id: input.projectId,
    p_principal_id: input.principalId,
  });
  if (error) throw new Error(error.message);
}

export async function updateAdminManagedProjectMemberRole(input: {
  projectId: string;
  principalId: string;
  role: Exclude<ProjectRole, "owner">;
  grantedBy: string;
}) {
  const dataApi = createServiceClient();
  const { error } = await dataApi.rpc("set_admin_managed_project_access", {
    p_project_id: input.projectId,
    p_principal_id: input.principalId,
    p_role: input.role,
    p_granted_by: input.grantedBy,
    p_revoke: false,
  });
  if (error) throw new Error(error.message);
}

export async function revokeAdminManagedProjectMember(input: {
  projectId: string;
  principalId: string;
}) {
  const dataApi = createServiceClient();
  const { error } = await dataApi.rpc("set_admin_managed_project_access", {
    p_project_id: input.projectId,
    p_principal_id: input.principalId,
    p_role: null,
    p_granted_by: null,
    p_revoke: true,
  });
  if (error) throw new Error(error.message);
}

export async function updateProjectGroupRole(input: {
  projectId: string;
  groupId: string;
  role: Exclude<ProjectRole, "owner">;
}) {
  if (!isProjectRole(input.role)) throw new Error("Ugyldig grupperolle.");
  const dataApi = createServiceClient();
  const { error } = await dataApi
    .from("project_group_grants")
    .update({ role: input.role })
    .eq("project_id", input.projectId)
    .eq("group_id", input.groupId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
}

export async function revokeProjectGroup(input: {
  projectId: string;
  groupId: string;
}) {
  const dataApi = createServiceClient();
  const { error } = await dataApi
    .from("project_group_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("project_id", input.projectId)
    .eq("group_id", input.groupId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
}

export async function listGroups() {
  const dataApi = createServiceClient();
  const [
    { data: groups, error: groupError },
    { data: members, error: memberError },
    { data: grants, error: grantError },
  ] =
    await Promise.all([
      dataApi
        .from("app_groups")
        .select("id, name, description, created_at")
        .order("name"),
      dataApi.from("app_group_members").select("group_id"),
      dataApi
        .from("project_group_grants")
        .select("group_id, expires_at, revoked_at")
        .is("revoked_at", null),
    ]);
  if (groupError || memberError || grantError) {
    throw new Error(
      groupError?.message || memberError?.message || grantError?.message,
    );
  }
  const memberCounts = new Map<string, number>();
  const projectCounts = new Map<string, number>();
  for (const row of members ?? []) {
    memberCounts.set(row.group_id, (memberCounts.get(row.group_id) ?? 0) + 1);
  }
  for (const row of activeAccessRows(grants)) {
    projectCounts.set(row.group_id, (projectCounts.get(row.group_id) ?? 0) + 1);
  }
  return (groups ?? []).map((group) => ({
    ...group,
    memberCount: memberCounts.get(group.id) ?? 0,
    projectCount: projectCounts.get(group.id) ?? 0,
  }));
}

export async function deleteGroup(groupId: string) {
  const dataApi = createServiceClient();
  const { data, error } = await dataApi
    .from("app_groups")
    .delete()
    .eq("id", groupId)
    .select("id, name")
    .single<{ id: string; name: string }>();
  if (error || !data) {
    throw new Error(error?.message || "Fant ikke gruppen.");
  }
  return data;
}

export async function getGroup(groupId: string) {
  const dataApi = createServiceClient();
  const [
    { data: group, error: groupError },
    { data: memberRows, error: memberError },
    { data: grantRows, error: grantError },
  ] = await Promise.all([
    dataApi
      .from("app_groups")
      .select("id, name, description, created_at")
      .eq("id", groupId)
      .single(),
    dataApi
      .from("app_group_members")
      .select("principal_id")
      .eq("group_id", groupId),
    dataApi
      .from("project_group_grants")
      .select("project_id, role, expires_at, revoked_at")
      .eq("group_id", groupId)
      .is("revoked_at", null),
  ]);
  if (groupError || memberError || grantError || !group) {
    throw new Error(
      groupError?.message ||
        memberError?.message ||
        grantError?.message ||
        "Fant ikke gruppen.",
    );
  }
  const activeGrantRows = activeAccessRows(grantRows);
  const principalIds = (memberRows ?? []).map((row) => row.principal_id);
  const projectIds = activeGrantRows.map((row) => row.project_id);
  const [{ data: principals, error: principalError }, projectResult] =
    await Promise.all([
      principalIds.length
        ? dataApi
            .from("app_principals")
            .select("id, display_name, identity_type, email_masked")
            .in("id", principalIds)
        : Promise.resolve({ data: [], error: null }),
      projectIds.length
        ? dataApi.from("projects").select("id, name").in("id", projectIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
  if (principalError) throw new Error(principalError.message);
  let projects = projectResult.data as
    | Array<{ id: string; name?: string | null; title?: string | null }>
    | null;
  if (projectIds.length && projectResult.error) {
    const legacy = await dataApi
      .from("projects")
      .select("id, title")
      .in("id", projectIds);
    if (legacy.error) throw new Error(legacy.error.message);
    projects = legacy.data;
  }
  const projectMap = new Map(
    (projects ?? []).map((project) => [
      project.id,
      project.name ?? project.title ?? "Prosjekt",
    ]),
  );
  return {
    ...group,
    members: principals ?? [],
    projects: activeGrantRows.map((grant) => ({
      ...grant,
      projectName: projectMap.get(grant.project_id) ?? "Prosjekt",
    })),
  };
}

export async function createGroup(input: {
  name: string;
  description?: string | null;
  createdBy: string;
}) {
  const name = input.name.trim().slice(0, 100);
  if (name.length < 2) throw new Error("Gruppenavn må ha minst to tegn.");
  const dataApi = createServiceClient();
  const { data, error } = await dataApi
    .from("app_groups")
    .insert({
      name,
      normalized_name: normalizedName(name),
      description: input.description?.trim().slice(0, 500) || null,
      created_by: input.createdBy,
    })
    .select("id, name, description, created_at")
    .single();
  if (error || !data) throw new Error(error?.message || "Kunne ikke opprette gruppe.");
  return data;
}

export async function setGroupMembers(input: {
  groupId: string;
  principalIds: string[];
  addedBy: string;
}) {
  const dataApi = createServiceClient();
  const uniqueIds = [...new Set(input.principalIds)].slice(0, 500);
  const { error } = await dataApi.rpc("replace_group_members", {
    p_group_id: input.groupId,
    p_principal_ids: uniqueIds,
    p_added_by: input.addedBy,
  });
  if (error) throw new Error(error.message);
}

export async function addPrincipalToGroups(input: {
  principalId: string;
  groupIds: string[];
  addedBy: string;
}) {
  const uniqueGroupIds = [...new Set(input.groupIds)].slice(0, 100);
  if (!uniqueGroupIds.length) return;
  const dataApi = createServiceClient();
  const { data: groups, error: groupError } = await dataApi
    .from("app_groups")
    .select("id")
    .in("id", uniqueGroupIds);
  if (groupError || (groups ?? []).length !== uniqueGroupIds.length) {
    throw new Error(groupError?.message || "En eller flere grupper finnes ikke.");
  }
  const { error } = await dataApi.from("app_group_members").upsert(
    uniqueGroupIds.map((groupId) => ({
      group_id: groupId,
      principal_id: input.principalId,
      added_by: input.addedBy,
    })),
    { onConflict: "group_id,principal_id" },
  );
  if (error) throw new Error(error.message);
}

export async function replaceGroupProjectAccess(input: {
  groupId: string;
  grants: Array<{
    projectId: string;
    role: ProjectRole;
  }>;
  grantedBy: string;
}) {
  const projectIds: string[] = [];
  const roles: string[] = [];
  const seen = new Set<string>();
  for (const grant of input.grants.slice(0, 500)) {
    if (
      seen.has(grant.projectId) ||
      !isProjectRole(grant.role) ||
      grant.role === "owner"
    ) {
      throw new Error("Ugyldig prosjekttilgang for gruppen.");
    }
    seen.add(grant.projectId);
    projectIds.push(grant.projectId);
    roles.push(grant.role);
  }
  const dataApi = createServiceClient();
  const { error } = await dataApi.rpc("replace_group_project_access", {
    p_group_id: input.groupId,
    p_project_ids: projectIds,
    p_roles: roles,
    p_granted_by: input.grantedBy,
  });
  if (error) throw new Error(error.message);
}

export async function grantPrincipalProjectAccess(input: {
  principalId: string;
  projectId: string;
  role: ProjectRole;
  grantedBy: string;
}) {
  if (!isProjectRole(input.role) || input.role === "owner") {
    throw new Error("Ugyldig prosjekttilgang.");
  }
  const dataApi = createServiceClient();
  const { data: principal, error: principalError } = await dataApi
    .from("app_principals")
    .select("id, disabled_at")
    .eq("id", input.principalId)
    .single<{ id: string; disabled_at: string | null }>();
  if (principalError || !principal || principal.disabled_at) {
    throw new Error(principalError?.message || "Brukeren er ikke aktiv.");
  }
  const { data: existingMembership, error: membershipError } = await dataApi
    .from("project_memberships")
    .select("role")
    .eq("project_id", input.projectId)
    .eq("principal_id", input.principalId)
    .is("revoked_at", null)
    .maybeSingle<{ role: string }>();
  if (membershipError) throw new Error(membershipError.message);
  if (existingMembership?.role === "owner") {
    throw new Error("Eierrollen kan ikke endres fra tilgangsstyringen.");
  }
  const { error } = await dataApi.from("project_memberships").upsert(
    {
      project_id: input.projectId,
      principal_id: input.principalId,
      role: input.role,
      invited_by: input.grantedBy,
      invitation_sent_at: new Date().toISOString(),
      expires_at: null,
      revoked_at: null,
    },
    { onConflict: "project_id,principal_id" },
  );
  if (error) throw new Error(error.message);
}

export async function grantGroupProjectAccess(input: {
  projectId: string;
  groupId: string;
  role: Exclude<ProjectRole, "owner">;
  grantedBy: string;
  expiresAt?: string | null;
}) {
  if (!isProjectRole(input.role)) {
    throw new Error("Ugyldig grupperolle.");
  }
  const dataApi = createServiceClient();
  const { error } = await dataApi.from("project_group_grants").upsert(
    {
      project_id: input.projectId,
      group_id: input.groupId,
      role: input.role,
      granted_by: input.grantedBy,
      expires_at: input.expiresAt ?? null,
      revoked_at: null,
    },
    { onConflict: "project_id,group_id" },
  );
  if (error) throw new Error(error.message);
}

export async function listPrincipals() {
  const dataApi = createServiceClient();
  const [
    { data: principals, error: principalError },
    { data: roles, error: roleError },
    { data: memberships, error: membershipError },
    { data: groupMemberships, error: groupMembershipError },
    { data: groups, error: groupError },
    { data: groupGrants, error: groupGrantError },
    { data: guestCredentials, error: credentialError },
  ] = await Promise.all([
    dataApi
      .from("app_principals")
      .select(
        "id, identity_type, display_name, guest_description, email_masked, disabled_at, last_login_at, created_at",
      )
      .order("display_name"),
    dataApi.from("app_principal_roles").select("principal_id, role"),
    dataApi
      .from("project_memberships")
      .select("principal_id, project_id, role, expires_at, revoked_at")
      .is("revoked_at", null),
    dataApi.from("app_group_members").select("principal_id, group_id"),
    dataApi.from("app_groups").select("id, name"),
    dataApi
      .from("project_group_grants")
      .select("group_id, project_id, role, expires_at, revoked_at")
      .is("revoked_at", null),
    dataApi
      .from("guest_credentials")
      .select(
        "principal_id, code_last_four, credential_version, rotated_at, last_used_at, revoked_at",
      ),
  ]);
  if (
    principalError ||
    roleError ||
    membershipError ||
    groupMembershipError ||
    groupError ||
    groupGrantError ||
    credentialError
  ) {
    throw new Error(
      principalError?.message ||
        roleError?.message ||
        membershipError?.message ||
        groupMembershipError?.message ||
        groupError?.message ||
        groupGrantError?.message ||
        credentialError?.message,
    );
  }
  const activeMemberships = activeAccessRows(memberships);
  const activeGroupGrants = activeAccessRows(groupGrants);
  const adminIds = new Set<string>();
  for (const row of roles ?? []) {
    if (row.role === "admin") adminIds.add(row.principal_id);
  }

  const projectIds = [
    ...new Set([
      ...activeMemberships.map((row) => row.project_id),
      ...activeGroupGrants.map((row) => row.project_id),
    ]),
  ];
  const projectResult = projectIds.length
    ? await dataApi.from("projects").select("id, name").in("id", projectIds)
    : { data: [], error: null };
  let projects = projectResult.data as
    | Array<{ id: string; name?: string | null; title?: string | null }>
    | null;
  if (projectIds.length && projectResult.error) {
    const legacy = await dataApi
      .from("projects")
      .select("id, title")
      .in("id", projectIds);
    if (legacy.error) throw new Error(legacy.error.message);
    projects = legacy.data;
  }
  const projectNames = new Map(
    (projects ?? []).map((project) => [
      project.id,
      project.name ?? project.title ?? "Prosjekt",
    ]),
  );
  const groupNames = new Map(
    (groups ?? []).map((group) => [group.id, group.name]),
  );
  const guestLoginByPrincipal = new Map(
    (guestCredentials ?? []).map((credential) => [
      credential.principal_id,
      credential,
    ]),
  );
  const grantsByGroup = new Map<string, typeof activeGroupGrants>();
  for (const grant of activeGroupGrants) {
    const current = grantsByGroup.get(grant.group_id) ?? [];
    current.push(grant);
    grantsByGroup.set(grant.group_id, current);
  }
  return (principals ?? []).map((principal) => ({
    ...principal,
    isAdmin: adminIds.has(principal.id),
    guestLogin:
      principal.identity_type === "guest"
        ? (() => {
            const credential = guestLoginByPrincipal.get(principal.id);
            return credential
              ? {
                  active: !credential.revoked_at,
                  lastFour: credential.code_last_four,
                  version: credential.credential_version,
                  rotatedAt: credential.rotated_at,
                  lastUsedAt: credential.last_used_at,
                }
              : null;
          })()
        : null,
    projects: activeMemberships
      .filter((membership) => membership.principal_id === principal.id)
      .map((membership) => ({
        id: membership.project_id,
        name: projectNames.get(membership.project_id) ?? "Prosjekt",
        role: membership.role,
        source: "direct" as const,
      })),
    groups: (groupMemberships ?? [])
      .filter((membership) => membership.principal_id === principal.id)
      .map((membership) => ({
        id: membership.group_id,
        name: groupNames.get(membership.group_id) ?? "Gruppe",
      })),
    projectCount: new Set([
      ...activeMemberships
        .filter((membership) => membership.principal_id === principal.id)
        .map((membership) => membership.project_id),
      ...(groupMemberships ?? [])
        .filter((membership) => membership.principal_id === principal.id)
        .flatMap((membership) => grantsByGroup.get(membership.group_id) ?? [])
        .map((grant) => grant.project_id),
    ]).size,
  }));
}

export async function setAdminStatus(input: {
  principalId: string;
  isAdmin: boolean;
  grantedBy: string;
}) {
  const dataApi = createServiceClient();
  const { data: principal, error: principalError } = await dataApi
    .from("app_principals")
    .select("identity_type")
    .eq("id", input.principalId)
    .single<{ identity_type: "internal" | "guest" }>();
  if (principalError || !principal) {
    throw new Error(principalError?.message || "Fant ikke brukeren.");
  }
  if (principal.identity_type !== "internal" && input.isAdmin) {
    throw new Error("Globale roller kan bare gis til interne brukere.");
  }
  const { error } = await dataApi.rpc("set_principal_admin", {
    p_principal_id: input.principalId,
    p_is_admin: input.isAdmin,
    p_granted_by: input.grantedBy,
  });
  if (error) throw new Error(error.message);
}

export type PrincipalProfile = {
  id: string;
  identityType: "internal" | "guest";
  displayName: string;
  emailMasked: string | null;
  isAdmin: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
  authMethod: "entra" | "guest_code" | "admin_password" | null;
  groups: Array<{ id: string; name: string }>;
  projects: Array<{
    id: string;
    name: string;
    role: string;
    source: "direct" | "group";
    groupName?: string;
  }>;
};

export async function getPrincipalProfile(input: {
  principalId: string;
  sessionId?: string | null;
}): Promise<PrincipalProfile | null> {
  const dataApi = createServiceClient();
  const [
    { data: principal, error: principalError },
    { data: roles, error: roleError },
    { data: memberships, error: membershipError },
    { data: groupMemberships, error: groupMembershipError },
    sessionResult,
  ] = await Promise.all([
    dataApi
      .from("app_principals")
      .select(
        "id, identity_type, display_name, email_masked, last_login_at, created_at",
      )
      .eq("id", input.principalId)
      .maybeSingle<{
        id: string;
        identity_type: "internal" | "guest";
        display_name: string | null;
        email_masked: string | null;
        last_login_at: string | null;
        created_at: string | null;
      }>(),
    dataApi
      .from("app_principal_roles")
      .select("role")
      .eq("principal_id", input.principalId),
    dataApi
      .from("project_memberships")
      .select("project_id, role, expires_at, revoked_at")
      .eq("principal_id", input.principalId)
      .is("revoked_at", null),
    dataApi
      .from("app_group_members")
      .select("group_id")
      .eq("principal_id", input.principalId),
    input.sessionId
      ? dataApi
          .from("app_sessions")
          .select("auth_method")
          .eq("id", input.sessionId)
          .maybeSingle<{ auth_method: string | null }>()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const sessionError =
    sessionResult && "error" in sessionResult ? sessionResult.error : null;
  if (
    principalError ||
    roleError ||
    membershipError ||
    groupMembershipError ||
    sessionError
  ) {
    throw new Error(
      principalError?.message ||
        roleError?.message ||
        membershipError?.message ||
        groupMembershipError?.message ||
        sessionError?.message,
    );
  }
  if (!principal) return null;

  const activeMemberships = activeAccessRows(memberships);

  const groupIds = (groupMemberships ?? []).map((row) => row.group_id);
  const [
    { data: groups, error: groupError },
    { data: groupGrants, error: groupGrantError },
  ] = groupIds.length
    ? await Promise.all([
        dataApi.from("app_groups").select("id, name").in("id", groupIds),
        dataApi
          .from("project_group_grants")
          .select("group_id, project_id, role, expires_at, revoked_at")
          .in("group_id", groupIds)
          .is("revoked_at", null),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];
  if (groupError || groupGrantError) {
    throw new Error(groupError?.message || groupGrantError?.message);
  }
  const activeGroupGrants = activeAccessRows(groupGrants);

  const projectIds = [
    ...new Set([
      ...activeMemberships.map((row) => row.project_id),
      ...activeGroupGrants.map((row) => row.project_id),
    ]),
  ];
  let projectNames = new Map<string, string>();
  if (projectIds.length) {
    const projectResult = await dataApi
      .from("projects")
      .select("id, name")
      .in("id", projectIds);
    let projects = projectResult.data as
      | Array<{ id: string; name?: string | null; title?: string | null }>
      | null;
    if (projectResult.error) {
      const legacy = await dataApi
        .from("projects")
        .select("id, title")
        .in("id", projectIds);
      if (legacy.error) throw new Error(legacy.error.message);
      projects = legacy.data;
    }
    projectNames = new Map(
      (projects ?? []).map((project) => [
        project.id,
        project.name ?? project.title ?? "Prosjekt",
      ]),
    );
  }

  const groupNames = new Map((groups ?? []).map((group) => [group.id, group.name]));
  const projects: PrincipalProfile["projects"] = [
    ...activeMemberships.map((membership) => ({
      id: membership.project_id,
      name: projectNames.get(membership.project_id) ?? "Prosjekt",
      role: membership.role as string,
      source: "direct" as const,
    })),
    ...activeGroupGrants.map((grant) => ({
      id: grant.project_id,
      name: projectNames.get(grant.project_id) ?? "Prosjekt",
      role: grant.role as string,
      source: "group" as const,
      groupName: groupNames.get(grant.group_id) ?? "Gruppe",
    })),
  ].sort((a, b) => a.name.localeCompare(b.name, "no"));

  const sessionAuthMethod =
    (sessionResult && "data" in sessionResult ? sessionResult.data : null)
      ?.auth_method ?? null;

  return {
    id: principal.id,
    identityType: principal.identity_type,
    displayName: principal.display_name?.trim() || "Bruker",
    emailMasked: principal.email_masked,
    isAdmin: (roles ?? []).some((row) => row.role === "admin"),
    createdAt: principal.created_at,
    lastLoginAt: principal.last_login_at,
    authMethod:
      sessionAuthMethod === "entra" ||
      sessionAuthMethod === "guest_code" ||
      sessionAuthMethod === "admin_password"
        ? sessionAuthMethod
        : null,
    groups: groupIds.map((id) => ({ id, name: groupNames.get(id) ?? "Gruppe" })),
    projects,
  };
}
