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
    APP_ACCESS_PASSWORD: process.env.APP_ACCESS_PASSWORD,
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

test("password auth requires a distinct session signing secret", async () => {
  await withPasswordAuth({
    APP_ACCESS_PASSWORD: "correct horse battery staple",
  }, (passwordAuth) => {
    assert.equal(passwordAuth.isPasswordAuthConfigured(), false);
  });
});

test("session lifetime defaults to twelve hours", async () => {
  await withPasswordAuth({
    APP_ACCESS_PASSWORD: "correct horse battery staple",
    APP_SESSION_SECRET: "session signing secret",
  }, (passwordAuth) => {
    assert.equal(passwordAuth.AUTH_COOKIE_MAX_AGE_SECONDS, 60 * 60 * 12);
  });
});

test("configured session lifetime is capped at seven days", async () => {
  await withPasswordAuth({
    APP_ACCESS_PASSWORD: "correct horse battery staple",
    APP_SESSION_MAX_AGE_SECONDS: String(60 * 60 * 24 * 30),
    APP_SESSION_SECRET: "session signing secret",
  }, (passwordAuth) => {
    assert.equal(passwordAuth.AUTH_COOKIE_MAX_AGE_SECONDS, 60 * 60 * 24 * 7);
  });
});

test("session tokens expire after the configured lifetime", async () => {
  await withPasswordAuth({
    APP_ACCESS_PASSWORD: "correct horse battery staple",
    APP_SESSION_MAX_AGE_SECONDS: String(60 * 60),
    APP_SESSION_SECRET: "session signing secret",
  }, async (passwordAuth) => {
    const issuedAt = 1_700_000_000_000;
    const token = await passwordAuth.createSessionToken(issuedAt);

    assert.equal(
      await passwordAuth.verifySessionToken(token, issuedAt + 60 * 60 * 1_000),
      true,
    );
    assert.equal(
      await passwordAuth.verifySessionToken(token, issuedAt + (60 * 60 + 1) * 1_000),
      false,
    );
  });
});
