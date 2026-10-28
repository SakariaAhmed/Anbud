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

// Loads the real route module; only its server dependencies are replaced.
function loadRoute(relative, modules) {
  const source = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const routeModule = { exports: {} };
  vm.runInNewContext(source, {
    module: routeModule, exports: routeModule.exports, URL, Response, Request,
    require: (name) => {
      if (name === "next/server") return { NextResponse };
      if (name in modules) return modules[name];
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return routeModule.exports;
}

function activityRoute(calls) {
  return loadRoute("app/api/admin/activity/route.ts", {
    "@/lib/server/activity": { listActivity: async (input) => { calls.push(input); return []; } },
    "@/lib/server/authorization": { requireAdmin: async () => ({}), authorizationErrorResponse: () => null },
  });
}

test("admin activity uses the repository default when limit is absent", async () => {
  const calls = [];
  const { GET } = activityRoute(calls);
  await GET(new Request("http://localhost/api/admin/activity?projectId=synthetic"));
  await GET(new Request("http://localhost/api/admin/activity?limit=0"));
  await GET(new Request("http://localhost/api/admin/activity?limit=abc"));
  await GET(new Request("http://localhost/api/admin/activity?limit=50"));
  assert.deepEqual(calls.map((call) => call.limit), [undefined, undefined, undefined, 50]);
});

test("the identity-specific project list is never stored by the browser cache", async () => {
  const { GET } = loadRoute("app/api/projects/route.ts", {
    "@/lib/server/repositories/data-store": { listProjects: async () => [], createProject: async () => null },
    "@/lib/server/authorization": {
      requireRequestPrincipal: async () => ({ id: "synthetic-principal", isAdmin: false }),
      authorizationErrorResponse: () => null,
    },
    "@/lib/server/activity": { recordActivity: async () => undefined },
    "@/lib/server/observability": {
      auditEvent: () => undefined, checkRateLimit: async () => ({ allowed: true }), withTiming: (_, __, fn) => fn(),
    },
    "@/lib/server/safe-errors": { productionSafeErrorMessage: (_, fallback) => fallback },
  });
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
