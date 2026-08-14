import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migrationPath = path.resolve(
  frontendRoot,
  "../../supabase/migrations/20260809141303_guest_rbac_superuser_insights.sql",
);
const sql = await readFile(migrationPath, "utf8");
const adminOnlySql = await readFile(
  path.resolve(
    frontendRoot,
    "../../supabase/migrations/20260812012210_admin_only_password_access.sql",
  ),
  "utf8",
);
const simplifiedSessionSql = await readFile(
  path.resolve(
    frontendRoot,
  "../../supabase/migrations/20260812020933_simplify_admin_sessions.sql",
  ),
  "utf8",
);
const guestDescriptionSql = await readFile(
  path.resolve(
    frontendRoot,
    "../../supabase/migrations/20260814183208_require_guest_name_description.sql",
  ),
  "utf8",
);

test("access migration contains the complete authorization model", () => {
  for (const relation of [
    "app_principals",
    "app_principal_aliases",
    "app_sessions",
    "app_groups",
    "app_group_members",
    "project_memberships",
    "project_group_grants",
    "guest_credentials",
    "activity_events",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${relation}`));
  }
});

test("follow-up migration removes super-user and permits admin password sessions", () => {
  assert.match(adminOnlySql, /delete from public\.app_principal_roles[\s\S]+role = 'super_user'/iu);
  assert.match(adminOnlySql, /check \(role = 'admin'\)/iu);
  assert.match(adminOnlySql, /'admin_password'/u);
  assert.match(
    adminOnlySql,
    /where requested\.role <> 'admin'/u,
  );
});

test("session simplification retires legacy auth and narrows the admin RPC", () => {
  assert.match(simplifiedSessionSql, /auth_method = 'development_password'/u);
  assert.match(
    simplifiedSessionSql,
    /check \(auth_method in \('entra', 'guest_code', 'admin_password'\)\)/u,
  );
  assert.match(simplifiedSessionSql, /security invoker/iu);
  assert.match(simplifiedSessionSql, /create or replace function public\.set_principal_admin/iu);
  assert.match(simplifiedSessionSql, /grant execute[\s\S]+to service_role/iu);
  assert.match(
    simplifiedSessionSql,
    /revoke execute on function public\.replace_principal_roles[\s\S]*?from public, anon, authenticated/iu,
  );
});

test("new access tables are RLS protected and service-role explicit", () => {
  assert.match(sql, /enable row level security/iu);
  assert.match(sql, /revoke all on table public\.guest_credentials/iu);
  assert.match(sql, /grant select, insert, update, delete[\s\S]+to service_role/iu);
  assert.match(sql, /revoke execute on function public\.resolve_app_session/iu);
});

test("guest rotation revokes sessions and project ownership is synchronized", () => {
  assert.match(
    sql,
    /create or replace function public\.rotate_guest_credential[\s\S]+update public\.app_sessions/iu,
  );
  assert.match(sql, /create trigger projects_sync_owner_membership/iu);
  assert.match(sql, /create or replace function public\.replace_group_members/iu);
  assert.match(sql, /create or replace function public\.replace_principal_roles/iu);
  assert.match(sql, /create or replace function public\.upsert_internal_principal/iu);
});

test("guest creation requires and persists a bounded name and description", () => {
  assert.match(
    guestDescriptionSql,
    /add column if not exists guest_description text/iu,
  );
  assert.match(
    guestDescriptionSql,
    /guest_description is not null[\s\S]+between 3 and 240/iu,
  );
  assert.match(
    guestDescriptionSql,
    /p_display_name[\s\S]+p_guest_description[\s\S]+btrim\(p_guest_description\)/iu,
  );
  assert.match(
    guestDescriptionSql,
    /drop function if exists public\.grant_guest_project_access/iu,
  );
  assert.match(
    guestDescriptionSql,
    /revoke execute[\s\S]+from public, anon, authenticated/iu,
  );
});
