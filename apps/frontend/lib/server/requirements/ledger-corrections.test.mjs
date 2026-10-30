import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const jiti = createJiti(path.join(frontendRoot, "ledger-corrections-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const load = (file) => jiti.import(path.join(frontendRoot, file));
const { buildSpreadsheetRequirementLedger } = await load("lib/server/requirements/spreadsheet-ledger.ts");
const { applyRequirementCorrections, findCorrectionsSection } = await load(
  "lib/server/requirements/corrections.ts",
);
const { assertExplicitRequirementLedgersComplete } = await load(
  "lib/server/requirements/source-readiness.ts",
);

// The spreadsheet parser's row format (lib/server/documents.ts).
const matrix = [
  "Ark: Les meg",
  "Rad 1: A1: Fyll ut kolonne F.",
  "",
  "Ark: Krav",
  "Rad 2: A2: Kravliste for drift",
  "Rad 3: A3: Nr. | B3: Område | C3: Krav | D3: Kravtype | E3: Vekt | F3: Tilbyders svar",
  "Rad 4: A4: A Generelle krav",
  "Rad 5: A5: GEN-1 | B5: Kontrakt | C5: Tilbyder skal godta de alminnelige kontraktsvilkårene uten forbehold. | D5: Minstekrav",
  "Rad 6: A6: GEN-2 | B6: Referanser | C6: Tilbyder bør legge ved to referanser fra tilsvarende oppdrag. | D6: Tildeling | E6: 20 % | F6: Vi legger ved tre.",
  "Rad 7: A7: B Drift",
  "Rad 8: A8: DR-10 | B8: Overvåking | C8: Overvåking skal dekke alle | servere hele døgnet. | D8: Minstekrav",
  "Rad 9: A9: Merknad | C9: Kolonnene må ikke endres.",
].join("\n");

test("a spreadsheet requirement matrix yields one requirement per data row", () => {
  const ledger = buildSpreadsheetRequirementLedger({ file_format: "xlsx", raw_text: matrix });
  assert.deepEqual(ledger.map((entry) => entry.id), ["GEN-1", "GEN-2", "DR-10"]);
  assert.equal(ledger[0].heading, "A Generelle krav");
  assert.equal(ledger[2].heading, "B Drift");
  // A literal " | " inside a cell stays in the requirement text.
  assert.equal(ledger[2].text, "Overvåking skal dekke alle | servere hele døgnet.");
  assert.match(ledger[1].sourceExcerpt, /Ark Krav, Rad 6 .*Type: Tildeling .*Vekt: 20 %/u);
  // The supplier's answer column is not part of the source requirement.
  assert.doesNotMatch(ledger[1].sourceExcerpt, /Vi legger ved tre/u);
});

test("spreadsheets without a requirement matrix fall through to other extractors", () => {
  assert.deepEqual(
    buildSpreadsheetRequirementLedger({ file_format: "xlsx", raw_text: "Ark: Priser\nRad 1: A1: Post | B1: Pris\nRad 2: A2: Drift | B2: 100" }),
    [],
  );
  assert.deepEqual(buildSpreadsheetRequirementLedger({ file_format: "docx", raw_text: matrix }), []);
});

const ledger = [
  { id: "OPS-1", text: "Leverandøren skal svare på hendelser innen én time.", pages: [3], heading: "4 Drift" },
  { id: "OPS-2", text: "Leverandøren bør tilby en kvartalsvis driftsrapport.", pages: [3], heading: "4 Drift" },
  { id: "SEC-3", text: "Data skal krypteres i ro.", pages: [4], heading: "5 Sikkerhet" },
  { id: "SEC-3", text: "Tilgangslogger skal lagres i seks måneder.", pages: [4], heading: "5 Sikkerhet" },
  { id: "SEC-4", text: "Leverandøren skal ha sertifisert ISMS.", pages: [4], heading: "5 Sikkerhet" },
  { id: "R1", text: "OPS-1 endres. Ny tekst: «Leverandøren skal svare på hendelser innen 30 minutter.»", pages: [9], heading: "8 Rettelser" },
];
const document = [
  "1 Innhold",
  "8 Rettelser",
  "",
  "4 Drift",
  "OPS-1 Leverandøren skal svare på hendelser innen én time.",
  "",
  "8 Rettelser",
  "Endringene i dette kapitlet går foran kravene i kapittel 4 og 5, som ikke er oppdatert.",
  "Tabell 9",
  "Rad 1: Nr. | Krav | Endring",
  "Rad 2: R1 | OPS-1 | OPS-1 endres. Ny tekst: «Leverandøren skal svare på hendelser innen 30 minutter.»",
  "Rad 3: R2 | OPS-2 | Kravet bortfaller og skal ikke besvares.",
  "Rad 4: R3 | SEC-3 | SEC-3 er brukt to ganger. Det andre kravet (tilgangslogger) får ny ID SEC-5.",
  "Rad 5: R4 | Nytt krav SEC-6 | Følgende krav legges til kapittel 5: «Leverandøren skal teste beredskapsplanen årlig.»",
  "Rad 6: R5 | SEC-4 | Sertifiseringen må gjelde hele avtaleperioden.",
  "",
  "Spørsmål 1: Gjelder OPS-1 også i helger?",
  "",
  "Svar: Ja, OPS-1 gjelder hele døgnet alle dager.",
  "",
  "Vedlegg A Tjenesteliste",
  "OPS-2 nevnes her uten endring.",
].join("\n");

test("the corrections chapter is the last matching heading with content, ending at the appendix", () => {
  const section = findCorrectionsSection(document);
  assert.match(section, /^8 Rettelser\nEndringene/u);
  assert.doesNotMatch(section, /Vedlegg A/u);
});

test("corrections change, withdraw, renumber and add requirements and keep the original text", () => {
  const { ledger: corrected, report } = applyRequirementCorrections(ledger, document);
  assert.deepEqual(corrected.map((entry) => entry.id), ["OPS-1", "SEC-3", "SEC-5", "SEC-4", "SEC-6"]);
  assert.equal(corrected[0].text, "Leverandøren skal svare på hendelser innen 30 minutter.");
  assert.match(corrected[0].sourceExcerpt, /Opprinnelig tekst: Leverandøren skal svare på hendelser innen én time\./u);
  assert.match(corrected[0].sourceExcerpt, /Presisering i rettelse: Svar: Ja, OPS-1 gjelder hele døgnet/u);
  assert.equal(corrected[1].text, "Data skal krypteres i ro.");
  assert.equal(corrected[2].text, "Tilgangslogger skal lagres i seks måneder.");
  // A new requirement follows the last requirement with the same prefix.
  assert.equal(corrected[4].text, "Leverandøren skal teste beredskapsplanen årlig.");
  assert.equal(corrected[4].heading, "5 Sikkerhet");
  // A statement without new wording is attached as a note, not applied.
  assert.equal(corrected[3].text, "Leverandøren skal ha sertifisert ISMS.");
  assert.match(corrected[3].sourceExcerpt, /Rettelse: .*hele avtaleperioden/u);
  assert.deepEqual(report.withdrawn, ["OPS-2"]);
  assert.deepEqual(report.renumbered, ["SEC-3->SEC-5"]);
});

test("documents without a corrections chapter are unchanged", () => {
  const plain = "4 Drift\nOPS-1 Leverandøren skal svare på hendelser innen én time.";
  assert.equal(applyRequirementCorrections(ledger, plain).ledger, ledger);
});

test("award criteria rows in another sheet do not count as missing requirements", () => {
  const raw_text = [
    matrix,
    "",
    "Ark: Tildelingskriterier",
    "Rad 1: A1: Nr. | B1: Kriterium | C1: Vekt",
    "Rad 2: A2: K1 | B2: Pris | C2: 40 %",
    "Rad 3: A3: K2 | B3: Kvalitet | C3: 60 %",
  ].join("\n");
  const document = {
    id: "matrix-doc",
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: "Kravdokument",
    file_format: "xlsx",
    raw_text,
    structure_map: [],
  };
  const ledger = buildSpreadsheetRequirementLedger(document);
  assert.doesNotThrow(() =>
    assertExplicitRequirementLedgersComplete([document], [{ document, ledger }]),
  );
  // Losing matrix rows downstream is still caught.
  assert.throws(
    () => assertExplicitRequirementLedgersComplete([document], [{ document, ledger: ledger.slice(0, 1) }]),
    /mangler eksplisitte kilderader|tom for kravdokument/u,
  );
});
