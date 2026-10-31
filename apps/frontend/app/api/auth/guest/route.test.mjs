import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("guest login reports backend failures with a safe reference instead of an empty 500", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "bidsite-guest-login-test-"));
  const mockFile = path.join(dir, "backend.cjs");
  writeFileSync(mockFile, `
    const state = () => globalThis.__bidsiteGuestLoginTest;
    const fail = (stage) => {
      if (state().failAt === stage) throw Object.assign(new Error("private-database-details"), { code: "PGRST301" });
    };
    module.exports = {
      checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      authenticateGuestCode: async () => {
        fail("credential");
        return state().validCode ? { id: "u_guest_000000000000000000000001" } : null;
      },
      createAppSession: async () => {
        fail("session");
        return { sessionId: "session-id", token: "s4.private-session-token", maxAgeSeconds: 3600 };
      },
      recordActivity: async (input) => {
        state().activity.push(input.result ?? "ok");
        fail("activity");
        return { persisted: true };
      },
    };
  `);
  const state = { failAt: null, validCode: true, activity: [], logs: [] };
  globalThis.__bidsiteGuestLoginTest = state;
  const originalError = console.error;
  console.error = (message) => state.logs.push(message);

  try {
    const jiti = createJiti(import.meta.url, {
      alias: {
        "@/lib/server/access-control-repository": mockFile,
        "@/lib/server/activity": mockFile,
        "@/lib/server/app-sessions": mockFile,
        "@/lib/server/observability": mockFile,
        "@": root,
        "server-only": "/dev/null",
      },
      moduleCache: false,
    });
    const { POST } = jiti(path.join(root, "app/api/auth/guest/route.ts"));
    const login = () => POST(new Request("https://app.example.test/api/auth/guest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "guest-code", next: "/projects/example" }),
    }));
    const reset = (failAt, validCode = true) => {
      Object.assign(state, { failAt, validCode, activity: [], logs: [] });
    };

    await t.test("valid code still creates a session", async () => {
      reset(null);
      const response = await login();
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, redirectTo: "/projects/example" });
      assert.equal(response.cookies.get("bidsite_session").value, "s4.private-session-token");
      assert.equal(state.logs.length, 0);
    });

    await t.test("invalid code is still a 401", async () => {
      reset(null, false);
      const response = await login();
      assert.equal(response.status, 401);
      assert.deepEqual(state.activity, ["denied"]);
    });

    for (const [failAt, validCode] of [["credential", true], ["session", true], ["activity", true], ["activity", false]]) {
      await t.test(`${failAt} failure${validCode ? "" : " while recording a denial"} returns a logged reference`, async () => {
        reset(failAt, validCode);
        const response = await login();
        assert.equal(response.status, 500);
        const { error } = await response.json();
        const reference = error.match(/Referanse: ([0-9a-f-]{36})$/)?.[1];
        assert.ok(reference, error);
        assert.equal(state.logs.length, 1);
        const log = JSON.parse(state.logs[0]);
        assert.deepEqual(log, { event: "guest_auth_failed", stage: failAt, reference, errorCode: "PGRST301" });
        assert.equal(response.cookies.get("bidsite_session"), undefined);
        assert.doesNotMatch(JSON.stringify([error, state.logs]), /private/);
      });
    }
  } finally {
    console.error = originalError;
    delete globalThis.__bidsiteGuestLoginTest;
    rmSync(dir, { recursive: true, force: true });
  }
});
