import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function withIdentityBackend(callback) {
    const env = {
        NODE_ENV: "test",
        DATA_API_URL: "http://localhost:9999",
        DATA_API_SERVICE_ROLE_KEY: "test-service-key",
        APP_ADMIN_EMAILS: "admin@example.test",
        APP_IDENTITY_LOOKUP_SECRET: "test-identity-secret",
        APP_ENCRYPTION_KEY: "test-encryption-secret",
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        const pathname = new URL(url).pathname;
        requests.push({ pathname, body: JSON.parse(options.body) });
        if (pathname === "/rpc/upsert_internal_principal") {
            return Response.json([{ principal_id: "u_existing_member", identity_type: "internal", display_name: "Member" }]);
        }
        if (pathname === "/app_principal_roles") {
            return Response.json({ code: "23505", message: 'duplicate key value violates unique constraint "app_principal_roles_single_admin_idx"' }, { status: 409 });
        }
        throw new Error(`Unexpected identity request: ${pathname}`);
    };
    try {
        const jiti = createJiti(import.meta.url, { alias: { "@": frontendRoot, "server-only": "/dev/null" }, moduleCache: false });
        const { upsertInternalPrincipal } = jiti(path.join(frontendRoot, "lib/server/access-control-repository.ts"));
        await callback(upsertInternalPrincipal, requests);
    }
    finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
}
test("Microsoft sign-in does not grant admin when a legacy admin email is configured", async () => {
    await withIdentityBackend(async (upsert, requests) => {
        const principal = await upsert({ candidateId: "u_entra_subject", displayName: "Member", email: "admin@example.test" });
        assert.equal(principal.id, "u_existing_member");
        assert.deepEqual(requests.map(request => request.pathname), ["/rpc/upsert_internal_principal"]);
        assert.equal(requests[0].body.p_candidate_principal_id, "u_entra_subject");
        assert.match(requests[0].body.p_email_encrypted, /^enc:v1:/);
        assert.notEqual(requests[0].body.p_email_hmac, "admin@example.test");
    });
});
test("password-backed administrator identity upsert leaves role assignment to the explicit admin grant", async () => {
    await withIdentityBackend(async (upsert, requests) => {
        const principal = await upsert({ candidateId: "u_configured_admin", displayName: "Administrator", email: null });
        assert.equal(principal.id, "u_existing_member");
        assert.deepEqual(requests.map(request => request.pathname), ["/rpc/upsert_internal_principal"]);
        assert.equal(requests[0].body.p_email_hmac, null);
        assert.equal(requests[0].body.p_email_encrypted, null);
    });
});
