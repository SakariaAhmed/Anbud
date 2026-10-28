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
const { listProjectAccess, updateProjectMemberRole } = await jiti.import(
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
      const run = () => {
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
        eq(column, value) { filters.push((row) => row[column] === value); return query; },
        neq(column, value) { filters.push((row) => row[column] !== value); return query; },
        is(column, value) { filters.push((row) => (row[column] ?? null) === value); return query; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return query; },
        order() { return query; },
        limit(count) { limit = count; return query; },
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
