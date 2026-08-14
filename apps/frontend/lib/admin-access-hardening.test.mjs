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

test("direct access management cannot downgrade an existing project owner", () => {
  const source = readFileSync(
    path.join(frontendRoot, "lib/server/access-control-repository.ts"),
    "utf8",
  );
  const ownerGuard = source.indexOf('existingMembership?.role === "owner"');
  const membershipWrite = source.indexOf(
    'supabase.from("project_memberships").upsert',
    ownerGuard,
  );
  assert.ok(ownerGuard > 0);
  assert.ok(membershipWrite > ownerGuard);
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
