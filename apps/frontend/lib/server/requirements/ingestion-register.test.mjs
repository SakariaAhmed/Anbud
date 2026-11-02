import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("ingestion registers skip unindexed/non-requirement documents and isolate parser failure without hiding cancellation", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-ingestion-register-"));
  const extractor = path.join(directory, "ledger.cjs");
  writeFileSync(extractor, `exports.extractRequirementLedgerForDocument = async () => { const s=globalThis.__ingestionRegisterTest; s.calls++; if(s.error)throw s.error; return []; };`);
  const state = globalThis.__ingestionRegisterTest = { calls: 0, error: null };
  const logs = []; t.mock.method(console, "warn", value => logs.push(value));
  try {
    const load = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "../../.."), "@/lib/server/requirements/source-ledger": extractor, "server-only": "/dev/null" } });
    const { buildIngestionRequirementRegister } = load("./ingestion-register.ts");
    const { ProjectJobLeaseLostError } = load("../project-job-heartbeat.ts");
    const source = { id: "source", role: "primary_customer_document", title: "Kravgrunnlag", file_name: "krav.txt" };
    assert.equal(await buildIngestionRequirementRegister(source, { indexChunks: false }), undefined);
    assert.equal(await buildIngestionRequirementRegister({ ...source, role: "primary_solution_document", title: "Løsning", file_name: "losning.txt" }), undefined);
    assert.equal(state.calls, 0);
    assert.deepEqual(await buildIngestionRequirementRegister(source), []);
    state.error = new Error("private parser details");
    assert.equal(await buildIngestionRequirementRegister(source), undefined, "Failure is distinct from an authoritative empty register.");
    assert.equal(JSON.parse(logs[0]).event, "requirement_register_extraction_failed");
    assert.doesNotMatch(logs.join(""), /private parser details/u);
    for (const error of [new DOMException("Cancelled", "AbortError"), new ProjectJobLeaseLostError("job")]) {
      state.error = error;
      await assert.rejects(buildIngestionRequirementRegister(source), e => e === error);
    }
    assert.equal(logs.length, 1, "Cancellation and lease loss never become optional parser failures.");
  } finally { delete globalThis.__ingestionRegisterTest; rmSync(directory, { recursive: true, force: true }); }
});
