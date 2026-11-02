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
function harness({ role = null, admin = false, active = true, disabled = false, expired = false, roleError = false } = {}) {
  const calls = [], dataCalls = [], cache = new Map();
  const db = { rpc(name, input) {
    assert.equal(name, "resolve_project_role");
    calls.push({ rpc: name, filters: { project_id: input.p_project_id, principal_id: input.p_principal_id } });
    return Promise.resolve({ data: role, error: roleError ? { message: "Role lookup unavailable" } : null });
  }, from(table) {
    const filters = {};
    const result = () => {
      calls.push({ table, filters: { ...filters } });
      const data = table === "app_sessions" ? { expires_at: expired ? "2020-01-01" : "2999-01-01", revoked_at: active ? null : "2020-01-01" }
        : table === "app_principals" ? { identity_type: "internal", disabled_at: disabled ? "2020-01-01" : null }
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
    if (name === "DirectSolutionEvaluationWaitTimeoutError") return class extends Error {};
    return (...args) => {
      dataCalls.push({ name, args });
      if (name === "getDocumentDetail") return { file_base64: Buffer.from("Synthetic source").toString("base64"), file_name: "kilde.txt", file_format: "txt" };
      if (name === "contentTypeForUploadFormat") return "text/plain";
      return String(name).startsWith("list") ? [] : null;
    };
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
      if (["@/lib/server/authorization", "@/lib/access-control", "@/lib/middleware-project-authorization", "@/lib/server/project-ai-route", "@/lib/server/api-responses", "@/lib/server/request-body", "@/lib/server/workflow-errors", "@/lib/server/database-update-required", "@/lib/unknown-values", "@/lib/types"].includes(name)) return load(`${name.slice(2)}.ts`);
      if (name === "@/lib/server/multipart") return { MultipartRequestError: class MultipartRequestError extends Error {} };
      return service;
    };
    new vm.Script(`(function(require,exports){${source}\n})`, { filename: relative }).runInThisContext()(resolve, exports);
    return exports;
  }
  return { load, calls, dataCalls };
}
const endpoints = [
  ["chat", "GET"], ["chat", "POST"], ["generate", "GET"], ["generate", "PATCH"], ["generate", "DELETE"], ["generate", "POST"],
  ["documents", "POST"], ["requirement-register", "GET"], ["source-evidence", "POST"], ["performance", "POST"], ["service-descriptions", "GET"], ["service-descriptions", "PATCH"], ["artifact-authority", "GET"],
  ["executive-summary", "GET"], ["executive-summary", "POST"], ["solution-evaluation", "GET"], ["solution-evaluation", "POST"],
  ["customer-analysis", "GET"], ["customer-analysis", "POST"], ["customer-analysis", "PUT"],
  ["jobs", "GET"], ["jobs", "POST"], ["jobs/[jobId]", "GET"], ["jobs/[jobId]/events", "GET"],
  ["documents/[documentId]", "GET"], ["documents/[documentId]", "DELETE"], ["documents/[documentId]", "PATCH"],
];
async function invoke(h, route, method, id) {
  const handler = h.load(`app/api/projects/[id]/${route}/route.ts`)[method];
  const request = new Request(`http://localhost/api/projects/${id}/${route}`, { method, ...(method === "GET" ? {} : { body: JSON.stringify({ artifact_id: "artifact-test" }), headers: { "content-type": "application/json" } }) });
  return handler(request, { params: Promise.resolve({ id, jobId: "job-test", documentId: "document-test" }) });
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
test("expired sessions and disabled principals cannot reach project reads or mutations", async () => {
  for (const identity of [{ expired: true }, { disabled: true }]) {
    for (const [route, method] of [["chat", "POST"], ["generate", "POST"], ["documents/[documentId]", "GET"]]) {
      const h = harness({ role: "owner", admin: true, ...identity });
      assert.equal((await invoke(h, route, method, projectId)).status, 401);
      assert.deepEqual(h.dataCalls, []);
    }
  }
});

test("restricted viewers cannot download source documents or write chat and generation", async () => {
  for (const [route, method] of [["documents/[documentId]", "GET"], ["chat", "POST"], ["generate", "POST"], ["jobs", "POST"]]) {
    const h = harness({ role: "restricted_viewer" });
    assert.equal((await invoke(h, route, method, projectId)).status, 403);
    assert.deepEqual(h.dataCalls, []);
  }
});

test("global administrators can download source documents without a project grant", async () => {
  const h = harness({ admin: true });
  const response = await invoke(h, "documents/[documentId]", "GET", projectId);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Synthetic source");
  assert.match(response.headers.get("content-disposition"), /^attachment;/u);
  assert.ok(h.dataCalls.some(call => call.name === "getDocumentDetail"));
});

test("inline source opening preserves original bytes and the same download permission", async () => {
  for (const options of [{ admin: true }, { role: "viewer" }, { role: "restricted_viewer" }]) {
    const h = harness(options);
    const { GET } = h.load("app/api/projects/[id]/documents/[documentId]/route.ts");
    const response = await GET(new Request(`http://localhost/api/projects/${projectId}/documents/document-test?disposition=inline`), { params: Promise.resolve({ id: projectId, documentId: "document-test" }) });
    const allowed = options.admin || options.role === "viewer";
    assert.equal(response.status, allowed ? 200 : 403);
    if (allowed) {
      assert.match(response.headers.get("content-disposition"), /^inline;/u);
      assert.equal(await response.text(), "Synthetic source");
    } else assert.deepEqual(h.dataCalls, []);
  }
});

test("revision-bound source opening refuses changed documents and invalid revision inputs", async () => {
  for (const [revision, status] of [["0", 200], ["1", 409], ["-1", 400], ["9007199254740992", 400], ["2abc", 400]]) {
    const h = harness({ role: "viewer" });
    const { GET } = h.load("app/api/projects/[id]/documents/[documentId]/route.ts");
    const response = await GET(new Request(`http://localhost/api/projects/${projectId}/documents/document-test?disposition=inline&source_revision=${revision}`), { params: Promise.resolve({ id: projectId, documentId: "document-test" }) });
    assert.equal(response.status, status);
    if (status !== 200) assert.doesNotMatch(await response.text(), /Synthetic source/u);
  }
});

test("admin invitations reject invalid group scope before creating credentials or sending mail", async () => {
  const h = harness({ admin: true });
  const { POST } = h.load("app/api/admin/users/route.ts");
  const response = await POST(new Request("http://localhost/api/admin/users", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "guest@example.test", displayName: "Test guest", guestDescription: "External reviewer", projectGrants: [{ projectId, role: "viewer" }], groupIds: ["unknown-group"] }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(h.dataCalls.map(call => call.name), ["listGroups"]);
});

test("non-admin invitations are denied before any invitation data access", async () => {
  const h = harness({ role: "owner" });
  const { POST } = h.load("app/api/admin/users/route.ts");
  const response = await POST(new Request("http://localhost/api/admin/users", { method: "POST", body: "{}" }));
  assert.equal(response.status, 403);
  assert.deepEqual(h.dataCalls, []);
});
test("role lookup failures and malformed roles fail closed before project data access", async () => {
  for (const options of [{ role: "editor", roleError: true }, { role: "unknown-role" }, { role: { role: "owner" } }]) {
    const h = harness(options);
    const response = await invoke(h, "chat", "GET", projectId);
    assert.equal(response.status, 500);
    assert.deepEqual(h.dataCalls, []);
  }
});
test("restricted viewers cannot delete artifacts; global admins and editors can", async () => {
  for (const options of [{ role: "restricted_viewer" }, { admin: true }, { admin: true, role: "restricted_viewer" }, { role: "editor" }]) {
    const h = harness(options);
    const allowed = options.admin === true || options.role === "editor";
    assert.equal((await invoke(h, "generate", "DELETE", projectId)).status, allowed ? 200 : 403);
    assert.equal(h.dataCalls.some(({ name }) => name === "deleteGeneratedArtifact"), allowed);
  }
});
test("artifact GET keeps a filter for every stored artifact type", async () => {
  // Legacy types are readable even though they can no longer be generated.
  const h = harness({ role: "viewer" });
  const { GET } = h.load("app/api/projects/[id]/generate/route.ts");
  await GET(new Request(`http://localhost/api/projects/${projectId}/generate?artifact_type=tilbudsstrategi`), { params: Promise.resolve({ id: projectId }) });
  const listCall = h.dataCalls.find(({ name }) => name === "listGeneratedArtifactsFresh");
  assert.deepEqual(listCall?.args[1], { artifactType: "tilbudsstrategi" });
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
