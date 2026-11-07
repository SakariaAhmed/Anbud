import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "server-only": "/dev/null" } });
const { encryptString, decryptString, encryptJson, decryptJson } = jiti("./crypto.ts");
const secret = "synthetic-crypto-regression-secret";

test("plaintext beginning with an encryption envelope always round-trips literally", (t) => {
  const previous = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = secret;
  t.after(() => { if (previous === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = previous; });
  const envelope = encryptString("a different document");
  for (const plaintext of ["", "Norsk tekst æøå", "enc:v1:literal source text", "enc:v1:broken", envelope]) {
    const stored = encryptString(plaintext);
    assert.equal(decryptString(stored), plaintext);
    if (plaintext) assert.notEqual(stored, plaintext);
  }
  const value = { text: "enc:v1:untrusted text" };
  assert.deepEqual(decryptJson(encryptJson(value), null), value);
});

test("current and legacy tag-before-IV envelopes remain readable", (t) => {
  const previous = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = secret;
  t.after(() => { if (previous === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = previous; });
  for (const tagLength of [12, 13, 14, 15, 16]) {
    const iv = Buffer.alloc(12, tagLength);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv, { authTagLength: tagLength });
    const ciphertext = Buffer.concat([cipher.update("historisk innhold", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    for (const [first, second] of [[iv, tag], [tag, iv]]) {
      const envelope = ["enc:v1", first.toString("base64"), second.toString("base64"), ciphertext.toString("base64")].join(":");
      assert.equal(decryptString(envelope), "historisk innhold");
    }
  }
  assert.equal(decryptString("legacy plaintext"), "legacy plaintext");
  assert.throws(() => decryptString("enc:v1:invalid"));
});
