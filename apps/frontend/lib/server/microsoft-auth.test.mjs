import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

function loadMicrosoftAuth() {
  const jiti = createJiti(
    path.join(frontendRoot, `microsoft-auth-tests-${Date.now()}-${Math.random()}.cjs`),
    {
      interopDefault: true,
      alias: {
        "@": frontendRoot,
        "server-only": "/dev/null",
      },
      moduleCache: false,
    },
  );
  return jiti(path.join(__dirname, "microsoft-auth.ts"));
}

test("Microsoft flow state round-trips without identity data", async () => {
  const microsoftAuth = loadMicrosoftAuth();
  const flow = await microsoftAuth.createMicrosoftFlowState(
    "/projects/example?tab=analysis",
  );
  const parsed = microsoftAuth.parseMicrosoftFlowState(flow.state);

  assert.equal(parsed.next, "/projects/example?tab=analysis");
  assert.equal(parsed.csrf, flow.csrf);
  assert.equal(Object.hasOwn(parsed, "email"), false);
  assert.equal(Object.hasOwn(parsed, "userId"), false);
  assert.ok(flow.pkce.verifier.length >= 43);
  assert.ok(flow.nonce.length > 0);
});

test("Microsoft flow state rejects malformed input", () => {
  const { parseMicrosoftFlowState } = loadMicrosoftAuth();

  assert.equal(parseMicrosoftFlowState("not-json"), null);
  assert.equal(
    parseMicrosoftFlowState(
      Buffer.from(JSON.stringify({ csrf: "missing-next" })).toString("base64url"),
    ),
    null,
  );
});


test("a failed authority lookup is shared then evicted so the next login can recover", async () => {
  const env = {
    MICROSOFT_ENTRA_CLIENT_ID: "test-client-id",
    MICROSOFT_ENTRA_CLIENT_SECRET: "test-client-secret",
    MICROSOFT_ENTRA_TENANT_SUBDOMAIN: "example",
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  let attempts = 0;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    attempts += 1;
    return attempts === 1
      ? new Response("temporarily unavailable", { status: 503 })
      : Response.json({
        authorization_endpoint: "https://example.ciamlogin.com/oauth2/v2.0/authorize",
        token_endpoint: "https://example.ciamlogin.com/oauth2/v2.0/token",
        issuer: "https://example.ciamlogin.com/v2.0",
        jwks_uri: "https://example.ciamlogin.com/discovery/v2.0/keys",
      });
  };
  try {
    const auth = loadMicrosoftAuth();
    const failures = await Promise.allSettled([auth.createMicrosoftAuthClient(), auth.createMicrosoftAuthClient()]);
    assert.deepEqual(failures.map(result => result.status), ["rejected", "rejected"]);
    assert.equal(attempts, 1);
    assert.ok(await auth.createMicrosoftAuthClient());
    assert.ok(await auth.createMicrosoftAuthClient());
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("Microsoft failure diagnostics contain a reference and stage, never raw credentials or errors", () => {
  const auth = loadMicrosoftAuth();
  const originalError = console.error;
  const logs = [];
  console.error = value => logs.push(value);
  try {
    const error = Object.assign(new Error("id_token=private-token user@example.test"), {
      errorCode: "invalid_client",
      clientSecret: "private-secret",
    });
    const reference = auth.reportMicrosoftAuthFailure("token", error);
    const log = JSON.parse(logs[0]);
    assert.equal(log.reference, reference);
    assert.equal(log.stage, "token");
    assert.equal(log.errorCode, "invalid_client");
    assert.match(reference, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(logs[0], /private|user@example/);
    auth.reportMicrosoftAuthFailure("identity", { errorCode: "token=private-token" });
    assert.equal(JSON.parse(logs[1]).errorCode, "internal_error");
  } finally {
    console.error = originalError;
  }
});
