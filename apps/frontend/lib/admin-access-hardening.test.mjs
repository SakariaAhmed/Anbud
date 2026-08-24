import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("admin invitation validates group scope before creating the invitation", () => {
  const source = readFileSync(
    path.join(frontendRoot, "app/api/admin/users/route.ts"),
    "utf8",
  );
  const groupValidation = source.indexOf("availableGroupIds");
  const invitation = source.indexOf("await inviteEmailToProject");
  assert.ok(groupValidation > 0);
  assert.ok(invitation > groupValidation);
  assert.match(source, /body\.groupIds\.length > 100/u);
  assert.match(source, /"Cache-Control": "private, no-store"/u);
});

test("one admin invitation can grant unique projects with separate roles", () => {
  const route = readFileSync(
    path.join(frontendRoot, "app/api/admin/users/route.ts"),
    "utf8",
  );
  assert.match(route, /body\.projectGrants/u);
  assert.match(route, /rawProjectGrants\.length > 100/u);
  assert.match(
    route,
    /new Set\(projectGrants\.map\(\(grant\) => grant\.projectId\)\)/u,
  );
  const projectLookup = route.indexOf("const namedProjectGrants");
  const invitation = route.indexOf("await inviteEmailToProject", projectLookup);
  assert.ok(projectLookup > 0);
  assert.ok(invitation > projectLookup);
  assert.match(route.slice(invitation, invitation + 700), /additionalProjectGrants/u);
  assert.match(route, /projectCount: projectGrants\.length/u);

  const repository = readFileSync(
    path.join(frontendRoot, "lib/server/access-control-repository.ts"),
    "utf8",
  );
  const atomicGrant = repository.indexOf(
    'rpc("grant_guest_project_access_batch"',
  );
  const invitationEmail = repository.indexOf(
    "const emailResult = await sendGuestAccessEmail",
    atomicGrant,
  );
  assert.ok(atomicGrant > 0);
  assert.ok(invitationEmail > atomicGrant);
  assert.match(repository, /p_project_ids: projectGrants\.map/u);
  assert.match(repository, /p_roles: projectGrants\.map/u);
  assert.match(repository, /p_group_ids: groupIds/u);
  assert.doesNotMatch(repository, /for \(const grant of input\.additionalProjectGrants/u);
  assert.match(
    repository.slice(atomicGrant, invitationEmail + 500),
    /projectAccesses/u,
  );
  assert.match(route.slice(invitation, invitation + 700), /groupIds/u);
  assert.doesNotMatch(route, /await addPrincipalToGroups/u);

  const ui = readFileSync(
    path.join(frontendRoot, "components/admin/admin-console.tsx"),
    "utf8",
  );
  const invitePanelStart = ui.indexOf("function InviteUserPanel");
  const invitePanelEnd = ui.indexOf("function UserAccessRow", invitePanelStart);
  const invitePanel = ui.slice(invitePanelStart, invitePanelEnd);
  assert.match(invitePanel, /Object\.entries\(projectGrants\)\.flatMap/u);
  assert.match(invitePanel, /availableProjects/u);
  assert.match(invitePanel, /Velg et prosjekt som skal legges til/u);
  assert.match(invitePanel, /placeholder="Velg rolle"/u);
  assert.match(invitePanel, /Velg rolle for å aktivere tilgangen/u);
  assert.match(invitePanel, /delete next\[project\.id\]/u);
  assert.doesNotMatch(invitePanel, /type="checkbox"/u);
  assert.doesNotMatch(invitePanel, /av \{projects\.length\} valgt/u);
});

test("multi-project invitation emails escape and list every project role", () => {
  const source = readFileSync(
    path.join(frontendRoot, "lib/server/guest-email.ts"),
    "utf8",
  );
  assert.match(source, /projectAccesses\?: Array/u);
  assert.match(source, /projectAccesses\.map/u);
  assert.match(source, /escapeHtml\(access\.projectName\)/u);
  assert.match(source, /escapeHtml\(access\.roleLabel\)/u);
  assert.match(source, /prosjekter i Bidsite/u);
});

test("direct access management cannot downgrade an existing project owner", () => {
  const source = readFileSync(
    path.join(frontendRoot, "lib/server/access-control-repository.ts"),
    "utf8",
  );
  const ownerGuard = source.indexOf('existingMembership?.role === "owner"');
  const membershipWrite = source.indexOf(
    'dataApi.from("project_memberships").upsert',
    ownerGuard,
  );
  assert.ok(ownerGuard > 0);
  assert.ok(membershipWrite > ownerGuard);
});

test("administrator project context exposes only global read and share permissions", () => {
  const source = readFileSync(
    path.join(frontendRoot, "lib/server/authorization.ts"),
    "utf8",
  );
  const globalBranch = source.indexOf(
    "if (globalAccessAllows(principal.isAdmin, permission))",
  );
  const roleLookup = source.indexOf(
    "const effectiveRole = await getEffectiveProjectRole",
    globalBranch,
  );
  const branch = source.slice(globalBranch, roleLookup);
  assert.match(branch, /PROJECT_ROLE_PERMISSIONS\.owner\.filter/u);
  assert.match(branch, /globalAccessAllows\(principal\.isAdmin, candidate\)/u);
  assert.match(branch, /permissions: globalPermissions/u);
});

test("project owners can grant an existing active person direct access", () => {
  const route = readFileSync(
    path.join(frontendRoot, "app/api/projects/[id]/access/route.ts"),
    "utf8",
  );
  const authorization = route.indexOf("const authorization = await authorize(id)");
  const grant = route.indexOf('command.action === "grant_member"');
  const repositoryCall = route.indexOf("await grantPrincipalProjectAccess", grant);
  assert.ok(authorization > 0);
  assert.ok(grant > authorization);
  assert.ok(repositoryCall > grant);
  assert.match(route.slice(grant, repositoryCall + 300), /grantedBy: authorization\.principal\.id/u);
});

test("guest login rotation is admin-only, rate limited, and never cached", () => {
  const source = readFileSync(
    path.join(
      frontendRoot,
      "app/api/admin/users/[principalId]/guest-login/route.ts",
    ),
    "utf8",
  );
  assert.match(source, /await requireAdmin\(\)/u);
  assert.match(source, /"admin-guest-login-rotate"/u);
  assert.match(source, /"Cache-Control": "private, no-store"/u);

  const activityStart = source.indexOf("await recordActivity");
  const responseStart = source.indexOf("return NextResponse.json", activityStart);
  assert.ok(activityStart > 0);
  assert.ok(responseStart > activityStart);
  assert.doesNotMatch(
    source.slice(activityStart, responseStart),
    /(?:^|[,{]\s*)code\s*:/u,
  );
});

test("guest login rotation validates an active guest before changing its credential", () => {
  const source = readFileSync(
    path.join(frontendRoot, "lib/server/access-control-repository.ts"),
    "utf8",
  );
  const functionStart = source.indexOf("export async function rotateGuestCode");
  const nextFunction = source.indexOf(
    "export async function guestLoginProjectName",
    functionStart,
  );
  const rotation = source.slice(functionStart, nextFunction);
  const guestCheck = rotation.indexOf('.eq("identity_type", "guest")');
  const activeCheck = rotation.indexOf('.is("disabled_at", null)');
  const credentialWrite = rotation.indexOf('rpc("rotate_guest_credential"');
  assert.ok(guestCheck > 0);
  assert.ok(activeCheck > guestCheck);
  assert.ok(credentialWrite > activeCheck);
});

test("admin user listing exposes only non-secret guest credential metadata", () => {
  const source = readFileSync(
    path.join(frontendRoot, "lib/server/access-control-repository.ts"),
    "utf8",
  );
  const listStart = source.indexOf("export async function listPrincipals");
  const listEnd = source.indexOf("export async function setAdminStatus", listStart);
  const listing = source.slice(listStart, listEnd);
  assert.match(listing, /code_last_four/u);
  assert.doesNotMatch(listing, /code_hmac/u);
});

test("admin invitations require a bounded guest name and description", () => {
  const route = readFileSync(
    path.join(frontendRoot, "app/api/admin/users/route.ts"),
    "utf8",
  );
  assert.match(route, /body\.displayName\.trim\(\)\.length < 2/u);
  assert.match(route, /body\.guestDescription\.trim\(\)\.length < 3/u);
  assert.match(route, /body\.guestDescription\.trim\(\)\.length > 240/u);

  const repository = readFileSync(
    path.join(frontendRoot, "lib/server/access-control-repository.ts"),
    "utf8",
  );
  assert.match(repository, /p_guest_description: guestDescription/u);
});

test("direct project access rows expand for editing and warn before owner removal", () => {
  const source = readFileSync(
    path.join(frontendRoot, "components/admin/admin-console.tsx"),
    "utf8",
  );
  assert.match(source, /aria-expanded=\{projectExpanded\}/u);
  assert.match(source, /setExpandedProjectId/u);
  assert.match(source, /draftProjectRoles/u);
  assert.match(source, /ROLE_LABELS\[project\.role\][\s\S]*project\.name/u);
  assert.match(source, />\s*Rediger\s*</u);
  assert.match(source, /Lagre endring/u);
  assert.match(source, /Fjern tilgang/u);
  assert.match(source, /project\.role === "owner"/u);
  assert.match(
    source,
    /prosjektet uten prosjekteier/u,
  );
});

test("admin owner changes use one atomic database operation", () => {
  const repository = readFileSync(
    path.join(frontendRoot, "lib/server/access-control-repository.ts"),
    "utf8",
  );
  const updateStart = repository.indexOf(
    "export async function updateAdminManagedProjectMemberRole",
  );
  const revokeStart = repository.indexOf(
    "export async function revokeAdminManagedProjectMember",
  );
  const nextFunction = repository.indexOf(
    "export async function updateProjectGroupRole",
    revokeStart,
  );
  const updateBlock = repository.slice(updateStart, revokeStart);
  const revokeBlock = repository.slice(revokeStart, nextFunction);
  assert.match(updateBlock, /rpc\("set_admin_managed_project_access"/u);
  assert.match(updateBlock, /p_revoke: false/u);
  assert.match(revokeBlock, /rpc\("set_admin_managed_project_access"/u);
  assert.match(revokeBlock, /p_revoke: true/u);
  assert.doesNotMatch(repository, /releaseProjectOwnership/u);

  const route = readFileSync(
    path.join(
      frontendRoot,
      "app/api/admin/users/[principalId]/access/route.ts",
    ),
    "utf8",
  );
  assert.match(route, /await updateAdminManagedProjectMemberRole/u);
  assert.match(route, /await revokeAdminManagedProjectMember/u);
});

test("access listings fail closed and exclude expired grants", () => {
  const source = readFileSync(
    path.join(frontendRoot, "lib/server/access-control-repository.ts"),
    "utf8",
  );
  assert.match(source, /function activeAccessRows/u);
  assert.match(source, /new Date\(row\.expires_at\)\.getTime\(\) > now/u);

  const groupStart = source.indexOf("export async function getGroup");
  const groupEnd = source.indexOf("export async function createGroup", groupStart);
  const groupBlock = source.slice(groupStart, groupEnd);
  assert.match(groupBlock, /memberError/u);
  assert.match(groupBlock, /grantError/u);
  assert.match(groupBlock, /principalError/u);
  assert.match(groupBlock, /activeAccessRows\(grantRows\)/u);

  const principalStart = source.indexOf("export async function listPrincipals");
  const principalEnd = source.indexOf("export async function setAdminStatus", principalStart);
  const principalBlock = source.slice(principalStart, principalEnd);
  assert.match(principalBlock, /membershipError/u);
  assert.match(principalBlock, /groupGrantError/u);
  assert.match(principalBlock, /credentialError/u);
  assert.match(principalBlock, /activeAccessRows\(memberships\)/u);
  assert.match(principalBlock, /activeAccessRows\(groupGrants\)/u);

  const grantStart = source.indexOf("export async function grantPrincipalProjectAccess");
  const grantEnd = source.indexOf("export async function grantGroupProjectAccess", grantStart);
  assert.match(source.slice(grantStart, grantEnd), /expires_at: null/u);
});
