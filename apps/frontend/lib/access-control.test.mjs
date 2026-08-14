import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@": frontendRoot },
});
const access = jiti(path.join(frontendRoot, "lib/access-control.ts"));

test("admin is the only global role", () => {
  assert.equal(access.ADMIN_ROLE, "admin");
  assert.equal(access.isAdminRole("admin"), true);
  assert.equal(access.isAdminRole("super_user"), false);
});

test("global admin policy permits reads and sharing only", () => {
  for (const permission of [
    "project.read",
    "document.download",
    "analysis.read",
    "project.share",
  ]) {
    assert.equal(access.globalAccessAllows(true, permission), true);
  }
  for (const permission of [
    "project.update",
    "project.delete",
    "document.upload",
    "analysis.write",
  ]) {
    assert.equal(access.globalAccessAllows(true, permission), false);
    assert.equal(access.globalAccessAllows(false, permission), false);
  }
});

test("project role hierarchy selects the strongest direct or group role", () => {
  assert.equal(
    access.strongestProjectRole([
      "restricted_viewer",
      "editor",
      "viewer",
    ]),
    "editor",
  );
  assert.equal(access.strongestProjectRole([]), null);
});

test("restricted viewers cannot download and viewers cannot write", () => {
  assert.equal(
    access.projectRoleAllows("restricted_viewer", "document.read"),
    true,
  );
  assert.equal(
    access.projectRoleAllows("restricted_viewer", "document.download"),
    false,
  );
  assert.equal(access.projectRoleAllows("viewer", "document.download"), true);
  assert.equal(access.projectRoleAllows("viewer", "analysis.write"), false);
  assert.equal(access.projectRoleAllows("editor", "analysis.write"), true);
});

test("only owners can change project sharing", () => {
  assert.equal(access.projectRoleAllows("editor", "project.share"), false);
  assert.equal(access.projectRoleAllows("owner", "project.share"), true);
});
