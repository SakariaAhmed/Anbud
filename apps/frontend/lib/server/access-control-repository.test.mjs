import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = mkdtempSync(path.join(tmpdir(), "access-repository-test-"));
writeFileSync(path.join(directory, "data-api.cjs"),
  "exports.createServiceClient = () => globalThis.__accessRepositoryTestClient;");
const jiti = createJiti(path.join(directory, "test.cjs"), {
  moduleCache: false,
  alias: {
    "@/lib/server/data-api": path.join(directory, "data-api.cjs"),
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});
const { grantPrincipalProjectAccess, listProjectAccess, updateProjectMemberRole } = await jiti.import(
  path.join(frontendRoot, "lib/server/access-control-repository.ts"),
);
test.after(() => rmSync(directory, { recursive: true, force: true }));

// Applies the PostgREST filters the repository builds to in-memory rows.
function fakeClient(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      let limit = Infinity;
      let update = null;
      let selected = false;
      let upsert = null;
      const run = () => {
        if (upsert) {
          const existing = (tables[table] ?? []).find(row => row.project_id === upsert.project_id && row.principal_id === upsert.principal_id);
          if (existing) Object.assign(existing, upsert);
          else (tables[table] ??= []).push({ ...upsert });
          calls.push({ table, upsert });
          return { data: null, error: null };
        }
        let rows = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
        if (update) {
          rows.forEach((row) => Object.assign(row, update));
          calls.push({ table, update, matched: rows.length });
          return { data: selected ? rows : null, error: null };
        }
        return { data: rows.slice(0, limit), error: null };
      };
      const query = {
        select() { selected = true; return query; },
        update(values) { update = values; return query; },
        upsert(values) { upsert = values; return query; },
        eq(column, value) { filters.push((row) => row[column] === value); return query; },
        neq(column, value) { filters.push((row) => row[column] !== value); return query; },
        is(column, value) { filters.push((row) => (row[column] ?? null) === value); return query; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return query; },
        order() { return query; },
        limit(count) { limit = count; return query; },
        single() { const result = run(); return Promise.resolve({ ...result, data: result.data?.[0] ?? null }); },
        maybeSingle() { const result = run(); return Promise.resolve({ ...result, data: result.data?.[0] ?? null }); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return query;
    },
  };
}

test("project members keep their identity when they fall outside the candidate page", async () => {
  const principals = Array.from({ length: 501 }, (_, index) => ({
    id: `principal-${String(index).padStart(3, "0")}`,
    identity_type: "internal",
    display_name: `Person ${String(index).padStart(3, "0")}`,
    disabled_at: null,
  }));
  globalThis.__accessRepositoryTestClient = fakeClient({
    project_memberships: [{ project_id: "project-1", principal_id: "principal-500", role: "editor", revoked_at: null }],
    project_group_grants: [],
    app_principals: principals,
    app_principal_roles: [],
  });
  const access = await listProjectAccess("project-1");
  assert.equal(access.members[0].principal?.display_name, "Person 500");
  assert.equal(access.availablePrincipals.length, 500);
});

test("a role update never rewrites the owner's membership row", async () => {
  const memberships = [
    { project_id: "project-1", principal_id: "owner", role: "owner", revoked_at: null },
    { project_id: "project-1", principal_id: "editor", role: "editor", revoked_at: null },
  ];
  globalThis.__accessRepositoryTestClient = fakeClient({ project_memberships: memberships });
  await assert.rejects(
    updateProjectMemberRole({ projectId: "project-1", principalId: "owner", role: "viewer" }),
    /Fant ingen aktiv medlemsrolle/u,
  );
  assert.equal(memberships[0].role, "owner");
  await updateProjectMemberRole({ projectId: "project-1", principalId: "editor", role: "viewer" });
  assert.equal(memberships[1].role, "viewer");
});

test("ordinary grants reject an existing owner before any membership upsert", async () => {
  const owner = { project_id: "project-1", principal_id: "owner", role: "owner", revoked_at: null };
  const client = fakeClient({
    app_principals: [{ id: "owner", disabled_at: null }],
    project_memberships: [owner],
  });
  globalThis.__accessRepositoryTestClient = client;
  await assert.rejects(grantPrincipalProjectAccess({ projectId: "project-1", principalId: "owner", role: "viewer", grantedBy: "actor" }), /Eierrollen kan ikke endres/u);
  assert.equal(owner.role, "owner");
  assert.deepEqual(client.calls, []);
});

test("ordinary grants reject a disabled person before any membership mutation", async () => {
  const client = fakeClient({ app_principals: [{ id: "disabled", disabled_at: "2020-01-01" }] });
  globalThis.__accessRepositoryTestClient = client;
  await assert.rejects(grantPrincipalProjectAccess({ projectId: "project-1", principalId: "disabled", role: "viewer", grantedBy: "actor" }), /Brukeren er ikke aktiv/u);
  assert.deepEqual(client.calls, []);
});

test("ordinary grants still update a permitted non-owner", async () => {
  const member = { project_id: "project-1", principal_id: "member", role: "viewer", revoked_at: null };
  const client = fakeClient({ app_principals: [{ id: "member", disabled_at: null }], project_memberships: [member] });
  globalThis.__accessRepositoryTestClient = client;
  await grantPrincipalProjectAccess({ projectId: "project-1", principalId: "member", role: "editor", grantedBy: "actor" });
  assert.equal(member.role, "editor");
  assert.equal(client.calls.length, 1);
});

test("expired direct and group grants disappear from access listings", async () => {
  globalThis.__accessRepositoryTestClient = fakeClient({
    project_memberships: [
      { project_id: "project-1", principal_id: "expired", role: "editor", revoked_at: null, expires_at: "2020-01-01" },
      { project_id: "project-1", principal_id: "active", role: "viewer", revoked_at: null, expires_at: "2999-01-01" },
    ],
    project_group_grants: [
      { project_id: "project-1", group_id: "expired-group", role: "editor", revoked_at: null, expires_at: "2020-01-01" },
      { project_id: "project-1", group_id: "active-group", role: "viewer", revoked_at: null, expires_at: null },
    ],
    app_principals: [{ id: "active", disabled_at: null }],
    app_groups: [{ id: "active-group", name: "Active group" }],
  });
  const access = await listProjectAccess("project-1");
  assert.deepEqual(access.members.map(row => row.principal_id), ["active"]);
  assert.deepEqual(access.groups.map(row => row.group_id), ["active-group"]);
});
