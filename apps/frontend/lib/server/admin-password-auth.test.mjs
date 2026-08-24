import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

function encodedHash(password) {
  const salt = Buffer.from("fixed-test-salt-value");
  const digest = scryptSync(password, salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

async function withAdminPassword(env, callback) {
  const keys = [
    "APP_ADMIN_ACCESS_PASSWORD_HASH",
    "APP_ADMIN_PRINCIPAL_ID",
    "APP_ADMIN_DISPLAY_NAME",
    "APP_SESSION_SECRET",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);

  const jiti = createJiti(
    path.join(frontendRoot, `admin-password-tests-${Date.now()}-${Math.random()}.cjs`),
    {
      interopDefault: true,
      alias: { "@": frontendRoot, "server-only": "/dev/null" },
      moduleCache: false,
    },
  );
  const auth = jiti(
    path.join(frontendRoot, "lib/server/admin-password-auth.ts"),
  );
  try {
    return await callback(auth);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === "string") process.env[key] = value;
      else delete process.env[key];
    }
  }
}

test("admin password login requires hash, stable identity, and session secret", async () => {
  await withAdminPassword(
    {
      APP_ADMIN_ACCESS_PASSWORD_HASH: encodedHash("correct horse battery staple"),
      APP_ADMIN_PRINCIPAL_ID: "u_admin_test_identity_000000000000000000",
    },
    (auth) => assert.equal(auth.isAdminPasswordAuthConfigured(), false),
  );
});

test("admin password is verified through scrypt and constant-time comparison", async () => {
  await withAdminPassword(
    {
      APP_ADMIN_ACCESS_PASSWORD_HASH: encodedHash("correct horse battery staple"),
      APP_ADMIN_PRINCIPAL_ID: "u_admin_test_identity_000000000000000000",
      APP_SESSION_SECRET: "independent session secret",
    },
    async (auth) => {
      assert.equal(auth.isAdminPasswordAuthConfigured(), true);
      assert.equal(await auth.verifyAdminPassword("correct horse battery staple"), true);
      assert.equal(await auth.verifyAdminPassword("incorrect"), false);
      assert.equal(await auth.verifyAdminPassword("x".repeat(257)), false);
    },
  );
});

test("malformed or weak hash parameters fail closed", async () => {
  await withAdminPassword(
    {
      APP_ADMIN_ACCESS_PASSWORD_HASH: "scrypt$1024$8$1$bad$bad",
      APP_ADMIN_PRINCIPAL_ID: "u_admin_test_identity_000000000000000000",
      APP_SESSION_SECRET: "independent session secret",
    },
    async (auth) => {
      assert.equal(auth.isAdminPasswordAuthConfigured(), false);
      assert.equal(await auth.verifyAdminPassword("anything"), false);
    },
  );
});
