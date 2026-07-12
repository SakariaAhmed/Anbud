import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const jiti = createJiti(
  path.join(frontendRoot, "project-documents-domain-tests.cjs"),
  { alias: { "@": frontendRoot }, interopDefault: true },
);
const { selectProjectDocuments } = await jiti.import(
  path.join(frontendRoot, "lib/server/domain/project-documents.ts"),
);

function document(id, overrides = {}) {
  return {
    id,
    role: "supporting_document",
    supporting_subtype: "notat",
    title: id,
    file_name: `${id}.txt`,
    ...overrides,
  };
}

test("historical solutions are excluded from every active project-document scope", () => {
  const historical = document("historical", {
    supporting_subtype: "tidligere_losning",
    title: "Bilag 2 - tidligere arkitekturløsning",
  });
  const customer = document("customer", {
    role: "primary_customer_document",
    supporting_subtype: null,
  });
  const solution = document("solution", {
    role: "primary_solution_document",
    supporting_subtype: null,
  });
  const requirements = document("requirements", {
    supporting_subtype: "kravdokument",
  });

  const selected = selectProjectDocuments([
    historical,
    customer,
    solution,
    requirements,
  ]);

  assert.equal(selected.customerDocument?.id, customer.id);
  assert.equal(selected.solutionDocument?.id, solution.id);
  assert.deepEqual(
    selected.supportingDocuments.map((item) => item.id),
    [requirements.id],
  );
});

test("historical solutions cannot become fallback customer or solution documents", () => {
  const historical = document("historical", {
    supporting_subtype: "tidligere_losning",
    title: "Arkitekturløsning fra forrige versjon",
    file_name: "solution-history.txt",
  });
  const note = document("note", {
    title: "Kundenotat",
    file_name: "customer-note.txt",
  });

  const withNote = selectProjectDocuments([historical, note]);
  assert.equal(withNote.customerDocument?.id, note.id);
  assert.equal(withNote.solutionDocument, null);
  assert.deepEqual(withNote.supportingDocuments, []);

  const historyOnly = selectProjectDocuments([historical]);
  assert.equal(historyOnly.customerDocument, null);
  assert.equal(historyOnly.solutionDocument, null);
  assert.deepEqual(historyOnly.supportingDocuments, []);
});

test("formal solution-named requirements remain in customer-analysis support and provenance", () => {
  const customer = document("customer", {
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Kundens hoveddokument",
  });
  const requirements = document("solution-requirements", {
    supporting_subtype: "kravdokument",
    title: "Løsningskrav og arkitektur",
    file_name: "solution-architecture-requirements.pdf",
    processing_status: "enhanced_ready",
  });

  const selected = selectProjectDocuments([customer, requirements]);

  assert.equal(selected.customerDocument?.id, customer.id);
  assert.equal(selected.solutionDocument, null);
  assert.deepEqual(
    selected.supportingDocuments.map((item) => item.id),
    [requirements.id],
  );
  assert.deepEqual(
    [
      selected.customerDocument.id,
      ...selected.supportingDocuments.map((item) => item.id),
    ],
    [customer.id, requirements.id],
  );
});
