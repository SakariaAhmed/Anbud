import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the admin landing page sends signed-in members home and preserves real failures", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bidsite-admin-landing-"));
  const authMock = path.join(directory, "authorization.cjs");
  const consoleMock = path.join(directory, "console.cjs");
  writeFileSync(authMock, `
    class AuthorizationError extends Error { constructor(status) { super("Access denied"); this.status = status; } }
    module.exports = { AuthorizationError, requireAdmin: async () => {
      const failure = globalThis.__bidsiteAdminLandingFailure;
      if (typeof failure === "number") throw new AuthorizationError(failure);
      if (failure) throw failure;
      return { isAdmin: true };
    }};
  `);
  writeFileSync(consoleMock, "exports.AdminConsole = function AdminConsole() { return null; };");
  const previousReact = globalThis.React;
  globalThis.React = require("react");
  try {
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      jsx: { runtime: "automatic" },
      alias: {
        "@/lib/server/authorization": authMock,
        "@/components/admin/admin-console": consoleMock,
        "@": frontendRoot,
      },
    });
    const { default: AdminPage } = jiti(path.join(frontendRoot, "app/admin/page.tsx"));
    globalThis.__bidsiteAdminLandingFailure = 403;
    await assert.rejects(AdminPage(), error => error.digest === "NEXT_REDIRECT;replace;/;307;");

    globalThis.__bidsiteAdminLandingFailure = 401;
    await assert.rejects(AdminPage(), error => error.digest === "NEXT_HTTP_ERROR_FALLBACK;404");

    const databaseFailure = new Error("Database unavailable");
    globalThis.__bidsiteAdminLandingFailure = databaseFailure;
    await assert.rejects(AdminPage(), error => error === databaseFailure);

    globalThis.__bidsiteAdminLandingFailure = null;
    const result = await AdminPage();
    assert.equal(result.type.name, "AdminConsole");
  } finally {
    delete globalThis.__bidsiteAdminLandingFailure;
    if (previousReact === undefined) delete globalThis.React;
    else globalThis.React = previousReact;
    rmSync(directory, { recursive: true, force: true });
  }
});
