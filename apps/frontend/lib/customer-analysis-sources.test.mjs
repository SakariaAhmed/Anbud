import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const { createJiti } = createRequire(import.meta.url)("jiti");
const jiti = createJiti(import.meta.url);
const { findDocumentForReference } = jiti("./customer-analysis-sources.ts");
const customer = { id: "customer", role: "primary_customer_document", title: "Bilag 1 - Fiktiv driftskontroll", file_name: "bilag-1.pdf" };
const solution = { id: "solution", role: "primary_solution_document", title: "Fiktiv løsningsbeskrivelse", file_name: "losning.txt" };
const supporting = { id: "supporting", role: "supporting_document", title: "Kravgrunnlag", file_name: "krav.txt" };

test("analysis source links follow the document role regardless of upload order", () => {
  for (const documents of [[solution, supporting, customer], [customer, solution, supporting]]) {
    for (const label of ["Kundedokument – Docling text 7, side 1", "Customer document, page 1"]) {
      assert.equal(findDocumentForReference(documents, label)?.id, customer.id);
    }
    for (const label of ["Løsningsdokument – side 1", "Solution document, page 1"]) {
      assert.equal(findDocumentForReference(documents, label)?.id, solution.id);
    }
    assert.equal(findDocumentForReference(documents, "Bilag 1 - Fiktiv driftskontroll, side 1")?.id, customer.id);
  }
});

test("missing or ambiguous source documents do not link an unrelated file", () => {
  assert.equal(findDocumentForReference([solution, supporting], "Kundedokument – side 1"), null);
  assert.equal(findDocumentForReference([customer, supporting], "Løsningsdokument – side 1"), null);
  assert.equal(findDocumentForReference([customer, { ...customer, id: "other" }], customer.title), null);
  assert.equal(findDocumentForReference([customer, solution], ""), null);
  assert.equal(findDocumentForReference([customer, solution], "Ukjent kilde"), null);
});
