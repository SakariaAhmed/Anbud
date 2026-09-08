import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const { NextResponse } = require("next/server");
const projectId = "123e4567-e89b-12d3-a456-426614174000";

// Real route and authorization code; only external services are replaced.
function harness({ role = null, admin = false, active = true, roleError = false } = {}) {
  const calls = [], dataCalls = [], cache = new Map();
  const db = { rpc(name, input) {
    assert.equal(name, "resolve_project_role");
    calls.push({ rpc: name, filters: { project_id: input.p_project_id, principal_id: input.p_principal_id } });
    return Promise.resolve({ data: role, error: roleError ? { message: "Role lookup unavailable" } : null });
  }, from(table) {
    const filters = {};
    const result = () => {
      calls.push({ table, filters: { ...filters } });
      const data = table === "app_sessions" ? { expires_at: "2999-01-01", revoked_at: active ? null : "2020-01-01" }
        : table === "app_principals" ? { identity_type: "internal", disabled_at: null }
        : table === "app_principal_roles" ? (admin ? [{ role: "admin" }] : [])
        : table === "projects" ? { owner_id: null }
        : table === "project_memberships" && role ? [{ role, revoked_at: null, expires_at: null }] : [];
      return { data, error: null };
    };
    const query = { select() { return query; }, eq(key, value) { filters[key] = value; return query; }, in() { return query; }, maybeSingle() { return Promise.resolve(result()); }, then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); } };
    return query;
  } };
  const service = new Proxy({}, { get(_, name) {
    if (name === "checkRateLimit") return async () => ({ allowed: true });
    if (name === "productionSafeErrorMessage") return (_, fallback) => fallback;
    if (name === "workflowErrorStatus") return () => 500;
    if (name === "withTiming") return (_, __, fn) => fn();
    return (...args) => { dataCalls.push({ name, args }); return String(name).startsWith("list") ? [] : null; };
  } });
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const exports = {}; cache.set(relative, exports);
    const source = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const resolve = (name) => {
      if (name === "next/server") return { NextResponse };
      if (name === "server-only") return {};
      if (name === "next/headers") return { headers: async () => new Headers({ "x-principal": "principal", "x-session": "session" }) };
      if (name === "@/lib/password-auth") return { AUTH_PRINCIPAL_HEADER: "x-principal", AUTH_SESSION_HEADER: "x-session" };
      if (name === "@/lib/server/data-api") return { createServiceClient: () => db };
      if (["@/lib/server/authorization", "@/lib/access-control", "@/lib/middleware-project-authorization", "@/lib/server/project-ai-route", "@/lib/server/api-responses"].includes(name)) return load(`${name.slice(2)}.ts`);
      return service;
    };
    new vm.Script(`(function(require,exports){${source}\n})`, { filename: relative }).runInThisContext()(resolve, exports);
    return exports;
  }
  return { load, calls, dataCalls };
}
const endpoints = [
  ["chat", "GET"], ["chat", "POST"], ["generate", "GET"], ["generate", "PATCH"], ["generate", "DELETE"], ["generate", "POST"],
  ["documents", "POST"], ["service-descriptions", "GET"], ["service-descriptions", "PATCH"], ["artifact-authority", "GET"],
  ["executive-summary", "GET"], ["executive-summary", "POST"], ["solution-evaluation", "GET"], ["solution-evaluation", "POST"],
  ["customer-analysis", "GET"], ["customer-analysis", "POST"], ["customer-analysis", "PUT"],
  ["jobs", "GET"], ["jobs", "POST"], ["jobs/[jobId]", "GET"], ["jobs/[jobId]/events", "GET"],
];
async function invoke(h, route, method, id) {
  const handler = h.load(`app/api/projects/[id]/${route}/route.ts`)[method];
  const request = new Request(`http://localhost/api/projects/${id}/${route}`, { method, ...(method === "GET" ? {} : { body: JSON.stringify({ artifact_id: "artifact-test" }), headers: { "content-type": "application/json" } }) });
  return handler(request, { params: Promise.resolve({ id, jobId: "job-test" }) });
}
test("ungranted project handlers deny canonical and alternate UUIDs before data access", async () => {
  for (const id of [projectId, projectId.toUpperCase(), projectId.replaceAll("-", ""), `{${projectId}}`, "%31" + projectId.slice(1)]) {
    for (const [route, method] of endpoints) {
      const h = harness(), response = await invoke(h, route, method, id);
      assert.ok([403, 404].includes(response.status), `${method} ${route} ${id}: ${response.status}`);
      assert.deepEqual(h.dataCalls, [], `${method} ${route} touched project data`);
    }
  }
});
test("revoked sessions cannot read chat or delete artifacts with editor grants", async () => {
  for (const [route, method] of [["chat", "GET"], ["generate", "DELETE"]]) {
    const h = harness({ role: "editor", active: false });
    assert.equal((await invoke(h, route, method, projectId)).status, 401);
    assert.deepEqual(h.dataCalls, []);
  }
});
test("role lookup failures and malformed roles fail closed before project data access", async () => {
  for (const options of [{ role: "editor", roleError: true }, { role: "unknown-role" }, { role: { role: "owner" } }]) {
    const h = harness(options);
    const response = await invoke(h, "chat", "GET", projectId);
    assert.equal(response.status, 500);
    assert.deepEqual(h.dataCalls, []);
  }
});
test("restricted viewers and global admins cannot delete artifacts; editors can", async () => {
  for (const options of [{ role: "restricted_viewer" }, { admin: true }, { role: "editor" }]) {
    const h = harness(options);
    assert.equal((await invoke(h, "generate", "DELETE", projectId)).status, options.role === "editor" ? 200 : 403);
    assert.equal(h.dataCalls.some(({ name }) => name === "deleteGeneratedArtifact"), options.role === "editor");
  }
});
test("permitted reads retain role and uppercase UUID compatibility", async () => {
  for (const options of [{ role: "restricted_viewer" }, { role: "viewer" }, { admin: true }]) {
    for (const route of ["chat", "generate"]) {
      const h = harness(options);
      assert.equal((await invoke(h, route, "GET", projectId.toUpperCase())).status, 200);
      assert.ok(h.dataCalls.some(({ name }) => String(name).startsWith("list")));
      assert.ok(h.calls.filter(({ filters }) => filters.project_id).every(({ filters }) => filters.project_id === projectId));
    }
  }
});
