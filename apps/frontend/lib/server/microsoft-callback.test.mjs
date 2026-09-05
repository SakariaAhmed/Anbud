import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { NextRequest } = require("next/server");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
test("Microsoft callback validates the flow and distinguishes provider, access, and persistence failures", async (t) => {
    const env = {
        NODE_ENV: "test",
        APP_PUBLIC_ORIGIN: "https://app.example.test",
        APP_SESSION_SECRET: "test-session-signing-key",
        APP_ENCRYPTION_KEY: "test-encryption-key",
        APP_IDENTITY_LOOKUP_SECRET: "test-lookup-key",
        APP_ADMIN_EMAILS: "member@example.test",
        DATA_API_URL: "http://localhost:9999",
        DATA_API_SERVICE_ROLE_KEY: "test-service-key",
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    Object.assign(process.env, env);
    const dir = mkdtempSync(path.join(tmpdir(), "bidsite-auth-test-"));
    const mockFile = path.join(dir, "microsoft.cjs");
    writeFileSync(mockFile, `
    const jiti = require(${JSON.stringify(require.resolve("jiti"))})(__filename, {alias:{"server-only":"/dev/null"}, moduleCache:false});
    const actual = jiti(${JSON.stringify(path.join(root, "lib/server/microsoft-auth.ts"))});
    module.exports = {...actual, isMicrosoftAuthConfigured:()=>true, createMicrosoftAuthClient:async()=>({
      acquireTokenByCode: async (request, payload) => {
        const state = globalThis.__bidsiteCallbackTest;
        state.exchanges.push({request,payload});
        if (state.mode === "token") throw Object.assign(new Error("private-provider-response"), {errorCode:"invalid_client"});
        return {account:{localAccountId:"provider-subject",name:"Member",username:"member@example.test"},idToken:"private-id-token",idTokenClaims:{email:"member@example.test"}};
      }
    })};
  `);
    const state = { mode: "ok", exchanges: [], requests: [], logs: [] };
    globalThis.__bidsiteCallbackTest = state;
    console.error = message => state.logs.push(message);
    globalThis.fetch = async (url, options) => {
        const pathname = new URL(url).pathname;
        state.requests.push({ pathname, body: JSON.parse(options.body) });
        if (pathname === "/rpc/upsert_internal_principal") {
            if (state.mode === "identity" || state.mode === "denied")
                return Response.json({ code: state.mode === "denied" ? "42501" : "23505", message: "private-database-details" }, { status: 409 });
            return Response.json([{ principal_id: "u_member_identity_000000000000000001", identity_type: "internal", display_name: "Member" }]);
        }
        if (pathname === "/app_sessions" && state.mode === "session")
            return Response.json({ code: "08006", message: "private-database-details" }, { status: 503 });
        if (["/app_sessions", "/activity_events"].includes(pathname))
            return new Response(null, { status: 201 });
        throw new Error(`Unexpected callback request: ${pathname}`);
    };
    try {
        const jiti = createJiti(import.meta.url, { alias: { "@/lib/server/microsoft-auth": mockFile, "@": root, "server-only": "/dev/null" }, moduleCache: false });
        const { GET } = jiti(path.join(root, "app/api/auth/microsoft/callback/route.ts"));
        const flowState = Buffer.from(JSON.stringify({ csrf: "expected-csrf", next: "/projects/example" })).toString("base64url");
        const request = (cookie = "bidsite_microsoft_state=expected-csrf; bidsite_microsoft_pkce=test-verifier; bidsite_microsoft_nonce=test-nonce") => new NextRequest(`https://app.example.test/api/auth/microsoft/callback?code=test-code&state=${flowState}`, { headers: { cookie } });
        const reset = mode => { state.mode = mode; state.exchanges = []; state.requests = []; state.logs = []; };
        await t.test("valid callback persists an opaque session without granting admin", async () => {
            reset("ok");
            const response = await GET(request());
            assert.equal(response.status, 302);
            assert.equal(response.headers.get("location"), "https://app.example.test/projects/example");
            assert.equal(state.exchanges[0].request.codeVerifier, "test-verifier");
            assert.equal(state.exchanges[0].payload.nonce, "test-nonce");
            assert.deepEqual(state.requests.map(x => x.pathname), ["/rpc/upsert_internal_principal", "/app_sessions", "/activity_events"]);
            const cookie = response.cookies.get("bidsite_session");
            assert.match(cookie.value, /^s4\./);
            assert.equal(cookie.httpOnly, true);
            assert.equal(cookie.sameSite, "lax");
            assert.equal(cookie.path, "/");
            assert.doesNotMatch(cookie.value, /private|member@example/);
            assert.equal(response.cookies.get("bidsite_microsoft_nonce").maxAge, 0);
        });
        await t.test("missing nonce and mismatched state are rejected before token exchange", async () => {
            for (const cookie of ["bidsite_microsoft_state=expected-csrf; bidsite_microsoft_pkce=test-verifier", "bidsite_microsoft_state=wrong; bidsite_microsoft_pkce=test-verifier; bidsite_microsoft_nonce=test-nonce"]) {
                reset("ok");
                const response = await GET(request(cookie));
                assert.equal(new URL(response.headers.get("location")).searchParams.get("authError"), "microsoft_callback_invalid");
                assert.equal(state.exchanges.length, 0);
                assert.equal(state.requests.length, 0);
                assert.equal(response.cookies.get("bidsite_session"), undefined);
            }
        });
        for (const [mode, errorCode] of [["token", "microsoft_callback_failed"], ["identity", "microsoft_session_failed"], ["session", "microsoft_session_failed"], ["denied", "microsoft_access_denied"]]) {
            await t.test(`${mode} failure has a safe reference and no session cookie`, async () => {
                reset(mode);
                const response = await GET(request());
                const location = new URL(response.headers.get("location"));
                assert.equal(location.searchParams.get("authError"), errorCode);
                assert.equal(location.searchParams.get("next"), "/projects/example");
                assert.match(location.searchParams.get("authRef"), /^[0-9a-f-]{36}$/);
                assert.equal(JSON.parse(state.logs[0]).reference, location.searchParams.get("authRef"));
                assert.equal(response.cookies.get("bidsite_session"), undefined);
                assert.equal(response.cookies.get("bidsite_microsoft_state").maxAge, 0);
                assert.doesNotMatch(JSON.stringify(state.logs), /private|member@example/);
                if (mode === "identity" || mode === "denied")
                    assert.equal(state.requests.length, 1);
            });
        }
    }
    finally {
        globalThis.fetch = originalFetch;
        console.error = originalError;
        delete globalThis.__bidsiteCallbackTest;
        rmSync(dir, { recursive: true, force: true });
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
});
