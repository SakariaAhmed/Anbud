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
