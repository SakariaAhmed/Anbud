import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const root = path.resolve(import.meta.dirname, "../..");
const { listAccessibleProjectIds } = createJiti(import.meta.url, { alias: { "@": root, "server-only": "/dev/null" } })("./authorization.ts");
const id = (prefix, n) => `${prefix}-${String(n).padStart(5, "0")}`;
function environment(t) {
  const env = { DATA_API_URL: "https://access-list.test.invalid", DATA_API_SERVICE_ROLE_KEY: "synthetic-test-key" };
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
test("all active direct, group and owned projects survive response caps and historical grants", async (t) => {
  environment(t);
  const active = { revoked_at: null, expires_at: null }, expired = { revoked_at: null, expires_at: "2000-01-01T00:00:00Z" }, revoked = { revoked_at: "2020-01-01T00:00:00Z", expires_at: null };
  const direct = Array.from({ length: 1_101 }, (_, i) => ({ project_id: id("direct", i), ...active }));
  const memberships = [...Array.from({ length: 1_100 }, (_, i) => ({ project_id: id("historical", i), ...(i % 2 ? expired : revoked) })), ...direct];
  const groups = Array.from({ length: 1_101 }, (_, i) => ({ group_id: id("group", i) }));
  const grants = [
    ...Array.from({ length: 1_100 }, (_, i) => ({ project_id: id("historical-grant", i), group_id: groups[0].group_id, ...revoked })),
    ...Array.from({ length: 1_101 }, (_, i) => ({ project_id: id("shared", i), group_id: groups[0].group_id, ...active })),
    { project_id: "last-group-project", group_id: groups.at(-1).group_id, ...active },
    { project_id: "unauthorized-project", group_id: "not-a-member", ...active },
    { project_id: "expired-group-project", group_id: groups[0].group_id, ...expired },
  ];
  const owned = Array.from({ length: 1_101 }, (_, i) => ({ id: id("owned", i) }));
  const tables = { "/project_memberships": memberships, "/app_group_members": groups, "/project_group_grants": grants, "/projects": owned }, pages = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input); assert.equal(url.origin, process.env.DATA_API_URL);
    const q = url.searchParams, [from, to] = init.headers.get("Range").split("-").map(Number);
    assert.ok(to - from + 1 <= 1_000); pages.push({ path: url.pathname, from }); let rows = [...tables[url.pathname]];
    if (url.pathname === "/project_memberships" || url.pathname === "/project_group_grants") {
      assert.equal(q.get("revoked_at"), "is.null"); assert.match(q.get("or"), /^\(expires_at\.is\.null,expires_at\.gt\./u);
      const now = Date.parse(q.get("or").match(/expires_at\.gt\.([^)]*)/u)[1]);
      rows = rows.filter((row) => !row.revoked_at && (!row.expires_at || Date.parse(row.expires_at) > now));
    }
    if (url.pathname === "/project_group_grants") {
      const allowed = JSON.parse(`[${q.get("group_id").slice(4, -1)}]`); assert.ok(allowed.length <= 100);
      rows = rows.filter((row) => allowed.includes(row.group_id));
    } else assert.equal(q.get(url.pathname === "/projects" ? "owner_id" : "principal_id"), "eq.synthetic-principal");
    const order = q.get("order").split(",").map((field) => field.split(".")[0]);
    rows.sort((a, b) => { for (const field of order) { const value = a[field].localeCompare(b[field]); if (value) return value; } return 0; });
    return Response.json(rows.slice(from, Math.min(to + 1, from + 1_000)));
  });
  const result = await listAccessibleProjectIds("synthetic-principal");
  assert.equal(result.length, 3_304);
  assert.ok(result.includes(direct.at(-1).project_id)); assert.ok(result.includes(owned.at(-1).id)); assert.ok(result.includes("last-group-project")); assert.ok(result.includes(id("shared", 1_100)));
  assert.equal(result.includes("unauthorized-project"), false); assert.equal(result.some((value) => value.startsWith("historical")), false); assert.equal(result.includes("expired-group-project"), false);
  for (const table of Object.keys(tables)) assert.ok(pages.some((page) => page.path === table && page.from >= 1_000), table);
});
test("an access-list page failure cannot return a partial list", async (t) => {
  environment(t); t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input); assert.equal(url.origin, process.env.DATA_API_URL);
    if (url.pathname !== "/project_memberships") return Response.json([]);
    if (init.headers.get("Range") === "0-499") return Response.json(Array.from({ length: 500 }, (_, i) => ({ project_id: id("project", i) })));
    return Response.json({ code: "TEST503" }, { status: 503 });
  });
  await assert.rejects(listAccessibleProjectIds("synthetic-principal"), { status: 503 });
});
test("global administrators retain unrestricted enumeration without database reads", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("admin enumeration should not query grants"));
  assert.equal(await listAccessibleProjectIds("synthetic-principal", { admin: true }), null);
});
