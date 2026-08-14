import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
process.env.APP_GUEST_CODE_PEPPER = "guest-code-test-pepper";
process.env.APP_IDENTITY_LOOKUP_SECRET = "email-test-secret";
process.env.APP_ACTIVITY_HASH_SECRET = "activity-test-secret";
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});
const crypto = jiti(path.join(frontendRoot, "lib/server/identity-crypto.ts"));

test("guest codes contain at least 150 random-alphabet bits", () => {
  const code = crypto.generateGuestCode();
  assert.match(
    code,
    /^gst_[A-Z2-9]{5}(?:-[A-Z2-9]{5}){5}$/u,
  );
  assert.equal(crypto.normalizeGuestCode(code).length, 30);
});

test("guest codes normalize formatting before lookup", () => {
  const code = crypto.generateGuestCode();
  const looselyFormatted = code
    .toLocaleLowerCase("en-US")
    .replace("gst_", "gst-")
    .replaceAll("-", " ");
  assert.equal(crypto.guestCodeHmac(code), crypto.guestCodeHmac(looselyFormatted));
});

test("email lookup is normalized and email displays are masked", () => {
  assert.equal(
    crypto.emailHmac(" Person@Example.NO "),
    crypto.emailHmac("person@example.no"),
  );
  assert.equal(crypto.maskEmail("person@example.no"), "pe****@example.no");
});
