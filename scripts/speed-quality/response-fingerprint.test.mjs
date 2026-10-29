import assert from "node:assert/strict";
import test from "node:test";
import { responseFingerprint } from "./response-fingerprint.mjs";

test("JSON object-key order is irrelevant, but every field, value and array position is retained", () => {
  const hash = (body) => responseFingerprint(Buffer.from(body), "application/json");
  const before = hash('{"counts":{"a":1,"b":2},"items":[1,2],"accepted_at":"2026-09-08"}');
  const reordered = hash('{"accepted_at":"2026-09-08","items":[1,2],"counts":{"b":2,"a":1}}');
  assert.equal(before.jsonSha256, reordered.jsonSha256);
  assert.notEqual(before.sha256, reordered.sha256);
  for (const change of ['{"counts":{"a":1,"b":2},"items":[2,1],"accepted_at":"2026-09-08"}', '{"counts":{"a":1,"b":3},"items":[1,2],"accepted_at":"2026-09-08"}', '{"counts":{"a":1,"b":2},"items":[1,2],"accepted_at":"2026-09-09"}', '{"counts":{"a":1,"b":2},"items":[1,2]}']) assert.notEqual(before.jsonSha256, hash(change).jsonSha256);
  assert.equal(responseFingerprint(Buffer.from('{"b":2,"a":1}'), "text/markdown").jsonSha256, undefined);
});
