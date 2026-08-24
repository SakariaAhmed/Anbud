import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

async function withPasswordAuth(env, callback) {
  const previous = {
    APP_SESSION_MAX_AGE_SECONDS: process.env.APP_SESSION_MAX_AGE_SECONDS,
    APP_SESSION_SECRET: process.env.APP_SESSION_SECRET,
  };

  for (const key of Object.keys(previous)) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  const jiti = createJiti(
    path.join(frontendRoot, `password-auth-tests-${Date.now()}-${Math.random()}.cjs`),
    {
      interopDefault: true,
      alias: {
        "@": frontendRoot,
        "server-only": "/dev/null",
      },
      moduleCache: false,
    },
  );

  const passwordAuth = jiti(path.join(frontendRoot, "lib/password-auth.ts"));

  try {
    return await callback(passwordAuth);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

test("session lifetime defaults to twelve hours", async () => {
  await withPasswordAuth({
    APP_SESSION_SECRET: "session signing secret",
  }, (passwordAuth) => {
    assert.equal(passwordAuth.AUTH_COOKIE_MAX_AGE_SECONDS, 60 * 60 * 12);
  });
});

test("configured session lifetime is capped at seven days", async () => {
  await withPasswordAuth({
    APP_SESSION_MAX_AGE_SECONDS: String(60 * 60 * 24 * 30),
    APP_SESSION_SECRET: "session signing secret",
  }, (passwordAuth) => {
    assert.equal(passwordAuth.AUTH_COOKIE_MAX_AGE_SECONDS, 60 * 60 * 24 * 7);
  });
});

test("Microsoft identities remain pseudonymous", async () => {
  await withPasswordAuth({ APP_SESSION_SECRET: "session signing secret" }, async (passwordAuth) => {
    const ownerId = await passwordAuth.deriveOwnerId("entra-object-id");
    assert.match(ownerId, /^u_[A-Za-z0-9_-]{43}$/);
    assert.equal(ownerId.includes("entra-object-id"), false);
  });
});

test("database session tokens are strict and signed independently", async () => {
  await withPasswordAuth({ APP_SESSION_SECRET: "session signing secret" }, async (passwordAuth) => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const secret = "A".repeat(43);
    const token = passwordAuth.encodeDatabaseSessionToken(sessionId, secret);
    assert.deepEqual(passwordAuth.parseDatabaseSessionToken(token), {
      sessionId,
      secret,
    });
    assert.equal(passwordAuth.parseDatabaseSessionToken(`v3.${sessionId}.${secret}`), null);
    assert.match(
      await passwordAuth.databaseSessionTokenHmac(sessionId, secret),
      /^[A-Za-z0-9_-]{43}$/u,
    );
  });
});
