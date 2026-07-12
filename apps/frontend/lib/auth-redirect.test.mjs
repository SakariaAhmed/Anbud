import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { safeRedirectPath } = jiti(path.join(__dirname, "auth-redirect.ts"));

test("safe redirect preserves local paths and query parameters", () => {
  assert.equal(
    safeRedirectPath("/projects/example?tab=analysis#result"),
    "/projects/example?tab=analysis#result",
  );
});

test("safe redirect rejects external, auth, API, and backslash paths", () => {
  for (const value of [
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/api/projects",
    "/login?next=/projects",
    "/login/retry",
  ]) {
    assert.equal(safeRedirectPath(value), "/");
  }
});
