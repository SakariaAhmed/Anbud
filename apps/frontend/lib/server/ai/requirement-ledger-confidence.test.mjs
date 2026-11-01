import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const jiti = createJiti(path.join(frontendRoot, "requirement-ledger-confidence-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const load = (file) => jiti.import(path.join(frontendRoot, file));
const { extractTextFromBuffer } = await load("lib/server/documents.ts");
const { extractRequirementLedgerWithCorrections } = await load("lib/server/requirements/source-ledger.ts");
const { assertExplicitRequirementLedgersComplete, canonicalizeRequirementSourceLedger } = await load("lib/server/requirements/source-readiness.ts");
const { selectRequirementDocumentsForGeneration } = await load("lib/server/ai/requirement-response.ts");
const { assessRequirementLedgerConfidence, hasExplicitlyCompleteSmallRequirementLedger } = await load("lib/server/ai/requirement-ledger-confidence.ts");

async function source({ id, title, role, text, subtype = null }) {
  const parsed = await extractTextFromBuffer({ buffer: Buffer.from(text), fileName: `${id}.txt`, role, useDocling: false });
  return {
    id, project_id: "synthetic", title, role, supporting_subtype: subtype,
    file_name: parsed.fileName, file_format: parsed.fileFormat,
    raw_text: parsed.rawText, structure_map: parsed.sourceMap, processing_status: "basic_ready",
  };
}

async function fixture() {
  const customer = await source({
    id: "customer", title: "Konkurransegrunnlag", role: "primary_customer_document",
    text: "Fiktiv kommune har 120 ansatte fordelt på tre lokasjoner. Kommunen anskaffer drift av en sikker skyplattform. Kundedata skal behandles i Norge. Kravspesifikasjonen finnes i Bilag 1 og leverandørens besvarelse i løsningsnotatet.",
  });
  const formal = await source({
    id: "formal", title: "Bilag 1 Kravspesifikasjon", role: "supporting_document", subtype: "kravdokument",
    text: [
      "1 Drift",
      "K-1.1 Leverandøren skal drifte plattformen hele døgnet og dokumentere kontaktpunkt for kritiske hendelser.",
      "2 Sikkerhet",
      "K-1.2 Kundedata, sikkerhetskopier og identifiserbare logger skal lagres og behandles i Norge.",
      "3 Exit",
      "K-1.3 Leverandøren skal levere en exitplan med eksport i åpne formater innen 30 dager.",
    ].join("\n"),
  });
  const selected = selectRequirementDocumentsForGeneration({
    artifactType: "forbedret_kravsvar", customerDocument: customer, requirementDocuments: [formal],
  });
  const results = await Promise.all(selected.requirementDocuments.map(async document => ({
    document, ...await extractRequirementLedgerWithCorrections(document),
  })));
  assertExplicitRequirementLedgersComplete(selected.requirementDocuments, results);
  return {
    customer, formal,
    requirementDocuments: selected.requirementDocuments,
    ledger: canonicalizeRequirementSourceLedger({ sourceDocuments: selected.requirementDocuments, requirementLedgerResults: results }),
  };
}

const actual = await fixture();

test("actual TXT generation pipeline accepts a complete small register alongside primary customer context", () => {
  assert.deepEqual(actual.ledger.map(entry => entry.id), ["K-1.1", "K-1.2", "K-1.3"]);
  assert.equal(hasExplicitlyCompleteSmallRequirementLedger(actual), true);
  const confidence = assessRequirementLedgerConfidence({ ...actual, hasExplicitRequirementDocuments: true });
  assert.equal(confidence.score, 0.74, "The global confidence score must stay unchanged.");
  assert.equal(confidence.level, "medium");
  assert.ok(confidence.reasons.includes("explicitly_complete_small_ledger"));
});

test("primary customer context cannot excuse missing formal or explicit customer requirements", () => {
  assert.equal(hasExplicitlyCompleteSmallRequirementLedger({ ...actual, ledger: actual.ledger.slice(1) }), false);
  assert.equal(hasExplicitlyCompleteSmallRequirementLedger({
    ...actual, requirementDocuments: [...actual.requirementDocuments, { ...actual.formal, id: "empty-formal" }],
  }), false);
  assert.equal(hasExplicitlyCompleteSmallRequirementLedger({
    ...actual, requirementDocuments: [{ ...actual.customer, raw_text: "K-9 Leverandøren skal dokumentere beredskap." }, actual.formal],
  }), false);
  assert.equal(hasExplicitlyCompleteSmallRequirementLedger({
    ...actual, requirementDocuments: [{ ...actual.customer, role: "supporting_document" }, actual.formal],
  }), false);
});

test("small-register exception preserves duplicate, locator, document and substantive-text guards", () => {
  const rejected = [
    [actual.ledger[0], actual.ledger[0], actual.ledger[2]],
    actual.ledger.map(entry => ({ ...entry, documentId: "unselected-source" })),
    actual.ledger.map(entry => ({ ...entry, sourceExcerpt: "", heading: "", pages: [], tableId: "" })),
    actual.ledger.map(entry => ({ ...entry, text: "For kort." })),
    actual.ledger.map((entry, index) => ({ ...entry, id: `Ustrukturert krav ${index + 1}` })),
  ];
  for (const ledger of rejected) {
    assert.equal(hasExplicitlyCompleteSmallRequirementLedger({ ...actual, ledger }), false);
  }
});
