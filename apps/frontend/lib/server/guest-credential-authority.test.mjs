import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const support = path.join(root, "lib/server/guest-credential-authority.test-support.ts");
const jiti = createJiti(import.meta.url, { alias: {
  "@/lib/server/authorization": support,
  "@/lib/server/guest-email": support,
  "@/lib/server/observability": support,
  "@/lib/server/activity": support,
  "@": root, "server-only": "/dev/null",
} });
const { state } = jiti(support);
const repository = jiti(path.join(root, "lib/server/access-control-repository.ts"));
const { POST } = jiti(path.join(root, "app/api/projects/[id]/access/route.ts"));
const { encryptString } = jiti(path.join(root, "lib/server/crypto.ts"));
const projectId = "12345678-1234-4123-8123-123456789abc";
const guestId = "g_other_project_guest_000000000001";

async function withBackend(run, credentialCreated = true) {
  const env = { DATA_API_URL: "http://localhost:9999", DATA_API_SERVICE_ROLE_KEY: "test-service-key", APP_IDENTITY_LOOKUP_SECRET: "test-identity-secret", APP_GUEST_CODE_PEPPER: "test-guest-pepper", APP_ENCRYPTION_KEY: "test-encryption-secret" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const original = globalThis.fetch;
  const calls = [];
  state.isAdmin = false;
  state.emails.length = 0;
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (pathname === "/rpc/grant_guest_project_access_batch") return Response.json([{ principal_id: guestId, identity_type: "guest", credential_created: credentialCreated }]);
    if (pathname === "/app_principals") return Response.json([{ display_name: "Guest", email_encrypted: encryptString("guest@example.test") }]);
    if (pathname === "/rpc/rotate_guest_credential") return Response.json(2);
    throw new Error(`Unexpected request: ${pathname} ${options.method}`);
  };
  try { await run(calls); } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("project owner cannot rotate a guest even with an existing project grant", async () => {
  await withBackend(async calls => {
    const response = await POST(new Request("http://localhost/api/access", { method: "POST", body: JSON.stringify({ action: "rotate_guest", principalId: guestId }) }), { params: Promise.resolve({ id: projectId }) });
    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
    assert.equal(state.emails.length, 0);
  });
});

test("shared rotation boundary rejects owners and forged administrator actor IDs before IO", async () => {
  await withBackend(async calls => {
    await assert.rejects(repository.rotateGuestCode({ principalId: guestId, rotatedBy: state.actorId }), /Administratortilgang/);
    state.isAdmin = true;
    await assert.rejects(repository.rotateGuestCode({ principalId: guestId, rotatedBy: "another_actor" }), /Ugyldig administrator/);
    assert.deepEqual(calls, []);
  });
});

test("administrator rotation keeps usable code and sends guest notification", async () => {
  await withBackend(async calls => {
    state.isAdmin = true;
    const result = await repository.rotateGuestCode({ principalId: guestId, rotatedBy: state.actorId, projectName: "Project A" });
    assert.equal(result.version, 2);
    assert.ok(result.code.length > 10);
    assert.equal(state.emails[0].guestCode, result.code);
    assert.deepEqual(calls, ["/app_principals", "/rpc/rotate_guest_credential"]);
  });
});

test("owner invitations deliver new credentials only to guest; administrator keeps manual delivery", async () => {
  await withBackend(async () => {
    const input = { projectId, projectName: "Project A", email: "guest@example.test", displayName: "Guest", guestDescription: "External reviewer", role: "viewer", createdBy: state.actorId };
    const ownerResult = await repository.inviteEmailToProject(input);
    assert.equal(ownerResult.guestCode, null);
    assert.equal(ownerResult.emailDelivery.delivered, true);
    assert.ok(state.emails[0].guestCode.length > 10);
    state.isAdmin = true;
    const adminResult = await repository.inviteEmailToProject(input);
    assert.equal(adminResult.guestCode, state.emails[1].guestCode);
    assert.ok(adminResult.guestCode.length > 10);
  });
});


test("existing guest invitations explicitly return no credential and send no replacement code", async () => {
  await withBackend(async () => {
    const result = await repository.inviteEmailToProject({ projectId, projectName: "Project A", email: "guest@example.test", displayName: "Guest", guestDescription: "External reviewer", role: "viewer", createdBy: state.actorId });
    assert.equal(result.credentialCreated, false);
    assert.equal(result.guestCode, null);
    assert.equal(state.emails[0].guestCode, null);
  }, false);
});
