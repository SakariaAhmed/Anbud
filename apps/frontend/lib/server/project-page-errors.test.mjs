import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const frontend = path.resolve(import.meta.dirname, "../..");
class AuthorizationError extends Error {}
const missing = new Error("NEXT_NOT_FOUND");

function loadPage(relative, { accessError, repositoryError } = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(path.join(frontend, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const require = (name) => {
    if (name === "next/navigation") return { notFound() { throw missing; } };
    if (name === "next/headers") return { headers: async () => new Headers() };
    if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
    if (name === "@/lib/password-auth") return { AUTH_PRINCIPAL_HEADER: "x-principal" };
    if (name === "@/lib/server/authorization") return {
      AuthorizationError,
      requireProjectPermission: async () => {
        if (accessError) throw accessError;
        return { permissions: ["project.read"] };
      },
    };
    if (name === "@/lib/server/repositories/data-store") return {
      getProjectShell: async () => {
        if (repositoryError) throw repositoryError;
        return { id: "project", name: "Fiktivt prosjekt", customer_name: "Fiktiv kunde" };
      },
      listProjects: async () => [],
    };
    if (name.startsWith("@/components/projects/")) return {};
    throw new Error(`Unexpected import: ${name}`);
  };
  new vm.Script(`(function(require,exports){${source}\n})`, { filename: relative }).runInThisContext()(require, exports);
  return () => exports.default({ params: Promise.resolve({ id: "project" }), searchParams: Promise.resolve({}) });
}

for (const page of ["app/projects/[id]/page.tsx", "app/projects/[id]/chat/page.tsx"]) {
  test(`${page}: denied access remains a missing resource`, async () => {
    await assert.rejects(loadPage(page, { accessError: new AuthorizationError("Denied") }), (error) => error === missing);
  });
  test(`${page}: backend failures reach the error boundary instead of becoming404`, async () => {
    const unavailable = Object.assign(new Error("Safe retryable error"), { name: "AuthBackendError", status: 503 });
    await assert.rejects(loadPage(page, { accessError: unavailable }), (error) => error === unavailable);
    const storageFailure = new Error("Storage unavailable");
    await assert.rejects(loadPage(page, { repositoryError: storageFailure }), (error) => error === storageFailure);
  });
}
