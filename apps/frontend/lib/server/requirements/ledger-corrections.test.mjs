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
const { applyRequirementCorrections, correctedRequirementIds, findCorrectionsSection } = await load(
  "lib/server/requirements/corrections.ts",
);
const { spreadsheetRequirementIds } = await load("lib/server/requirements/spreadsheet-ledger.ts");
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

test("wrapped table text and chapters without real corrections are not a corrections chapter", () => {
  const wrapped = [
    "4 Krav",
    "K-022 Tilgang Må Leverandøren skal logge",
    "endringer relatert til",
    "saksmottak og statusvisning. Tilgang skal kunne revideres og dokumenteres ved behov.",
    "K-023 Integrasjon Må Leverandøren skal beskrive begrensninger og forutsetninger.",
  ].join("\n");
  assert.equal(findCorrectionsSection(wrapped), null);
  const ledgerWithK = [
    { id: "K-022", text: "Leverandøren skal logge endringer relatert til saksmottak og statusvisning.", pages: [1], heading: "4 Krav" },
  ];
  assert.equal(applyRequirementCorrections(ledgerWithK, wrapped).ledger, ledgerWithK);
  // A real heading whose content corrects nothing in this ledger is ignored.
  const unrelated = "8 Rettelser\nDenne versjonen retter skrivefeil i innledningen og oppdaterer kontaktinformasjonen til saksbehandler.";
  assert.equal(applyRequirementCorrections(ledgerWithK, unrelated).ledger, ledgerWithK);
});

const base = [
  { id: "OPS-1", text: "Leverandøren skal svare på hendelser innen én time.", pages: [3], heading: "4 Drift" },
  { id: "OPS-2", text: "Leverandøren bør tilby en kvartalsvis driftsrapport.", pages: [3], heading: "4 Drift" },
];
const ids = (ledger) => ledger.map((entry) => entry.id);

test("council probes: old-to-new wording, negated withdrawal, consecutive lines, unique renumbering, short chapter", () => {
  const fromTo = applyRequirementCorrections(
    base,
    "8 Rettelser\nOPS-1 endres fra «Leverandøren skal svare på hendelser innen én time.» til «Leverandøren skal svare på hendelser innen 15 minutter.»",
  ).ledger;
  assert.deepEqual(ids(fromTo), ["OPS-1", "OPS-2"]);
  assert.equal(fromTo[0].text, "Leverandøren skal svare på hendelser innen 15 minutter.");

  const negated = applyRequirementCorrections(
    base,
    "8 Rettelser\nOPS-1 utgår ikke. Kravet opprettholdes, men OPS-2 endres. Ny tekst: «Leverandøren bør tilby en månedlig driftsrapport.»",
  ).ledger;
  assert.ok(ids(negated).includes("OPS-1"));

  const consecutive = applyRequirementCorrections(
    base,
    "8 Rettelser\nOPS-1 endres. Ny tekst: «Leverandøren skal svare på hendelser innen 30 minutter.»\nOPS-2 utgår.",
  ).ledger;
  assert.deepEqual(ids(consecutive), ["OPS-1"]);
  assert.match(consecutive[0].text, /30 minutter/u);

  assert.deepEqual(ids(applyRequirementCorrections(base, "8 Rettelser\nOPS-1 får ny ID OPS-9.").ledger), ["OPS-9", "OPS-2"]);
  assert.deepEqual(ids(applyRequirementCorrections(base, "8 Rettelser\nOPS-2 utgår.").ledger), ["OPS-1"]);
  // The completeness inventory follows the same corrections.
  assert.deepEqual(correctedRequirementIds(["OPS-1", "OPS-2"], "8 Rettelser\nOPS-2 utgår.\nOPS-1 får ny ID OPS-9."), ["OPS-9"]);
});

test("matrices with a repeated layout or a two-row header keep every row", () => {
  const raw_text = [
    "Ark: Krav",
    "Rad 1: A1: ID | B1: Kravtekst",
    "Rad 2: A2: A-1 | B2: Første krav i første layout skal oppfylles.",
    "Rad 3: A3: ID | B3: Område | C3: Kravtekst",
    "Rad 4: A4: A-2 | B4: Drift | C4: Andre krav i ny layout skal oppfylles.",
    "",
    "Ark: Flere",
    "Rad 1: A1: Krav-ID | B1: Merknad",
    "Rad 2: B2: Kravtekst",
    "Rad 3: A3: 7 | B3: Et krav med bare tallnummer skal også med.",
    "Rad 4: A4: B-2 | B4: Kort",
  ].join("\n");
  const document = { file_format: "xlsx", raw_text };
  assert.deepEqual(spreadsheetRequirementIds(document), ["A-1", "A-2", "7", "B-2"]);
  assert.deepEqual(buildSpreadsheetRequirementLedger(document).map((entry) => entry.id), ["A-1", "A-2", "7", "B-2"]);
  assert.equal(buildSpreadsheetRequirementLedger(document)[1].text, "Andre krav i ny layout skal oppfylles.");
});

test("second member's probes: scoped withdrawals, change targets, contract headings, text column priority", () => {
  const ledgerK = [
    { id: "K-5", text: "Leverandøren skal levere månedlige rapporter.", pages: [1], heading: "4" },
    { id: "K-6", text: "Leverandøren skal tilby norskspråklig support.", pages: [1], heading: "4" },
    { id: "SIK-1", text: "Krypteringsnøkler skal roteres årlig.", pages: [1], heading: "5" },
  ];
  const run = (text) => applyRequirementCorrections(ledgerK, text).ledger;
  assert.ok(ids(run("8 Rettelser\nNei, K-6 utgår ikke og skal besvares.\nK-5 utgår.")).includes("K-6"));
  assert.ok(ids(run("8 Rettelser\nSIK-1: Kravet om at nøkler slettes etter bruk presiseres.\nK-5 utgår.")).includes("SIK-1"));
  const retargeted = run("8 Rettelser\nK-6 og K-5 endres. K-5 skal nå lyde: «Leverandøren skal levere ukentlige rapporter.»");
  assert.equal(retargeted.find((entry) => entry.id === "K-5").text, "Leverandøren skal levere ukentlige rapporter.");
  assert.equal(retargeted.find((entry) => entry.id === "K-6").text, "Leverandøren skal tilby norskspråklig support.");
  assert.equal(findCorrectionsSection("9 Endringer i kravspesifikasjonen etter kontraktsinngåelse\nVed opphør slettes data i henhold til SIK-1."), null);

  const matrixWithTitle = [
    "Ark: Krav",
    "Rad 1: A1: Nr | B1: Krav | C1: Beskrivelse (av krav) | D1: Svar",
    "Rad 2: A2: K-1 | B2: Språk | C2: Brukergrensesnittet skal være på norsk bokmål og nynorsk. | D2: Ja",
  ].join("\n");
  const [row] = buildSpreadsheetRequirementLedger({ file_format: "xlsx", raw_text: matrixWithTitle });
  assert.equal(row.text, "Språk: Brukergrensesnittet skal være på norsk bokmål og nynorsk.");
  assert.doesNotMatch(row.sourceExcerpt, /\| Ja/u);
});

test("round 5 probes: ID lists, context IDs, quoted IDs and verbs, list formats, negation forms", () => {
  const k = (n, text) => ({ id: `K-${n}`, text: text ?? `Leverandøren skal oppfylle krav nummer ${n} fullt ut.`, pages: [1], heading: "4" });
  const ledger = [k(1, "Tilgangsrettigheter skal endres ved rollebytte."), k(2), k(3), k(4), k(5), k(6), k(7)];
  const run = (text) => applyRequirementCorrections(ledger, `8 Rettelser\n${text}`).ledger;
  const has = (result, id) => result.some((entry) => entry.id === id);

  const list = run("Kravene K-4, K-6 og K-7 utgår.");
  assert.ok(!has(list, "K-4") && !has(list, "K-6") && !has(list, "K-7") && has(list, "K-5"));
  const contextual = run("Som følge av endringen i K-3 utgår K-7.");
  assert.ok(has(contextual, "K-3") && !has(contextual, "K-7"));
  const replaced = run("K-6 utgår og erstattes av nytt krav K-16: «Leverandøren skal tilby døgnkontinuerlig vakt.»");
  assert.ok(!has(replaced, "K-6") && has(replaced, "K-16"));
  const quotedVerb = run("K-1 endres fra «Tilgangsrettigheter skal endres ved rollebytte.» til «Tilgangsrettigheter skal revurderes månedlig.»");
  assert.equal(quotedVerb.find((entry) => entry.id === "K-1").text, "Tilgangsrettigheter skal revurderes månedlig.");
  const quotedId = run("K-1 endres fra «Tilgangsstyring skal følge kontrollene i K-2.» til «Tilgangsstyring skal gjennomgås hvert kvartal.»");
  assert.equal(quotedId.find((entry) => entry.id === "K-1").text, "Tilgangsstyring skal gjennomgås hvert kvartal.");
  assert.match(quotedId.find((entry) => entry.id === "K-2").text, /nummer 2/u);
  const kept = run("K-1 beholdes uendret. K-2 utgår.");
  assert.ok(has(kept, "K-1") && !has(kept, "K-2"));
  for (const negated of ["K-1 skal ikke tas ut fra kravspesifikasjonen.", "K-1 utgår heller ikke.", "Nei, K-1 utgår ikke og skal besvares."]) {
    assert.ok(has(run(`${negated}\nK-5 utgår.`), "K-1"), negated);
  }
  for (const format of ["- K-4 utgår.\n- K-5 utgår.", "1. K-4 utgår.\n2. K-5 utgår.", "Kravet K-4 utgår.\nKravet K-5 utgår.", "| K-4 | Utgår |\n| K-5 | Utgår |", "K-1 endres. Ny tekst: «Tilgangsrettigheter skal revurderes månedlig.»\nFor K-5 gjelder følgende: Kravet utgår."]) {
    assert.ok(!has(run(format), "K-5"), format);
  }
  // "Rettelse av feil" is a subheading, not a corrections chapter.
  assert.equal(findCorrectionsSection("4.3 Rettelse av feil\nK-31 Defekt maskinvare erstattes innen neste virkedag."), null);
  // A renumbered requirement leaves no phantom of its old ID.
  const phantom = applyRequirementCorrections([...ledger, { id: "K-1", text: ".", pages: [9], heading: "8 Rettelser" }], "8 Rettelser\nK-1 får ny ID K-9.").ledger;
  assert.ok(!has(phantom, "K-1") && has(phantom, "K-9"));
});

test("matrix guards: numbered sections, price forms, continuations, answer columns, unread IDs", () => {
  const raw_text = [
    "Ark: Krav",
    "Rad 1: A1: Nr | B1: Kravtekst | C1: Tilbyders svar",
    "Rad 2: A2: 1 | B2: Generelle krav",
    "Rad 3: A3: 1.1 | B3: Leverandøren skal ha ISO 27001-sertifisering.",
    "Rad 4: B4: - gjelder også underleverandører",
    "Rad 5: A5: 1.2 | C5: Ja, funksjonen er standard i plattformen.",
    "Rad 6: A6: SIK-ARK-01 | B6: Arkitekturen skal dokumenteres.",
    "Rad 7: A7: 7a/II | B7: En rad med et uvanlig ID-format.",
    "",
    "Ark: Priser",
    "Rad 1: A1: Nr | B1: Beskrivelse | C1: Antall | D1: Enhetspris",
    "Rad 2: A2: 1 | B2: Lisens per bruker | C2: 600",
  ].join("\n");
  const document = { file_format: "xlsx", raw_text };
  const ledger = buildSpreadsheetRequirementLedger(document);
  assert.deepEqual(ledger.map((entry) => entry.id), ["1.1", "SIK-ARK-01", "7a/II"]);
  assert.equal(ledger[0].heading, "1 Generelle krav");
  assert.match(ledger[0].text, /gjelder også underleverandører/u);
  // The empty requirement cell and the unread ID stay in the inventory, so
  // the completeness guard reports them instead of losing them.
  assert.deepEqual(spreadsheetRequirementIds(document), ["1.1", "1.2", "SIK-ARK-01", "7a/II"]);
});

test("round 6 probes: clause-bound withdrawals, negated additions and renumbering, inventories", () => {
  const k = (n) => ({ id: `K-${n}`, text: `Leverandøren skal oppfylle krav nummer ${n} fullt ut.`, pages: [1], heading: "4" });
  const ledger = [k(1), k(2), k(3)];
  const run = (text) => applyRequirementCorrections(ledger, `8 Rettelser\n${text}`).ledger.map((entry) => entry.id);
  assert.deepEqual(run("K-1 beholdes uendret, mens K-2 utgår."), ["K-1", "K-3"]);
  assert.deepEqual(run("K-1 utgår ikke, men K-2 utgår."), ["K-1", "K-3"]);
  assert.deepEqual(run("K-1 får ikke ny ID K-9.\nK-3 utgår."), ["K-1", "K-2"]);
  assert.deepEqual(
    run("Det legges ikke til nytt krav K-9: «Leverandøren skal levere månedlig sikkerhetsrapport.»\nK-3 utgår."),
    ["K-1", "K-2"],
  );

  // Inventories come from the original text: a correction table adding K-9
  // or referring to K-1 does not distort what the guard expects.
  const text = [
    "4 Krav",
    "| Krav-ID | Kravtekst |",
    "| K-1 | Leverandøren skal oppfylle krav nummer 1 fullt ut. |",
    "| K-2 | Leverandøren skal oppfylle krav nummer 2 fullt ut. |",
    "| K-3 | Leverandøren skal oppfylle krav nummer 3 fullt ut. |",
    "",
    "8 Rettelser",
    "| Nr. | Krav | Endring |",
    "| 1 | K-1 | Kravet endres. Ny tekst: «Leverandøren skal oppfylle krav nummer 1 innen fristen.» |",
    "| 2 | Nytt krav K-9 | Følgende krav legges til: «Leverandøren skal levere en exitplan.» |",
  ].join("\n");
  const document = { id: "doc", role: "primary_customer_document", title: "Bilag 1", file_format: "md", raw_text: text, structure_map: [] };
  const corrected = applyRequirementCorrections(ledger, text).ledger;
  assert.deepEqual(corrected.map((entry) => entry.id), ["K-1", "K-2", "K-3", "K-9"]);
  assert.doesNotThrow(() => assertExplicitRequirementLedgersComplete([document], [{ document, ledger: corrected }]));
});

test("supplier answer columns never stand in for missing requirement text", () => {
  const raw_text = [
    "Ark: Krav",
    "Rad 1: A1: Krav-ID | B1: Kravtekst | C1: Svar | D1: Leverandørens besvarelse | E1: Oppfylt (Ja/Nei)",
    "Rad 2: A2: K-1 | C2: Ja | D2: Vi har standard backup i Azure. | E2: Ja",
    "Rad 3: A3: K-2 | B3: Leverandøren skal ta daglig backup. | E3: Ja",
  ].join("\n");
  const document = { file_format: "xlsx", raw_text };
  assert.deepEqual(buildSpreadsheetRequirementLedger(document).map((entry) => [entry.id, entry.text]), [["K-2", "Leverandøren skal ta daglig backup."]]);
  // The row without readable requirement text stays in the inventory.
  assert.deepEqual(spreadsheetRequirementIds(document), ["K-1", "K-2"]);
});

test("round 6 (second member) probes: questions, row subjects, bound verbs, replaced wording, matrices", () => {
  const k = (n, text) => ({ id: `K-${n}`, text: text ?? `Leverandøren skal oppfylle krav nummer ${n} fullt ut.`, pages: [1], heading: "4" });
  const ledger = [k(2), k(3), k(4), k(5), k(6), k(7)];
  const ids = (text, source = ledger, raw) => applyRequirementCorrections(source, raw ?? `8 Rettelser\n${text}`).ledger.map((entry) => entry.id);
  // A bidder question never withdraws.
  assert.deepEqual(ids("Kan K-4 strykes dersom vi oppfyller K-3?\nK-7 utgår."), ["K-2", "K-3", "K-4", "K-5", "K-6"]);
  // Every ID of a row's subject cell is withdrawn.
  assert.deepEqual(ids("| 1 | K-6 og K-7 | Kravene utgår som følge av endret omfang. |"), ["K-2", "K-3", "K-4", "K-5"]);
  // A verb in a relative clause or tied to another ID does not withdraw.
  assert.ok(ids("K-4: Data som utgår av arkivet skal slettes etter ett år.\nK-7 utgår.").includes("K-4"));
  const changed = applyRequirementCorrections(ledger, "8 Rettelser\nK-2 endres som følge av at K-3 utgår: «Leverandøren skal levere ukentlige rapporter.»").ledger;
  assert.equal(changed.find((entry) => entry.id === "K-2").text, "Leverandøren skal levere ukentlige rapporter.");
  // "utgår og erstattes av: «…»" changes the wording.
  const replaced = applyRequirementCorrections(ledger, "8 Rettelser\nK-6 utgår og erstattes av: «Leverandøren skal tilby døgnvakt.»").ledger;
  assert.equal(replaced.find((entry) => entry.id === "K-6")?.text, "Leverandøren skal tilby døgnvakt.");
  // Ranges and further phrasings.
  assert.deepEqual(ids("Kravene K-4 til K-6 utgår."), ["K-2", "K-3", "K-7"]);
  assert.deepEqual(ids("K-3 slettes.\nK-5 er utgått."), ["K-2", "K-4", "K-6", "K-7"]);
  // An original requirement repeated unquoted in an "Opprinnelig tekst" column stays.
  const raw = [
    "4 Krav",
    "K-2 Leverandøren skal oppfylle krav nummer 2 fullt ut.",
    "",
    "8 Rettelser",
    "| Nr. | Krav | Opprinnelig tekst | Ny tekst |",
    "| 1 | K-2 | Leverandøren skal oppfylle krav nummer 2 fullt ut. | Kravet endres. Ny tekst: «Leverandøren skal oppfylle krav nummer 2 innen 30 dager.» |",
  ].join("\n");
  const kept = applyRequirementCorrections([k(2)], raw).ledger;
  assert.equal(kept[0]?.text, "Leverandøren skal oppfylle krav nummer 2 innen 30 dager.");

  const matrix = [
    "Ark: Krav",
    "Rad 1: A1: Nr | B1: Kravtekst | C1: Enhet",
    "Rad 2: A2: 2 | B2: Leverandøren skal tilby opplæring. Opplæringen skal omfatte: | C2: IT",
    "Rad 3: A3: 2.1 | B3: Grunnkurs for alle brukere. | C3: IT",
  ].join("\n");
  assert.deepEqual(buildSpreadsheetRequirementLedger({ file_format: "xlsx", raw_text: matrix }).map((entry) => entry.id), ["2", "2.1"]);
});

test("round 7 probes: earlier predicates, question columns, unquoted new wording", () => {
  const k = (n) => ({ id: `K-${n}`, text: `Leverandøren skal oppfylle krav nummer ${n} fullt ut.`, pages: [1], heading: "4" });
  // A realistic document: the requirements chapter, then the corrections.
  const chapter = [k(1), k(2), k(3)].map((entry) => `${entry.id} ${entry.text}`).join("\n");
  const run = (text) => applyRequirementCorrections([k(1), k(2), k(3)], `4 Krav\n${chapter}\n\n9 Rettelser og presiseringer\n${text}`).ledger;
  const ids = (text) => run(text).map((entry) => entry.id);
  assert.deepEqual(ids("K-1 beholdes og K-2 utgår."), ["K-1", "K-3"]);
  assert.deepEqual(ids("K-1 endres til: «Leverandøren skal tilby support på norsk hele døgnet.» K-2 utgår."), ["K-1", "K-3"]);
  assert.deepEqual(
    ids("| Nr. | Krav | Spørsmål fra leverandør | Svar fra oppdragsgiver |\n| 1 | K-1 | Vi ber om at K-1 strykes. | Nei, kravet opprettholdes. |\n| 2 | K-3 | Kan K-3 utgå? | Ja, K-3 utgår. |"),
    ["K-1", "K-2"],
  );
  const unquoted = run("| Nr. | Krav | Endring |\n| 1 | K-1 | Kravet endres. Ny tekst: Leverandøren skal tilby support på norsk hele døgnet. |");
  assert.equal(unquoted[0].text, "Leverandøren skal tilby support på norsk hele døgnet.");
  const columns = run("| Nr. | Krav | Opprinnelig tekst | Ny tekst |\n| 1 | K-2 | Leverandøren skal oppfylle krav nummer 2 fullt ut. | Leverandøren skal oppfylle krav nummer 2 innen 30 dager. |");
  assert.equal(columns.find((entry) => entry.id === "K-2").text, "Leverandøren skal oppfylle krav nummer 2 innen 30 dager.");
});

test("round 7 Opus: Docling headings, partial rewording, row numbers, cell withdrawals", () => {
  const k = (n, text = `Leverandøren skal oppfylle krav nummer ${n} innen fem virkedager.`) => ({
    id: `K-${n}`,
    text,
    pages: [1],
    heading: "4 Krav",
  });
  const ledger = [k(1), k(2), k(3), k(4)];
  const chapter = ledger.map((entry) => `| ${entry.id} | ${entry.text} |`).join("\n");
  const run = (corrections) =>
    applyRequirementCorrections(ledger, `## 4 Krav\n| ID | Krav |\n|---|---|\n${chapter}\n\n${corrections}\n\n## Vedlegg A\nK-9 Leverandøren skal levere vedlegg.`);
  const byId = (result) => Object.fromEntries(result.ledger.map((entry) => [entry.id, entry.text]));

  // Docling markdown: "## 9 …" heading, a separator row and a table.
  // Docling markdown (2.132 output shape): "## 9 …" heading, bold header
  // cells, a separator row and "### 9.1" subsections inside the chapter.
  const docling = run(
    "## 9 Rettelser og presiseringer (Rettelse nr. 1 av 15.10.2026)\n\n### 9.1 Endringer i krav\n\n" +
      "| **Nr.** | **Gjelder** | **Endring** |\n|---|---|---|\n" +
      "| R1 | K-1 (tabell 4) | Kravet endres. Ny tekst: «Leverandøren skal oppfylle krav nummer 1 innen tre virkedager.» |\n" +
      "| R2 | K-4 (tabell 4) | Kravet utgår. |",
  );
  assert.deepEqual(docling.ledger.map((entry) => entry.id), ["K-1", "K-2", "K-3"]);
  assert.equal(byId(docling)["K-1"], "Leverandøren skal oppfylle krav nummer 1 innen tre virkedager.");

  // A partial rewording swaps only the quoted phrase; a bare fragment is a note.
  const partial = run("## 9 Rettelser\nI K-3 endres «fem virkedager» til «tre virkedager».\nFor K-2: Fristen endres til «tre virkedager».");
  assert.equal(byId(partial)["K-3"], "Leverandøren skal oppfylle krav nummer 3 innen tre virkedager.");
  assert.equal(byId(partial)["K-2"], k(2).text);
  assert.match(partial.ledger.find((entry) => entry.id === "K-2").sourceExcerpt ?? "", /Rettelse/u);
  const type = run("## 9 Rettelser\nFor K-1 endres kravtypen fra «Evalueringskrav» til «Absolutt krav».");
  assert.equal(byId(type)["K-1"], k(1).text);

  // A row number is not a new requirement replacing the wording.
  const rows = run("## 9 Rettelser\n| R-1 | K-2 | Kravet utgår og erstattes av: «Leverandøren skal oppfylle krav nummer 2 innen tre virkedager.» |");
  assert.equal(byId(rows)["K-2"], "Leverandøren skal oppfylle krav nummer 2 innen tre virkedager.");

  // "Utgår" in its own cell after a sentence, and further withdrawal verbs.
  const cell = run("## 9 Rettelser\n| K-1 | Leverandøren skal oppfylle krav nummer 1 innen fem virkedager. | Utgår |\nK-2 frafalles.\nK-3 beholdes uendret, K-4 utgår.");
  assert.deepEqual(cell.ledger.map((entry) => entry.id), ["K-3"]);
});

test("round 8 probes: short quotes, quoted and withdrawing new-text cells, partial and unquoted wording", () => {
  const k = (n, text = `Leverandøren skal oppfylle krav nummer ${n} innen fem virkedager.`) => ({ id: `K-${n}`, text, pages: [1], heading: "4 Krav" });
  const ledger = [
    k(1, "Sikkerhetskopier skal oppbevares i minst 90 dager."),
    k(2),
    k(3, "Leverandøren skal levere månedlig driftsrapport. Rapporten skal sendes innen fem virkedager."),
    k(4, "Tjenesten skal ha en tilgjengelighet på minst 99,5 % per måned."),
    k(5),
  ];
  const chapter = ledger.map((entry) => `${entry.id} ${entry.text}`).join("\n");
  const run = (corrections) => applyRequirementCorrections(ledger, `4 Krav\n${chapter}\n\n9 Rettelser og presiseringer\n${corrections}`).ledger;
  const byId = (result) => Object.fromEntries(result.map((entry) => [entry.id, entry.text]));

  // A short quoted phrase is replaced in place.
  assert.equal(byId(run("I K-1 endres «90 dager» til «13 måneder»."))["K-1"], "Sikkerhetskopier skal oppbevares i minst 13 måneder.");

  // A "Ny tekst" column with quoted wording applies; "Utgår" there withdraws.
  const table = run(
    "| Krav | Opprinnelig tekst | Ny tekst |\n" +
      `| K-2 | ${k(2).text} | «Leverandøren skal oppfylle krav nummer 2 innen tre virkedager.» |\n` +
      `| K-4 | ${ledger[3].text} | Kravet utgår. |\n` +
      `| K-5 | ${k(5).text} | Utgår |`,
  );
  assert.deepEqual(table.map((entry) => entry.id), ["K-1", "K-2", "K-3"]);
  assert.equal(byId(table)["K-2"], "Leverandøren skal oppfylle krav nummer 2 innen tre virkedager.");

  // A value or a single sentence is not the whole requirement.
  assert.equal(byId(run("Tilgjengelighetskravet i K-4 endres til 99,9 % målt per kalendermåned."))["K-4"], ledger[3].text);
  assert.equal(byId(run("K-3: Andre setning endres til: «Rapporten skal inneholde hendelser og avvik.»"))["K-3"], ledger[2].text);

  // Unquoted new wording ends before its rationale.
  assert.equal(
    byId(run("K-4 endres. Ny tekst: Tjenesten skal ha 99,9 % tilgjengelighet per måned. Endringen skyldes nye krav fra Datatilsynet."))["K-4"],
    "Tjenesten skal ha 99,9 % tilgjengelighet per måned.",
  );
});

test("spreadsheet matrices: solution answers kept, unreadable source rows never filled from answers", async () => {
  const { extractRequirementLedgerForDocument } = await load("lib/server/requirements/source-ledger.ts");
  const raw_text = [
    "Ark: Krav",
    "Rad 1: A1: Krav-ID | B1: Kravtekst | C1: Leverandørens besvarelse",
    "Rad 2: A2: K-1 | C2: Vi tar daglig backup i Azure med 35 dagers oppbevaring.",
  ].join("\n");
  const base = { id: "d", project_id: "p", title: "Kravmatrise", file_name: "krav.xlsx", file_format: "xlsx", raw_text, structure_map: [] };
  const source = await extractRequirementLedgerForDocument({ ...base, role: "primary_customer_document" });
  assert.ok(!source.some((entry) => /daglig backup/u.test(entry.text)), JSON.stringify(source));
  const answered = [
    "Ark: Krav",
    "Rad 1: A1: Krav-ID | B1: Kravtekst | C1: Leverandørens besvarelse",
    "Rad 2: A2: K-1 | B2: Leverandøren skal ta daglig backup. | C2: Vi tar daglig backup i Azure med 35 dagers oppbevaring.",
  ].join("\n");
  const solution = await extractRequirementLedgerForDocument({ ...base, raw_text: answered, role: "primary_solution_document" });
  // As before the matrix extractor: the solution row keeps its answer cell.
  assert.ok(solution.some((entry) => /35 dagers oppbevaring/u.test(`${entry.text} ${entry.answerExcerpt ?? ""}`)), JSON.stringify(solution));
});

test("round 9 probes: unquoted new wording keeps every sentence before its rationale", () => {
  const ledger = [{ id: "K-3", text: "Leverandøren skal levere kvartalsvis driftsrapport.", pages: [1], heading: "4 Krav" }];
  const raw = (corrections) => `4 Krav\nK-3 ${ledger[0].text}\n\n9 Rettelser\n${corrections}`;
  const text = (corrections) => applyRequirementCorrections(ledger, raw(corrections)).ledger[0].text;
  assert.equal(
    text("K-3 endres. Ny tekst: Leverandøren skal levere månedlig driftsrapport. Rapporten må være tilgjengelig i portalen."),
    "Leverandøren skal levere månedlig driftsrapport. Rapporten må være tilgjengelig i portalen.",
  );
  assert.equal(
    text("K-3 endres. Ny tekst: Leverandøren skal levere månedlig driftsrapport. Rapporten publiseres i portalen. Bakgrunnen er behov for tettere oppfølging."),
    "Leverandøren skal levere månedlig driftsrapport. Rapporten publiseres i portalen.",
  );
  // Where unquoted wording ends is unclear: no rewrite, never a dropped
  // condition or an administrative sentence stored as requirement text.
  for (const unclear of [
    "K-3 endres. Ny tekst: Leverandøren skal levere månedlig driftsrapport. Svarfristen forlenges til 15. november.",
    "K-3 endres. Ny tekst: Leverandøren skal levere døgnkontinuerlig brukerstøtte. Responstiden er maksimalt 30 minutter.",
  ]) {
    assert.equal(text(unclear), ledger[0].text, unclear);
  }
  // "lyder nå" ends in a letter \b does not see.
  assert.equal(text("K-3 lyder nå: «Leverandøren skal levere månedlig driftsrapport.»"), "Leverandøren skal levere månedlig driftsrapport.");
});

test("round 9 (second member): clarifying and removing new-text cells", () => {
  const ledger = [
    { id: "K-5", text: "Responstid for A-feil skal være maks 2 timer.", pages: [1], heading: "4 Krav" },
    { id: "K-6", text: "Leverandøren skal levere månedlig driftsrapport.", pages: [1], heading: "4 Krav" },
    { id: "K-7", text: "Leverandøren skal tilby døgnkontinuerlig vakt.", pages: [1], heading: "4 Krav" },
  ];
  const chapter = ledger.map((entry) => `${entry.id} ${entry.text}`).join("\n");
  const result = applyRequirementCorrections(
    ledger,
    `4 Krav\n${chapter}\n\n9 Rettelser\n| Krav-ID | Endring | Ny tekst |\n| K-5 | Presisering | Gjelder kun produksjonsmiljøet. |\n| K-6 | Rettelse | Fjernes |\n| K-7 | Rettelse | Kravet tas ut. |`,
  ).ledger;
  assert.deepEqual(result.map((entry) => [entry.id, entry.text]), [["K-5", ledger[0].text]]);
});

test("round 10: a scope clarification never replaces an obligation", () => {
  const ledger = [
    { id: "K-1", text: "Alle kundedata skal ha kryptert lagring i Norge.", pages: [1], heading: "4 Krav" },
    { id: "K-2", text: "Leverandøren skal levere månedlig driftsrapport.", pages: [1], heading: "4 Krav" },
  ];
  const chapter = ledger.map((entry) => `${entry.id} ${entry.text}`).join("\n");
  const raw = `4 Krav\n${chapter}\n\n9 Rettelser\n| Krav-ID | Endring | Ny tekst |\n| K-1 | Presisering | Kryptert lagring gjelder kun produksjonsmiljøet. |\n| K-2 | Rettelse | Utgår |`;
  const { ledger: result, report } = applyRequirementCorrections(ledger, raw);
  assert.deepEqual(result.map((entry) => [entry.id, entry.text]), [["K-1", ledger[0].text]]);
  assert.deepEqual(report.changed, []);
  assert.match(result[0].sourceExcerpt ?? "", /gjelder kun produksjonsmiljøet/u);
});

test("round 11: modal scope statements, generic stems, a closing scope sentence", () => {
  const storage = { id: "K-1", text: "Alle kundedata skal ha kryptert lagring i Norge.", pages: [1], heading: "4 Krav" };
  const other = { id: "K-2", text: "Leverandøren skal levere månedlig driftsrapport.", pages: [1], heading: "4 Krav" };
  const run = (row) =>
    applyRequirementCorrections(
      [storage, other],
      `4 Krav\nK-1 ${storage.text}\nK-2 ${other.text}\n\n9 Rettelser\n| Krav-ID | Endring | Ny tekst |\n${row}\n| K-2 | Rettelse | Utgår |`,
    ).ledger.find((entry) => entry.id === "K-1").text;
  for (const scope of ["Kryptert lagring skal kun gjelde produksjonsmiljøet.", "Kravet skal kun gjelde produksjonsmiljøet."]) {
    assert.equal(run(`| K-1 | Presisering | ${scope} |`), storage.text, scope);
  }
  // Full new wording followed by a scope sentence still applies, whole.
  assert.equal(
    run("| K-1 | Endring | Alle kundedata skal ha kryptert lagring innenfor EØS. Kravet gjelder kun produksjonsmiljøet. |"),
    "Alle kundedata skal ha kryptert lagring innenfor EØS. Kravet gjelder kun produksjonsmiljøet.",
  );
  // A generic stem ("lever") or a bare obligation does not continue the wording.
  const ledger = [{ id: "K-3", text: "Leverandøren skal levere kvartalsvis driftsrapport.", pages: [1], heading: "4 Krav" }];
  const text = (corrections) => applyRequirementCorrections(ledger, `4 Krav\nK-3 ${ledger[0].text}\n\n9 Rettelser\n${corrections}`).ledger[0].text;
  for (const unclear of [
    "K-3 endres. Ny tekst: Leverandøren skal levere månedlig driftsrapport. Leverandørkonferansen avholdes 3. oktober.",
    "K-3 endres. Ny tekst: Leverandøren skal levere månedlig driftsrapport. Tilbud skal leveres innen 15. november.",
  ]) {
    assert.equal(text(unclear), ledger[0].text, unclear);
  }
});

test("round 12: an unplaced change keeps its note when nothing else applies", () => {
  const ledger = [{ id: "K-3", text: "Leverandøren skal tilby brukerstøtte i kontortid.", pages: [1], heading: "4 Krav" }];
  const raw = `4 Krav\nK-3 ${ledger[0].text}\n\n9 Rettelser\nK-3 endres. Ny tekst: Leverandøren skal levere døgnkontinuerlig brukerstøtte. Responstiden er maksimalt 30 minutter.`;
  const { ledger: result } = applyRequirementCorrections(ledger, raw);
  assert.equal(result[0].text, ledger[0].text);
  assert.match(result[0].sourceExcerpt ?? "", /Responstiden er maksimalt 30 minutter/u);
  // A single scope clarification row keeps its note too.
  const scoped = applyRequirementCorrections(
    ledger,
    `4 Krav\nK-3 ${ledger[0].text}\n\n9 Rettelser\n| Krav-ID | Endring | Ny tekst |\n| K-3 | Presisering | Kravet skal kun gjelde produksjonsmiljøet. |`,
  ).ledger[0];
  assert.equal(scoped.text, ledger[0].text);
  assert.match(scoped.sourceExcerpt ?? "", /kun gjelde produksjonsmiljøet/u);
  // An administrative "Kravet er justert …" ends the new wording.
  const adjusted = applyRequirementCorrections(
    ledger,
    `4 Krav\nK-3 ${ledger[0].text}\n\n9 Rettelser\nK-3 endres. Ny tekst: Leverandøren skal tilby brukerstøtte hele døgnet. Kravet er justert etter innspill i spørsmålsrunden.`,
  ).ledger[0];
  assert.equal(adjusted.text, "Leverandøren skal tilby brukerstøtte hele døgnet.");
  // The IDs are unchanged, so completeness checks are unaffected.
  assert.deepEqual(correctedRequirementIds(["K-3"], raw), ["K-3"]);
});

test("matrix rows with unusual ID forms are kept under their ID, end to end", async () => {
  const { extractRequirementLedgerForDocument } = await load("lib/server/requirements/source-ledger.ts");
  const raw_text = [
    "Ark: Krav",
    "Rad 1: A1: Krav-ID | B1: Kravtekst",
    "Rad 2: A2: 1.1a | B2: Leverandøren skal levere en driftsplan.",
    "Rad 3: A3: K1-A | B3: Leverandøren skal levere en exitplan.",
    "Rad 4: A4: REQ_001 | B4: Leverandøren skal ha ISO 27001.",
    "Rad 5: A5: K-2 | B5: Leverandøren skal tilby døgnvakt.",
  ].join("\n");
  const document = { id: "d", project_id: "p", role: "primary_customer_document", title: "Krav", file_name: "krav.xlsx", file_format: "xlsx", raw_text, structure_map: [] };
  const ledger = await extractRequirementLedgerForDocument(document);
  assert.deepEqual(ledger.map((entry) => entry.id), ["1.1a", "K1-A", "REQ_001", "K-2"]);
  assert.doesNotThrow(() => assertExplicitRequirementLedgersComplete([document], [{ document, ledger }]));
});

test("a new requirement extracted from a corrections table is restored after removing correction rows", async () => {
  const { extractRequirementLedgerForDocument } = await load("lib/server/requirements/source-ledger.ts");
  const document = {
    id: "d", title: "Krav", role: "supporting_document", supporting_subtype: "kravdokument", file_format: "docx", structure_map: [],
    raw_text: [
      "4 Krav", "| Krav-ID | Kravtekst |", "| K-1 | Leverandøren skal levere en driftsplan. |",
      "", "9 Rettelser", "| Krav-ID | Kravtekst |",
      "| K-9 | Nytt krav K-9: «Leverandøren skal levere en exitplan.» |",
      "K-1 endres til: «Leverandøren skal levere en årlig driftsplan.»",
    ].join("\n"),
  };
  const extracted = await extractRequirementLedgerForDocument(document);
  assert.deepEqual(extracted.map((entry) => entry.id), ["K-1", "K-9"]);
  assert.equal(extracted[1].text, "Leverandøren skal levere en exitplan.");
  assert.doesNotThrow(() => assertExplicitRequirementLedgersComplete([document], [{ document, ledger: extracted }]));
});

test("an unusual spreadsheet ID without wording stays in the completeness inventory", () => {
  const document = {
    id: "d", title: "Krav", role: "supporting_document", supporting_subtype: "kravdokument", file_format: "xlsx",
    raw_text: ["Ark: Krav", "Rad 1: A1: Krav-ID | B1: Kravtekst",
      "Rad 2: A2: K-2 | B2: Leverandøren skal tilby døgnvakt.",
      "Rad 3: A3: REQ_001"].join("\n"),
  };
  const ledger = buildSpreadsheetRequirementLedger(document);
  assert.deepEqual(ledger.map((entry) => entry.id), ["K-2"]);
  assert.deepEqual(spreadsheetRequirementIds(document), ["K-2", "REQ_001"]);
  assert.throws(() => assertExplicitRequirementLedgersComplete([document], [{ document, ledger }]), /req001/u);
});

test("a numbered section label stays outside the matrix requirement inventory", () => {
  const document = {
    id: "d", title: "Krav", role: "supporting_document", supporting_subtype: "kravdokument", file_format: "xlsx",
    raw_text: ["Ark: Krav", "Rad 1: A1: Krav-ID | B1: Kravtekst",
      "Rad 2: A2: 1 Krav til tilbyder",
      "Rad 3: A3: K-2 | B3: Leverandøren skal tilby døgnvakt."].join("\n"),
  };
  const ledger = buildSpreadsheetRequirementLedger(document);
  assert.deepEqual(spreadsheetRequirementIds(document), ["K-2"]);
  assert.equal(ledger[0].heading, "1 Krav til tilbyder");
  assert.doesNotThrow(() => assertExplicitRequirementLedgersComplete([document], [{ document, ledger }]));
});

test("supplier wishes never withdraw requirements and rewrites retain existing provenance", () => {
  const source = [{ id: "K-4", text: "Leverandøren skal levere en driftsplan.", pages: [1], heading: "4 Krav", sourceExcerpt: "Ark Krav, Rad 8 | Type: Minstekrav | Vekt: 10 %" }];
  const chapter = `4 Krav\nK-4 ${source[0].text}\n\n9 Rettelser\n`;
  for (const request of ["Leverandøren ønsker at K-4 utgår.", "Vi ønsker å endre K-4 til: «Leverandøren skal levere rapporter.»"]) {
    assert.equal(applyRequirementCorrections(source, chapter + request).ledger[0].text, source[0].text);
  }
  const second = { ...source[0], id: "K-2", text: "Leverandøren skal levere døgnvakt." };
  assert.deepEqual(applyRequirementCorrections([...source, second], chapter + "K-4 utgår. Leverandøren ønsker at K-2 utgår.").ledger.map((entry) => entry.id), ["K-2"]);
  const changed = applyRequirementCorrections(source, chapter + "Svar: K-4 gjelder hele døgnet.\nK-4 endres til: «Leverandøren skal levere en årlig driftsplan.»").ledger[0];
  assert.match(changed.sourceExcerpt, /Ark Krav, Rad 8 \| Type: Minstekrav \| Vekt: 10 %/u);
  assert.match(changed.sourceExcerpt, /gjelder hele døgnet/u);
  assert.match(changed.sourceExcerpt, /Opprinnelig tekst/u);
});

test("bidder request context spans sentences and wrapped IDs but ends at separate correction blocks", async () => {
  const source = ["K-1", "K-2", "K-4"].map((id) => ({ id, text: `Leverandøren skal dokumentere ${id}.`, pages: [1], heading: "4 Krav" }));
  const chapter = `4 Krav\n${source.map((entry) => `${entry.id} ${entry.text}`).join("\n")}\n\n9 Rettelser\n`;
  const requests = [
    "Spørsmål: Vi ber om følgende endring. K-4 utgår. Kan dette aksepteres?",
    "Spørsmål: Vi ber om følgende endring.\nK-4 utgår.\nKan dette aksepteres?",
    "Vi foreslår at kravene endres. K-4 får ny ID K-9. Nytt krav K-8 legges til: «Leverandøren skal levere rapporter.»",
    "Spørsmål: Vi ber om følgende endring. K-4 endres til: «Leverandøren skal levere rapporter.»",
  ];
  for (const request of requests) {
    const raw = chapter + request;
    assert.deepEqual(applyRequirementCorrections(source, raw).ledger, source, request);
    assert.deepEqual(correctedRequirementIds(source.map((entry) => entry.id), raw), ["K-1", "K-2", "K-4"], request);
    for (const separate of ["\n\nK-2 utgår.", "\n- K-2 utgår.", "\n| K-2 | Utgår |", "\nRad 2: K-2 | Utgår"]) {
      const mixed = chapter + "K-1 utgår. " + request + separate;
      assert.deepEqual(applyRequirementCorrections(source, mixed).ledger.map((entry) => entry.id), ["K-4"], mixed);
      assert.deepEqual(correctedRequirementIds(source.map((entry) => entry.id), mixed), ["K-4"], mixed);
    }
  }
  // A closed question does not suppress a following affirmative correction.
  assert.deepEqual(applyRequirementCorrections(source, chapter + requests[0] + " K-2 utgår.").ledger.map((entry) => entry.id), ["K-1", "K-4"]);
  const { extractRequirementLedgerWithCorrections } = await load("lib/server/requirements/source-ledger.ts");
  const document = { id: "d", title: "Krav", role: "supporting_document", supporting_subtype: "kravdokument", file_format: "docx", structure_map: [],
    raw_text: `4 Krav\n| Krav-ID | Kravtekst |\n| K-4 | Leverandøren skal levere en driftsplan. |\n\n9 Rettelser\n${requests[1]}` };
  const result = await extractRequirementLedgerWithCorrections(document);
  assert.deepEqual(result.ledger.map((entry) => entry.id), ["K-4"]);
  assert.doesNotThrow(() => assertExplicitRequirementLedgersComplete([document], [{ document, ...result }]));
});

test("a withdrawn formal requirement cannot survive through its customer-document duplicate", async () => {
  const { extractRequirementLedgerWithCorrections } = await load("lib/server/requirements/source-ledger.ts");
  const { canonicalizeRequirementSourceLedger } = await load("lib/server/requirements/source-readiness.ts");
  const { buildRequirementCoverageLedgerFromDocuments } = await load("lib/server/ai/requirement-coverage.ts");
  const common = { title: "Krav", file_format: "docx", structure_map: [] };
  const customer = { ...common, id: "customer", role: "primary_customer_document", raw_text: "4 Krav\n| Krav-ID | Kravtekst |\n| K-1 | Leverandøren skal levere en driftsplan. |\n| K-2 | Leverandøren skal levere en exitplan. |" };
  const formal = { ...common, id: "formal", role: "supporting_document", supporting_subtype: "kravdokument", raw_text: "4 Krav\n| Krav-ID | Kravtekst |\n| K-1 | Leverandøren skal levere en driftsplan. |\n| K-3 | Leverandøren skal levere døgnvakt. |\n\n9 Rettelser\nK-1 utgår." };
  const documents = [customer, formal];
  const results = await Promise.all(documents.map(async (document) => ({ document, ...await extractRequirementLedgerWithCorrections(document) })));
  assert.deepEqual(canonicalizeRequirementSourceLedger({ sourceDocuments: documents, requirementLedgerResults: results }).map((entry) => entry.id), ["K-2", "K-3"]);
  assert.deepEqual((await buildRequirementCoverageLedgerFromDocuments(documents)).map((entry) => entry.id), ["K-2", "K-3"]);
  const { buildEvaluationLedgerContext } = await load("lib/server/use-cases/project-workflows.ts");
  const bundle = await buildEvaluationLedgerContext({ artifactType: "forbedret_kravsvar", documents });
  assert.deepEqual(canonicalizeRequirementSourceLedger({ sourceDocuments: documents, requirementLedgerResults: bundle.requirementLedgerResults }).map((entry) => entry.id), ["K-2", "K-3"]);
  // Equal IDs with different obligations remain distinct.
  customer.raw_text = customer.raw_text.replace("levere en driftsplan", "kryptere alle kundedata");
  assert.ok((await buildRequirementCoverageLedgerFromDocuments(documents)).some((entry) => entry.id === "K-1"));
});

test("a withdrawal cannot silently remove distinct source rows that share an ID", async () => {
  const source = [
    { id: "K-1", text: "Leverandøren skal levere en driftsplan.", pages: [1], heading: "4 Drift" },
    { id: "K-1", text: "Leverandøren skal kryptere kundedata.", pages: [2], heading: "5 Sikkerhet" },
    { id: "K-2", text: "Leverandøren skal levere rapporter.", pages: [2], heading: "5 Sikkerhet" },
  ];
  const chapter = source.map((entry) => `${entry.heading}\n${entry.id}: ${entry.text}`).join("\n\n");
  const original = structuredClone(source);
  const error = /K-1.*flere krav/u;
  for (const correction of ["K-1 (Drift) utgår.", "K-1 utgår.", "Som følge av endringen i K-2 utgår K-1.",
    "K-1 endres til: «Leverandøren skal kryptere alle data.»", "K-1 får ny ID K-9."]) {
    const raw = `${chapter}\n\n9 Rettelser\n${correction}`;
    assert.throws(() => applyRequirementCorrections(source, raw), error);
    assert.throws(() => correctedRequirementIds(source.map((entry) => entry.id), raw), error);
  }
  assert.deepEqual(applyRequirementCorrections(source, `${chapter}\n\n9 Rettelser\nK-1 utgår ikke.`).ledger.map(({ id, text }) => ({ id, text })), source.map(({ id, text }) => ({ id, text })));
  assert.deepEqual(applyRequirementCorrections(source, `${chapter}\n\n9 Rettelser\nSpørsmål: Vi ber om følgende endring. K-1 utgår. Kan dette godtas?`).ledger, source);
  assert.deepEqual(applyRequirementCorrections([source[0], source[2]], `${chapter}\n\n9 Rettelser\nK-1 (Drift) utgår.`).ledger.map((entry) => entry.id), ["K-2"]);
  const threeOccurrences = [...source.slice(0, 2), { ...source[2], id: "K-1" }];
  const renumbered = applyRequirementCorrections(threeOccurrences, `${chapter}\n\n9 Rettelser\nK-1 er brukt flere ganger. Det andre kravet får ny ID K-9.`).ledger;
  assert.deepEqual(renumbered.map((entry) => entry.id), ["K-1", "K-9", "K-1"]);
  assert.equal(renumbered[1].text, source[1].text);
  const document = { id: "formal", title: "Krav", role: "supporting_document", supporting_subtype: "kravdokument", file_format: "pdf",
    raw_text: `${chapter}\n\n9 Rettelser\nK-1 (Drift) utgår.`,
    structure_map: source.map((entry, index) => ({ kind: "docling_text", parser: "docling", reference: `Docling text ${index}`, text: `${entry.id}: ${entry.text}`, page: entry.pages[0], heading_path: [entry.heading] })),
  };
  const { extractRequirementLedgerWithCorrections } = await load("lib/server/requirements/source-ledger.ts");
  const { buildRequirementCoverageLedgerFromDocuments } = await load("lib/server/ai/requirement-coverage.ts");
  const { workflowErrorStatus } = await load("lib/server/workflow-errors.ts");
  await assert.rejects(extractRequirementLedgerWithCorrections(document), (failure) => {
    assert.match(failure.message, error);
    assert.equal(workflowErrorStatus(failure), 422);
    return true;
  });
  await assert.rejects(buildRequirementCoverageLedgerFromDocuments([document]), error);
  assert.throws(() => assertExplicitRequirementLedgersComplete([document], [{ document, ledger: [] }]), /Kravledgeren er tom|flere krav/u);
  const onlyRepeatedRows = { ...document, raw_text: `${source.slice(0, 2).map((entry) => `${entry.heading}\n${entry.id}: ${entry.text}`).join("\n\n")}\n\n9 Rettelser\nK-1 (Drift) utgår.`, structure_map: document.structure_map.slice(0, 2) };
  const { originalRequirementSourceIds, allRequirementsWithdrawn } = await load("lib/server/requirements/source-readiness.ts");
  assert.deepEqual(originalRequirementSourceIds(onlyRepeatedRows), ["K-1", "K-1"]);
  assert.throws(() => allRequirementsWithdrawn(onlyRepeatedRows), error);
  assert.throws(() => assertExplicitRequirementLedgersComplete([onlyRepeatedRows], [{ document: onlyRepeatedRows, ledger: [] }]), error);
  assert.deepEqual(source, original, "failed correction leaves the source rows intact");
});

test("evaluation returns empty coverage when every original requirement is withdrawn", async () => {
  const { buildSolutionRequirementCoverage } = await load("lib/server/ai.ts");
  const source = { id: "formal", title: "Krav", role: "supporting_document", supporting_subtype: "kravdokument", file_format: "docx", structure_map: [], raw_text: "4 Krav\n| Krav-ID | Kravtekst |\n| K-1 | Leverandøren skal levere en driftsplan. |\n\n9 Rettelser\nK-1 utgår." };
  const coverage = await buildSolutionRequirementCoverage({ projectName: "Test", customerAnalysis: null,
    requirementDocuments: [source, { ...source, id: "customer", role: "primary_customer_document", raw_text: "Kunden trenger en sikker og moderne skyplattform." }], sourceRequirementLedger: [],
    solutionDocument: { ...source, id: "solution", role: "primary_solution_document", raw_text: "K-1 Leverandøren leverer en driftsplan." },
    solutionRequirementLedger: [{ id: "K-1", text: "Leverandøren leverer en driftsplan.", pages: [1], heading: "4 Krav" }],
  });
  assert.deepEqual(coverage.items, []);
  assert.match(coverage.coverage_summary, /trukket tilbake/u);
  const duplicate = { ...source, id: "customer", role: "primary_customer_document", supporting_subtype: null,
    raw_text: "4 Krav\n| Krav-ID | Kravtekst |\n| K-1 | Leverandøren skal levere en driftsplan. |" };
  const repeated = await buildSolutionRequirementCoverage({ projectName: "Test", customerAnalysis: null,
    requirementDocuments: [source, duplicate], sourceRequirementLedger: [],
    solutionDocument: { ...source, id: "solution", role: "primary_solution_document", raw_text: "K-1 Leverandøren leverer en driftsplan." },
    solutionRequirementLedger: [{ id: "K-1", text: "Leverandøren leverer en driftsplan.", pages: [1], heading: "4 Krav" }],
  });
  assert.deepEqual(repeated.items, []);
  assert.match(repeated.coverage_summary, /trukket tilbake/u);
});

test("withdrawing every explicit ID does not prove unnumbered requirements were withdrawn", async () => {
  const document = { id: "formal", title: "Krav", role: "supporting_document", supporting_subtype: "kravdokument", file_format: "pdf", structure_map: [],
    raw_text: ["Bilag 2 - Kravspesifikasjon", "Prosjektkode: P057", "Krav registrert i tabell", "ID/markering Prioritet Kravtekst Leverandørens svar",
      "Leverandøren skal kryptere kundedata under overføring.", "K-1 Må Leverandøren skal levere en driftsplan.", "", "9 Rettelser", "K-1 utgår."].join("\n") };
  const { allRequirementsWithdrawn } = await load("lib/server/requirements/source-readiness.ts");
  assert.equal(allRequirementsWithdrawn(document), false);
  assert.throws(() => assertExplicitRequirementLedgersComplete([document], [{ document, ledger: [] }]), /Kravledgeren er tom/u);
  const { buildRequirementCoverageLedgerFromDocuments } = await load("lib/server/ai/requirement-coverage.ts");
  await assert.rejects(buildRequirementCoverageLedgerFromDocuments([document]), /ingen krav kunne ekstraheres/u);
});

test("a withdrawn Docling paragraph includes its anchored obligation continuations", async () => {
  const paragraph = "KRAV-01: Leverandøren skal logge hendelser.\nLoggene skal bevares i 14 måneder.";
  const document = { id: "formal", title: "Krav", role: "supporting_document", supporting_subtype: "kravdokument", file_format: "pdf",
    raw_text: `4 Krav\n${paragraph}\n\n9 Rettelser\nKRAV-01 utgår.`,
    structure_map: [{ kind: "docling_text", parser: "docling", reference: "Docling text 1", text: paragraph, page: 1 }],
  };
  const { allRequirementsWithdrawn } = await load("lib/server/requirements/source-readiness.ts");
  const { extractRequirementLedgerWithCorrections } = await load("lib/server/requirements/source-ledger.ts");
  const { buildRequirementCoverageLedgerFromDocuments } = await load("lib/server/ai/requirement-coverage.ts");
  const result = await extractRequirementLedgerWithCorrections(document);
  assert.deepEqual(result.ledger, []);
  assert.equal(result.originalLedger.length, 1);
  assert.match(result.originalLedger[0].text, /Loggene skal bevares i 14 måneder/u);
  assert.equal(allRequirementsWithdrawn(document), true);
  assert.doesNotThrow(() => assertExplicitRequirementLedgersComplete([document], [{ document, ...result }]));
  assert.deepEqual(await buildRequirementCoverageLedgerFromDocuments([document]), []);
  const { buildSolutionRequirementCoverage } = await load("lib/server/ai.ts");
  const coverage = await buildSolutionRequirementCoverage({ projectName: "Test", customerAnalysis: null,
    requirementDocuments: [document], sourceRequirementLedger: [],
    solutionDocument: { ...document, id: "solution", role: "primary_solution_document", raw_text: "KRAV-01 Leverandøren logger hendelser." },
    solutionRequirementLedger: [{ id: "KRAV-01", text: "Leverandøren logger hendelser.", pages: [1], heading: "4 Krav" }],
  });
  assert.deepEqual(coverage.items, []);
  // The same obligation in a separate paragraph or outside its source anchor
  // is not proof of a continuation belonging to the withdrawn requirement.
  const separate = { ...document, structure_map: [{ ...document.structure_map[0], text: paragraph.split("\n")[0] },
    { ...document.structure_map[0], reference: "Docling text 2", text: paragraph.split("\n")[1] }] };
  assert.equal(allRequirementsWithdrawn(separate), false);
  assert.equal(allRequirementsWithdrawn({ ...document, raw_text: document.raw_text.replace("\n\n9 Rettelser", "\n\nLoggene skal bevares i 14 måneder.\n\n9 Rettelser") }), false);
});

test("review bots: several correction notices, kept notes, Unicode section rows, withdrawn documents", async () => {
  const k = (id, text) => ({ id, text, pages: [1], heading: "4 Krav" });
  // Rettelse nr. 1 and nr. 2 both apply, in order; a table of contents does not.
  const ledger = [k("K-1", "Leverandøren skal levere månedlig rapport."), k("K-2", "Leverandøren skal tilby døgnvakt."), k("K-3", "Leverandøren skal ha ISO 27001.")];
  const chapter = ledger.map((entry) => `${entry.id} ${entry.text}`).join("\n");
  const raw = `Innhold\nRettelse nr. 1\nRettelse nr. 2\n4 Krav\n${chapter}\n\nRettelse nr. 1\nK-1 utgår.\n\nRettelse nr. 2\nK-2 utgår.`;
  assert.deepEqual(applyRequirementCorrections(ledger, raw).ledger.map((entry) => entry.id), ["K-3"]);
  // An unplaced change keeps its note when another correction in the same statement applies.
  const ops = [k("OPS-1", "Responstid skal være høyst 60 minutter."), k("OPS-2", "Leverandøren skal tilby døgnvakt.")];
  const mixed = applyRequirementCorrections(ops, "8 Rettelser\nOPS-2 utgår. OPS-1 endres til: «30 minutter».").ledger;
  assert.deepEqual(mixed.map((entry) => entry.id), ["OPS-1"]);
  assert.match(mixed[0].sourceExcerpt ?? "", /30 minutter/u);
  // A chapter with only a scope clarification keeps it as a note.
  const scoped = applyRequirementCorrections(ops, "8 Rettelser\nOPS-1 gjelder kun produksjonsmiljøet.").ledger;
  assert.match(scoped[0].sourceExcerpt ?? "", /gjelder kun produksjonsmiljøet/u);
  // A numbered parent row stating an obligation with "må" is a requirement.
  const matrix = { file_format: "xlsx", raw_text: ["Ark: Krav", "Rad 1: A1: Nr | B1: Kravtekst", "Rad 2: A2: 1 | B2: Løsningen må støtte norsk.", "Rad 3: A3: 1.1 | B3: Brukergrensesnittet skal være på norsk."].join("\n") };
  assert.deepEqual(buildSpreadsheetRequirementLedger(matrix).map((entry) => entry.id), ["1", "1.1"]);
  // A supporting requirement document whose requirements are all withdrawn is not an empty-ledger failure.
  const supporting = { id: "s", title: "Tilleggskrav", role: "supporting_document", supporting_subtype: "kravdokument", file_name: "tilleggskrav.docx", file_format: "docx", raw_text: "4 Krav\nK-1 Leverandøren skal levere kursing.\nK-2 Leverandøren skal levere dokumentasjon.\n\n9 Rettelser\nKravene K-1 og K-2 utgår." };
  assert.doesNotThrow(() => assertExplicitRequirementLedgersComplete([supporting], [{ document: supporting, ledger: [] }]));
});
