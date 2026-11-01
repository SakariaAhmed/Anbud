import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { evidenceIdentity, SourceQuoteIndex, validateChatEvidence } = createJiti(import.meta.url, { alias: { "server-only": "/dev/null" } })("./source-evidence.ts");
const sources = [{ evidence_id: "e1", original_quote: "K-4.2 Leverandøren skal lagre data i Norge.", source_revision: 2 }, { evidence_id: "e2", original_quote: "K-4.20 Loggene skal lagres i ett år." }];
test("canonical matching returns original quotation characters and rejects invented words", () => {
  const original = "K‐4.2\nLeverandøren  skal lagre data i Norge.";
  const index = new SourceQuoteIndex(original);
  assert.equal(index.find(sources[0].original_quote), original);
  assert.equal(index.find("Data skal lagres i Sverige."), null);
});
test("only actually cited sources persist; unknown references, quotes and prefix-colliding IDs are rejected", () => {
  assert.deepEqual(validateChatEvidence("K-4.2 krever lagring i Norge. [Kilde 1]", sources), [sources[0]]);
  assert.deepEqual(validateChatEvidence("Dette er et forslag til videre arbeid.", sources), []);
  for (const answer of ["Fakta. [Kilde 0]", "Fakta. [Kilde 3]", "«Data lagres i Sverige.» [Kilde 1]", "K-4.2 gjelder. [Kilde 2]", "K-99 gjelder. [Kilde 1]", "«Leverandøren skal lagre data i Norge.»"]) {
    assert.throws(() => validateChatEvidence(answer, sources), /kilde|sitat|krav-ID/iu);
  }
  assert.throws(() => validateChatEvidence("Fakta. [Kilde 1]", [{ evidence_id: "e1" }]), /kilde/iu);
});
test("evidence identity is stable for one snapshot and changes with source revision or content", () => {
  const input = { sourceType: "project_document", sourceId: "one", revision: 1, fingerprint: "hash", reference: "Side 2", text: "K-1 Data i Norge." };
  assert.equal(evidenceIdentity(input), evidenceIdentity({ ...input }));
  assert.notEqual(evidenceIdentity(input), evidenceIdentity({ ...input, revision: 2 }));
  assert.notEqual(evidenceIdentity(input), evidenceIdentity({ ...input, text: "Endret." }));
});
