import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tenderRoot = path.resolve(frontendRoot, "../../test-data/tenders/halandsvik-2026");
const { createJiti } = createRequire(import.meta.url)("jiti");
const jiti = createJiti(path.join(frontendRoot, "halandsvik-tender-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const lib = (relative) => jiti(path.join(frontendRoot, "lib", relative));
const { extractTextFromBuffer, contentTypeForUploadFormat, inferUploadFileFormat } = lib("server/documents.ts");
const { extractRequirementLedgerWithCorrections } = lib("server/requirements/source-ledger.ts");
const { canonicalRequirementSourceDocuments, canonicalizeRequirementSourceLedger } = lib("server/requirements/source-readiness.ts");
const { sortRequirementLedgerInDocumentOrder } = lib("server/requirements/presentation.ts");
const { selectProjectDocuments } = lib("server/domain/project-documents.ts");

const DOCUMENTS = [
  ["01_Konkurransegrunnlag_Halandsvik_kommune.pdf", "primary_customer_document", null, "Konkurransegrunnlag – Skyplattform og drift av kommunale fagsystemer"],
  ["02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf", "supporting_document", "kravdokument", "Bilag 1 Kravspesifikasjon"],
  ["03_Bilag_2_Evaluering_og_tildeling_Halandsvik_kommune.docx", "supporting_document", "vedlegg", "Bilag 2 Evaluering og tildeling"],
  ["04_Losningsnotat_Atea_Halandsvik.docx", "primary_solution_document", null, "Løsningsnotat Atea – utkast til tilbud"],
];

async function loadDocuments() {
  return Promise.all(DOCUMENTS.map(async ([file, role, subtype, title], index) => {
    const buffer = await readFile(path.join(tenderRoot, "documents", file));
    const fileFormat = inferUploadFileFormat({ fileName: file });
    const parsed = await extractTextFromBuffer({
      buffer,
      fileName: file,
      contentType: contentTypeForUploadFormat(fileFormat),
      role,
      useDocling: false,
    });
    return {
      id: `halandsvik-${index + 1}`,
      project_id: "halandsvik",
      role,
      supporting_subtype: subtype,
      title,
      file_name: file,
      file_format: parsed.fileFormat ?? fileFormat,
      content_type: contentTypeForUploadFormat(fileFormat),
      file_size_bytes: buffer.length,
      page_count: parsed.pageCount ?? null,
      processing_status: "enhanced_ready",
      parser_used: parsed.parserUsed,
      raw_text: parsed.rawText,
      file_base64: buffer.toString("base64"),
      structure_map: parsed.sourceMap,
      chunk_source_revision: 1,
      created_at: "2026-10-31T00:00:00.000Z",
      updated_at: "2026-10-31T00:00:00.000Z",
    };
  }));
}

const comparable = (value) => value.normalize("NFKC").replace(/[‐‑‒–—]/gu, "-").replace(/\s+/gu, " ").trim();

test("a tender numbered K-x.y.z yields one current row per requirement in its own register", async () => {
  const fasit = JSON.parse(await readFile(path.join(tenderRoot, "fasit.json"), "utf8"));
  const documents = await loadDocuments();
  const { customerDocument } = selectProjectDocuments(documents);
  const sourceDocuments = canonicalRequirementSourceDocuments({ customerDocument, documents });
  const requirementLedgerResults = [];
  for (const document of sourceDocuments) {
    requirementLedgerResults.push({ document, ...await extractRequirementLedgerWithCorrections(document) });
  }
  const ledger = sortRequirementLedgerInDocumentOrder(
    canonicalizeRequirementSourceLedger({ sourceDocuments, requirementLedgerResults }),
  );

  // Three-level IDs stay whole, the corrections chapter in the main tender
  // document changes K-4.1.2 in Bilag 1, and the IDs the main document and
  // the award criteria only mention never become rows of their own.
  assert.deepEqual(
    ledger.map((entry) => [entry.id, comparable(entry.text), entry.documentTitle]),
    fasit.requirements.map((requirement) => [
      requirement.id,
      comparable(requirement.current_text),
      "Bilag 1 Kravspesifikasjon",
    ]),
  );
  // The historical background paragraph is not part of any requirement.
  assert.ok(ledger.every((entry) => !/Fjellnett|på bånd|Kvernhusbakken/u.test(entry.text)));
  // Original wording stays available for audit after the correction.
  const corrected = ledger.find((entry) => entry.id === "K-4.1.2");
  assert.match(corrected.sourceExcerpt ?? "", /8 timer/u);
});

test("source facts from the tender never become glued analysis items", async () => {
  const documents = await loadDocuments();
  const { collectArtifactFoundationFacts, enrichCustomerAnalysisWithFoundationFacts } = lib("server/ai.ts");
  const facts = collectArtifactFoundationFacts({ documents: documents.slice(0, 3), serviceDocuments: [] });
  assert.ok(facts.length > 0);
  // Facts are prompt context: whole logical lines and sentences, no page
  // markers, no sentence running into a table row.
  assert.ok(facts.every((fact) => !/\[\[SIDE|\. Rad \d+:|\| [^|]*\. [A-ZÆØÅ][^|]* \| /u.test(fact.text)), JSON.stringify(facts.map((fact) => fact.text)));
  const analysis = {
    prioritized_requirements: [{ requirement: "Tilbudsfrist 10. november 2026.", priority: "Kritisk", reason: "Rettelse nr. 1." }],
    likely_evaluation_criteria: ["Pris 40 %"],
    expected_solution_direction: ["Skyplattform innenfor EØS."],
    risks_for_us: [],
  };
  const enriched = enrichCustomerAnalysisWithFoundationFacts(analysis, facts);
  assert.deepEqual(enriched.prioritized_requirements, analysis.prioritized_requirements);
  assert.deepEqual(enriched.likely_evaluation_criteria, analysis.likely_evaluation_criteria);
  assert.deepEqual(enriched.expected_solution_direction, analysis.expected_solution_direction);
  assert.ok(JSON.stringify(enriched).split("dokumentert kildegrunnlag").length <= 1);
});
