import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migration = readFileSync(
  path.resolve(
    frontendRoot,
    "../../database/migrations/20260814173500_single_admin_and_group_access.sql",
  ),
  "utf8",
);
const atomicAccessMigration = readFileSync(
  path.resolve(
    frontendRoot,
    "../../database/migrations/20260823202459_atomic_access_management.sql",
  ),
  "utf8",
);

test("database enforces a singleton administrator and locks demotion", () => {
  assert.match(migration, /unique index[^;]+single_admin/is);
  assert.match(migration, /where role = 'admin'/i);
  assert.match(migration, /if not p_is_admin then\s+raise exception/i);
  assert.match(migration, /delete from public\.app_principal_roles[\s\S]+principal_id <> p_principal_id/i);
  assert.match(migration, /update public\.app_sessions[\s\S]+revoked_at/i);
});

test("group project access replacement is transactional and service-role only", () => {
  assert.match(migration, /function public\.replace_group_project_access/i);
  assert.match(migration, /duplicate project grant/i);
  assert.match(migration, /on conflict \(project_id, group_id\) do update/i);
  assert.match(
    migration,
    /revoke execute on function public\.replace_group_project_access[^;]+from public, anon, authenticated/is,
  );
  assert.match(
    migration,
    /grant execute on function public\.replace_group_project_access[^;]+to service_role/is,
  );
});

test("multi-project invitations commit projects and groups in one RPC", () => {
  assert.match(
    atomicAccessMigration,
    /function public\.grant_guest_project_access_batch/i,
  );
  assert.match(atomicAccessMigration, /p_project_ids uuid\[\]/i);
  assert.match(atomicAccessMigration, /p_group_ids uuid\[\]/i);
  assert.match(
    atomicAccessMigration,
    /where project\.id = any[\s\S]+order by project\.id[\s\S]+for update/i,
  );
  assert.match(
    atomicAccessMigration,
    /insert into public\.project_memberships[\s\S]+insert into public\.app_group_members/i,
  );
  assert.match(
    atomicAccessMigration,
    /revoke execute on function public\.grant_guest_project_access_batch[^;]+from public, anon, authenticated/is,
  );
  assert.match(
    atomicAccessMigration,
    /grant execute on function public\.grant_guest_project_access_batch[^;]+to service_role/is,
  );
});

test("administrator-managed ownership changes are locked and atomic", () => {
  assert.match(
    atomicAccessMigration,
    /function public\.set_admin_managed_project_access/i,
  );
  assert.match(
    atomicAccessMigration,
    /from public\.projects project[\s\S]+for update/i,
  );
  assert.match(atomicAccessMigration, /set owner_id = null/i);
  assert.match(
    atomicAccessMigration,
    /perform public\.revoke_project_member_access/i,
  );
  assert.match(
    atomicAccessMigration,
    /revoke execute on function public\.set_admin_managed_project_access[^;]+from public, anon, authenticated/is,
  );
  assert.match(
    atomicAccessMigration,
    /grant execute on function public\.set_admin_managed_project_access[^;]+to service_role/is,
  );
});
