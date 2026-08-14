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
import { createServiceClient } from "@/lib/server/supabase";

function newGuestPrincipalId() {
  return `g_${randomBytes(24).toString("base64url")}`;
}

function normalizedName(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase("nb-NO");
}

function defaultDisplayName(email: string) {
  const localPart = validateEmail(email).split("@")[0] ?? "Gjest";
  return localPart
    .split(/[._+-]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
    .slice(0, 120) || "Gjest";
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
  const supabase = createServiceClient();
  const { error } = await supabase.from("app_principal_roles").upsert(
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
  const supabase = createServiceClient();
  const normalizedEmail = input.email ? validateEmail(input.email) : null;
  const lookup = normalizedEmail ? emailHmac(normalizedEmail) : null;
  const { data, error } = await supabase.rpc("upsert_internal_principal", {
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
  displayName?: string | null;
  role: Exclude<ProjectRole, "owner">;
  expiresAt?: string | null;
  createdBy: string;
}) {
  const email = validateEmail(input.email);
  if (!isProjectRole(input.role)) {
    throw new Error("Ugyldig rolle for invitert bruker.");
  }
  const displayName =
    input.displayName?.trim().slice(0, 120) || defaultDisplayName(email);
  const code = generateGuestCode();
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("grant_guest_project_access", {
    p_candidate_principal_id: newGuestPrincipalId(),
    p_email_hmac: emailHmac(email),
    p_email_encrypted: encryptEmail(email),
    p_email_masked: maskEmail(email),
    p_display_name: displayName,
    p_project_id: input.projectId,
    p_role: input.role,
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
  const emailResult = await sendGuestAccessEmail({
    email,
    displayName,
    projectName: input.projectName,
    roleLabel: PROJECT_ROLE_LABELS[input.role],
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
  const code = generateGuestCode();
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("rotate_guest_credential", {
    p_principal_id: input.principalId,
    p_code_hmac: guestCodeHmac(code),
    p_code_last_four: guestCodeLastFour(code),
    p_rotated_by: input.rotatedBy,
  });
  if (error) throw new Error(error.message);
  const { data: principal, error: principalError } = await supabase
    .from("app_principals")
    .select("display_name, email_encrypted")
    .eq("id", input.principalId)
    .eq("identity_type", "guest")
    .single<{ display_name: string; email_encrypted: string }>();
  if (principalError || !principal) {
    throw new Error(principalError?.message || "Fant ikke gjestebrukeren.");
  }
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

export async function authenticateGuestCode(code: string) {
  const supabase = createServiceClient();
  const lookup = guestCodeHmac(code);
  const { data: credential, error } = await supabase
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
    supabase
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
    supabase
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
    supabase
      .from("guest_credentials")
      .update({ last_used_at: new Date().toISOString() })
      .eq("principal_id", principal.id),
    supabase
      .from("app_principals")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", principal.id),
    supabase
      .from("project_memberships")
      .update({ accepted_at: new Date().toISOString() })
      .eq("principal_id", principal.id)
      .is("accepted_at", null)
      .is("revoked_at", null),
  ]);
  return principal;
}

export async function listProjectAccess(projectId: string) {
  const supabase = createServiceClient();
  const [
    { data: memberships, error: membershipError },
    { data: groupGrants, error: grantError },
  ] = await Promise.all([
    supabase
      .from("project_memberships")
      .select(
        "principal_id, role, invitation_sent_at, accepted_at, expires_at, revoked_at",
      )
      .eq("project_id", projectId)
      .is("revoked_at", null),
    supabase
      .from("project_group_grants")
      .select("group_id, role, expires_at, revoked_at")
      .eq("project_id", projectId)
      .is("revoked_at", null),
  ]);
  if (membershipError || grantError) {
    throw new Error(membershipError?.message || grantError?.message);
  }
  const principalIds = (memberships ?? []).map((row) => row.principal_id);
  const groupIds = (groupGrants ?? []).map((row) => row.group_id);
  const [{ data: principals }, { data: groups }] = await Promise.all([
    principalIds.length
      ? supabase
          .from("app_principals")
          .select("id, identity_type, display_name, email_masked, disabled_at")
          .in("id", principalIds)
      : Promise.resolve({ data: [], error: null }),
    groupIds.length
      ? supabase
          .from("app_groups")
          .select("id, name")
          .in("id", groupIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const principalMap = new Map(
    (principals ?? []).map((principal) => [principal.id, principal]),
  );
  const groupMap = new Map((groups ?? []).map((group) => [group.id, group]));
  return {
    members: (memberships ?? []).map((membership) => ({
      ...membership,
      principal: principalMap.get(membership.principal_id) ?? null,
    })),
    groups: (groupGrants ?? []).map((grant) => ({
      ...grant,
      group: groupMap.get(grant.group_id) ?? null,
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
  const supabase = createServiceClient();
  const { error } = await supabase
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
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("revoke_project_member_access", {
    p_project_id: input.projectId,
    p_principal_id: input.principalId,
  });
  if (error) throw new Error(error.message);
}

export async function updateProjectGroupRole(input: {
  projectId: string;
  groupId: string;
  role: Exclude<ProjectRole, "owner">;
}) {
  if (!isProjectRole(input.role)) throw new Error("Ugyldig grupperolle.");
  const supabase = createServiceClient();
  const { error } = await supabase
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
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("project_group_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("project_id", input.projectId)
    .eq("group_id", input.groupId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
}

export async function listGroups() {
  const supabase = createServiceClient();
  const [{ data: groups, error }, { data: members }, { data: grants }] =
    await Promise.all([
      supabase
        .from("app_groups")
        .select("id, name, description, created_at")
        .order("name"),
      supabase.from("app_group_members").select("group_id"),
      supabase
        .from("project_group_grants")
        .select("group_id")
        .is("revoked_at", null),
    ]);
  if (error) throw new Error(error.message);
  const memberCounts = new Map<string, number>();
  const projectCounts = new Map<string, number>();
  for (const row of members ?? []) {
    memberCounts.set(row.group_id, (memberCounts.get(row.group_id) ?? 0) + 1);
  }
  for (const row of grants ?? []) {
    projectCounts.set(row.group_id, (projectCounts.get(row.group_id) ?? 0) + 1);
  }
  return (groups ?? []).map((group) => ({
    ...group,
    memberCount: memberCounts.get(group.id) ?? 0,
    projectCount: projectCounts.get(group.id) ?? 0,
  }));
}

export async function getGroup(groupId: string) {
  const supabase = createServiceClient();
  const [
    { data: group, error },
    { data: memberRows },
    { data: grantRows },
  ] = await Promise.all([
    supabase
      .from("app_groups")
      .select("id, name, description, created_at")
      .eq("id", groupId)
      .single(),
    supabase
      .from("app_group_members")
      .select("principal_id")
      .eq("group_id", groupId),
    supabase
      .from("project_group_grants")
      .select("project_id, role, expires_at")
      .eq("group_id", groupId)
      .is("revoked_at", null),
  ]);
  if (error || !group) throw new Error(error?.message || "Fant ikke gruppen.");
  const principalIds = (memberRows ?? []).map((row) => row.principal_id);
  const projectIds = (grantRows ?? []).map((row) => row.project_id);
  const [{ data: principals }, projectResult] = await Promise.all([
    principalIds.length
      ? supabase
          .from("app_principals")
          .select("id, display_name, identity_type, email_masked")
          .in("id", principalIds)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length
      ? supabase.from("projects").select("id, name").in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  let projects = projectResult.data as
    | Array<{ id: string; name?: string | null; title?: string | null }>
    | null;
  if (projectIds.length && projectResult.error) {
    const legacy = await supabase
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
    projects: (grantRows ?? []).map((grant) => ({
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
  const supabase = createServiceClient();
  const { data, error } = await supabase
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
  const supabase = createServiceClient();
  const uniqueIds = [...new Set(input.principalIds)].slice(0, 500);
  const { error } = await supabase.rpc("replace_group_members", {
    p_group_id: input.groupId,
    p_principal_ids: uniqueIds,
    p_added_by: input.addedBy,
  });
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
  const supabase = createServiceClient();
  const { error } = await supabase.from("project_group_grants").upsert(
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
  const supabase = createServiceClient();
  const [
    { data: principals, error },
    { data: roles },
    { data: memberships },
  ] = await Promise.all([
    supabase
      .from("app_principals")
      .select(
        "id, identity_type, display_name, email_masked, disabled_at, last_login_at, created_at",
      )
      .order("display_name"),
    supabase.from("app_principal_roles").select("principal_id, role"),
    supabase
      .from("project_memberships")
      .select("principal_id")
      .is("revoked_at", null),
  ]);
  if (error) throw new Error(error.message);
  const adminIds = new Set<string>();
  const projectCounts = new Map<string, number>();
  for (const row of roles ?? []) {
    if (row.role === "admin") adminIds.add(row.principal_id);
  }
  for (const row of memberships ?? []) {
    projectCounts.set(
      row.principal_id,
      (projectCounts.get(row.principal_id) ?? 0) + 1,
    );
  }
  return (principals ?? []).map((principal) => ({
    ...principal,
    isAdmin: adminIds.has(principal.id),
    projectCount: projectCounts.get(principal.id) ?? 0,
  }));
}

export async function setAdminStatus(input: {
  principalId: string;
  isAdmin: boolean;
  grantedBy: string;
}) {
  const supabase = createServiceClient();
  const { data: principal, error: principalError } = await supabase
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
  const { error } = await supabase.rpc("set_principal_admin", {
    p_principal_id: input.principalId,
    p_is_admin: input.isAdmin,
    p_granted_by: input.grantedBy,
  });
  if (error) throw new Error(error.message);
}
