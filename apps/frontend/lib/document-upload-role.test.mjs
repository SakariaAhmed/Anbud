import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(path.join(frontendRoot, "document-upload-role-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const { suggestUploadDocumentRole } = await jiti.import(
  path.join(frontendRoot, "lib/document-processing.ts"),
);

const empty = [];

test("customer appendix and requirement names suggest the customer document", () => {
  for (const name of [
    "Bilag 1 - Kundens kravspesifikasjon.pdf",
    "bilag1.docx",
    "Bilag_01_krav.xlsx",
    "Kravspesifikasjon drift.docx",
    "Kundens behovsbeskrivelse.pdf",
    "Konkurransegrunnlag Statens vegvesen.pdf",
  ]) {
    assert.equal(suggestUploadDocumentRole(name, empty), "primary_customer_document", name);
  }
});

test("solution appendix names suggest the solution document, including æøå spellings", () => {
  for (const name of [
    "Bilag 2 - Leverandørens løsningsbeskrivelse på norsk.pdf",
    // Decomposed letters from a macOS file picker.
    "Bilag 2 - Leverandørens løsningsbeskrivelse på norsk.pdf".normalize("NFD"),
    "LØSNINGSBESKRIVELSE.docx",
    "losningsbeskrivelse v3.docx",
    "Leverandorens svar.pdf",
    "Solution description.pdf",
    "bilag-2.pdf",
  ]) {
    assert.equal(suggestUploadDocumentRole(name, empty), "primary_solution_document", name);
  }
});

test("appendices 10 and 20 and unrelated names stay supporting", () => {
  for (const name of [
    "Bilag 10 - Prisskjema.xlsx",
    "Bilag 20 - Databehandleravtale.pdf",
    "bilag 12.pdf",
    "Møtenotat oppstart.docx",
    "Arkitekturskisse.png",
  ]) {
    assert.equal(suggestUploadDocumentRole(name, empty), "supporting_document", name);
  }
});

test("the appendix number decides when keywords from both roles appear", () => {
  assert.equal(
    suggestUploadDocumentRole("Bilag 2 - Leverandørens svar på kravspesifikasjon.docx", empty),
    "primary_solution_document",
  );
  assert.equal(
    suggestUploadDocumentRole("Bilag 1 - Krav til leverandørens løsning.docx", empty),
    "primary_customer_document",
  );
  assert.equal(
    suggestUploadDocumentRole("Kundens krav til leverandørens løsningsbeskrivelse.docx", empty),
    "supporting_document",
    "ambiguous names without an appendix number are not guessed",
  );
});

test("an occupied primary role is never suggested", () => {
  assert.equal(
    suggestUploadDocumentRole("Bilag 1.pdf", [{ role: "primary_customer_document" }]),
    "supporting_document",
  );
  assert.equal(
    suggestUploadDocumentRole("Bilag 2.pdf", [
      { role: "supporting_document" },
      { role: "primary_solution_document" },
    ]),
    "supporting_document",
  );
  assert.equal(
    suggestUploadDocumentRole("Bilag 2.pdf", [{ role: "primary_customer_document" }]),
    "primary_solution_document",
    "the other primary role stays available",
  );
});
