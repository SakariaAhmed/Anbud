import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@": frontendRoot },
});
const { parseProjectAccessCommand } = jiti(
  path.join(frontendRoot, "lib/project-access-command.ts"),
);

test("parses every supported access command", () => {
  assert.deepEqual(
    parseProjectAccessCommand("POST", {
      email: "guest@example.no",
      displayName: "Gjest Arkitekt",
      guestDescription: "Ekstern arkitekt fra samarbeidspartner",
      role: "viewer",
    }),
    {
      ok: true,
      command: {
        action: "invite",
        email: "guest@example.no",
        displayName: "Gjest Arkitekt",
        guestDescription: "Ekstern arkitekt fra samarbeidspartner",
        role: "viewer",
        expiresAt: null,
      },
    },
  );
  assert.equal(
    parseProjectAccessCommand("POST", {
      action: "grant_group",
      groupId: "group-1",
      role: "editor",
    }).command?.action,
    "grant_group",
  );
  assert.equal(
    parseProjectAccessCommand("POST", {
      action: "rotate_guest",
      principalId: "g_principal",
    }).command?.action,
    "rotate_guest",
  );
  assert.equal(
    parseProjectAccessCommand("PATCH", {
      principalId: "g_principal",
      role: "restricted_viewer",
    }).command?.action,
    "update_member",
  );
  assert.equal(
    parseProjectAccessCommand("DELETE", { groupId: "group-1" }).command?.action,
    "revoke_group",
  );
});

test("rejects owner grants, ambiguous targets, oversized values, and unknown actions", () => {
  for (const result of [
    parseProjectAccessCommand("POST", {
      email: "guest@example.no",
      displayName: "Gjest Arkitekt",
      guestDescription: "Ekstern arkitekt",
      role: "owner",
    }),
    parseProjectAccessCommand("PATCH", {
      principalId: "principal",
      groupId: "group",
      role: "viewer",
    }),
    parseProjectAccessCommand("POST", {
      action: "invite",
      email: "x".repeat(321),
      displayName: "Gjest Arkitekt",
      guestDescription: "Ekstern arkitekt",
      role: "viewer",
    }),
    parseProjectAccessCommand("POST", {
      action: "invite",
      email: "guest@example.no",
      displayName: "Gjest Arkitekt",
      role: "viewer",
    }),
    parseProjectAccessCommand("POST", { action: "make_admin" }),
    parseProjectAccessCommand("DELETE", []),
  ]) {
    assert.equal(result.ok, false);
  }
});
