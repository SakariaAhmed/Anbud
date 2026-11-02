import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { verifyProjectSourceEvidence } = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "../..") } })("./source-evidence-api.ts");
const source = { source_type: "project_document", source_id: "document", document_title: "Krav", reference: "Side 1", heading_path: [], page_start: 1, page_end: 1, source_revision: 2, source_fingerprint: "fingerprint", evidence_id: "saved-proof", classification: "documented", original_quote: "Første ordrette kildeutdrag.", quotation_excerpts: ["Første ordrette kildeutdrag.", "Andre ordrette kildeutdrag."] };
test("saved evidence is rechecked for every quotation and differing locations are not merged into a false page", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return Response.json({ source: { ...source, original_quote: body.quote, quotation_excerpts: undefined, page_start: requests.length, reference: `Side ${requests.length}` } });
  });
  const result = await verifyProjectSourceEvidence("project", source, new AbortController().signal);
  assert.equal(requests.length, 2); assert.ok(requests.every(body => body.sourceRevision === 2));
  assert.deepEqual(result.quotation_excerpts, source.quotation_excerpts);
  assert.equal(result.page_start, null); assert.equal(result.reference, "Flere verifiserte steder i dokumentet");
});
test("one stale or absent quotation invalidates the whole displayed proof", async t => {
  for (const status of [409, 422]) {
    t.mock.method(globalThis, "fetch", async (_, options) => JSON.parse(options.body).quote === source.original_quote ? Response.json({ source }) : Response.json({ error: "Unavailable" }, { status }));
    await assert.rejects(verifyProjectSourceEvidence("project", source, new AbortController().signal), status === 409 ? /Kilden er endret/u : /ikke bekreftes/u);
    t.mock.restoreAll();
  }
});
test("a revision change between quotation checks fails instead of combining versions", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json({ source: { ...source, source_revision: ++calls } }));
  await assert.rejects(verifyProjectSourceEvidence("project", source, new AbortController().signal), /endret under kontrollen/u);
});
test("source checks propagate cancellation", async t => {
  const abort = new AbortController(); abort.abort();
  t.mock.method(globalThis, "fetch", async (_, { signal }) => { signal.throwIfAborted(); });
  await assert.rejects(verifyProjectSourceEvidence("project", source, abort.signal), error => error.name === "AbortError");
});
test("rate limiting reports the server wait without claiming a quotation mismatch or retrying", async t => {
  for (const retryAfter of ["37", null, "invalid"]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response("Rate limited", { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
    });
    await assert.rejects(verifyProjectSourceEvidence("project", { ...source, quotation_excerpts: undefined }, new AbortController().signal), error => {
      assert.match(error.message, /For mange kildekontroller/u);
      assert.match(error.message, retryAfter === "37" ? /Vent 37 sekunder/u : /Vent litt/u);
      assert.doesNotMatch(error.message, /ikke bekreftes/u);
      return true;
    });
    assert.equal(calls, 1);
    t.mock.restoreAll();
  }
});
