import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const jiti = createJiti(path.join(frontendRoot, "hierarchical-ids-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const load = (file) => jiti.import(path.join(frontendRoot, file));
const { buildHierarchicalIdPdfRequirementLedger, buildHierarchicalIdTextRequirementLedger } = await load("lib/server/requirements/hierarchical-id-parser.ts");
const { detectExplicitRequirementIds, detectRequirementIds } = await load("lib/server/requirements/id-detection.ts");
const { normalizePdfReferenceTypography, normalizePdfSpacing } = await load("lib/server/requirements/pdf-normalization.ts");
const { applyRequirementCorrections } = await load("lib/server/requirements/corrections.ts");

// One layout line: [x, text] runs at height y; widths approximate 5 pt per character.
const line = (y, ...runs) => ({
  y,
  text: runs.map(([, text]) => text).join(" "),
  items: runs.map(([x, text]) => ({ str: text, x, y, width: text.length * 5 })),
});
const footer = (page) => line(30, [63, `Hålandsvik kommune · Bilag 1 Kravspesifikasjon Side ${page}`]);

const pages = [
  {
    page: 1,
    lines: [
      line(760, [63, "2 Generelle krav"]),
      line(740, [63, "K-2.1"], [90, "Leverandøren skal ha et styringssystem som er sertifisert etter ISO/IEC"]),
      line(726.6, [63, "27001:2022."]),
      line(707, [63, "K-2.2"], [90, "Leverandøren bør ha minst tre referanser."]),
      line(679, [63, "3 Plattform"]),
      line(660, [63, "Kravene i kapittel 3 står i én tabell."]),
      line(640, [63, "Tabell 3-1 Krav til plattform"]),
      line(620, [68, "Krav-ID"], [130, "Type"], [192, "Kravtekst"]),
      line(600, [68, "K-3.1.1"], [130, "Minstekrav"], [192, "Alle kundedata skal lagres i datasentre med minst"]),
      line(588.6, [192, "10 Gbit/s mellom lokasjonene"]),
      line(577.2, [192, "innenfor EØS."]),
      line(569, [68, "K-3.1.2"], [130, "Evalueres"], [192, "Plattformen bør drives med fornybar energi."]),
      line(549, [68, "K-3.1.3"], [130, "Minstekrav"], [192, "Personell skal ha levert politiattest som ikke"]),
      footer(1),
    ],
  },
  {
    page: 2,
    lines: [
      line(767, [68, "Krav-ID"], [130, "Type"], [192, "Kravtekst"]),
      line(748, [192, "er eldre enn tre måneder."]),
      line(728, [68, "K-3.3.1"], [130, "Minstekrav"], [192, "Driftssenteret skal ligge"]),
      line(716.6, [192, "innenfor EØS."]),
      line(690, [63, "4 Drift"]),
      line(670, [63, "Bakgrunn"]),
      line(650, [63, "Under den forrige avtalen skulle sikkerhetskopier tas ut på bånd hver fredag."]),
      line(626, [63, "K-6.1"], [90, "Leverandøren skal levere en exitplan som minst omfatter:"]),
      line(607, [68, "a) eksport av alle data,"]),
      line(588, [68, "b) tidsplan for tilbakeføring."]),
      line(569, [63, "K-6.2"], [90, "Leverandøren bør migrere uten nedetid."]),
      footer(2),
    ],
  },
];

test("hierarchical IDs keep one row each across prose, a type column, page breaks and lists", () => {
  const ledger = buildHierarchicalIdPdfRequirementLedger(pages);
  assert.deepEqual(
    ledger.map((entry) => [entry.id, entry.text, entry.pages]),
    [
      ["K-2.1", "Leverandøren skal ha et styringssystem som er sertifisert etter ISO/IEC 27001:2022.", [1]],
      ["K-2.2", "Leverandøren bør ha minst tre referanser.", [1]],
      ["K-3.1.1", "Alle kundedata skal lagres i datasentre med minst 10 Gbit/s mellom lokasjonene innenfor EØS.", [1]],
      ["K-3.1.2", "Plattformen bør drives med fornybar energi.", [1]],
      ["K-3.1.3", "Personell skal ha levert politiattest som ikke er eldre enn tre måneder.", [1, 2]],
      // A short line repeated on two pages is body text, not page chrome.
      ["K-3.3.1", "Driftssenteret skal ligge innenfor EØS.", [2]],
      ["K-6.1", "Leverandøren skal levere en exitplan som minst omfatter: a) eksport av alle data, b) tidsplan for tilbakeføring.", [2]],
      ["K-6.2", "Leverandøren bør migrere uten nedetid.", [2]],
    ],
  );
  assert.equal(ledger[2].tableId, "Tabell 3-1 Krav til plattform");
  assert.match(ledger[2].sourceExcerpt, /^K-3\.1\.1 Minstekrav /u);
});

test("other numbering is left to the existing parsers", () => {
  const fewIds = [{ page: 1, lines: pages[0].lines.slice(0, 4) }];
  assert.deepEqual(buildHierarchicalIdPdfRequirementLedger(fewIds), []);
  const repeated = [pages[0], { page: 2, lines: [line(700, [63, "K-2.1"], [90, "Leverandøren skal ha et styringssystem."])] }];
  assert.deepEqual(buildHierarchicalIdPdfRequirementLedger(repeated), []);
});

test("ID detection reads every level of a hierarchical ID", () => {
  assert.deepEqual(detectExplicitRequirementIds("K-3.1.1 Alle kundedata skal lagres i EØS."), ["K-3.1.1"]);
  assert.deepEqual(detectRequirementIds("Krav K-4.1.2 i Bilag 1 endres."), ["K-4.1.2"]);
  // A sentence ending before a section number is not a dotted ID.
  assert.deepEqual(detectExplicitRequirementIds("Tilbud etter fristen vil bli avvist. 5.2 Forhandlinger"), []);
  assert.deepEqual(detectExplicitRequirementIds("FRF.1.2 Systemet skal logge."), ["FRF.1.2"]);
});

test("PDF spacing repair leaves Norwegian words as written", () => {
  assert.equal(normalizePdfSpacing("bemannet 24 timer i døgnet"), "bemannet 24 timer i døgnet");
  assert.equal(normalizePdfSpacing("en del av leveransen"), "en del av leveransen");
  assert.equal(normalizePdfSpacing("Tabell I D 2-14"), "Tabell ID 2-14");
  assert.equal(normalizePdfReferenceTypography("Tilbudsfristen i punkt 5.1 endres."), "Tilbudsfristen i punkt 5.1 endres.");
  assert.equal(normalizePdfReferenceTypography("Kravet gjelder å levere drift."), "Kravet gjelder å levere drift.");
});

test("a correction names a three-level requirement by its whole ID", () => {
  const ledger = [
    { id: "K-4.1", text: "Leverandøren skal rapportere månedlig.", pages: [1], heading: "4.1" },
    { id: "K-4.1.2", text: "Leverandøren skal gjenopprette innen 8 timer.", pages: [1], heading: "4.1" },
  ];
  const rawText = [
    "9 Rettelser og presiseringer",
    "1. Krav K-4.1.2 i Bilag 1 endres og skal nå lyde: «Leverandøren skal gjenopprette innen 4 timer.»",
  ].join("\n");
  const corrected = applyRequirementCorrections(ledger, rawText).ledger;
  assert.deepEqual(
    corrected.map((entry) => [entry.id, entry.text]),
    [
      ["K-4.1", "Leverandøren skal rapportere månedlig."],
      ["K-4.1.2", "Leverandøren skal gjenopprette innen 4 timer."],
    ],
  );
});

test("requirements at the top or bottom of pages are never page chrome", () => {
  const row = (y, id) => line(y, [63, id], [90, `Leverandøren skal dokumentere kontroll ${id.slice(-1)} hver måned.`]);
  const chromePages = [1, 2, 3].map((page) => ({
    page,
    lines: [
      row(760, `K-${page}.1`),
      row(740, `K-${page}.2`),
      row(720, `K-${page}.3`),
      footer(page),
    ],
  }));
  assert.deepEqual(
    buildHierarchicalIdPdfRequirementLedger(chromePages).map((entry) => entry.id),
    ["K-1.1", "K-1.2", "K-1.3", "K-2.1", "K-2.2", "K-2.3", "K-3.1", "K-3.2", "K-3.3"],
  );
});

test("a further paragraph with an obligation stays with its requirement, also after a page break", () => {
  const ids = ["K-1.1", "K-1.2", "K-1.3", "K-1.4", "K-1.5"];
  const ledger = buildHierarchicalIdPdfRequirementLedger([
    {
      page: 1,
      lines: [
        // Wrapped lines sit 13 pt apart; separate paragraphs and headings further.
        ...ids.map((id, index) => line(760 - index * 13, [63, id], [90, `Leverandøren skal levere tjeneste ${index + 1}.`])),
        line(694, [63, "K-1.6"], [90, "Leverandøren skal utarbeide en beredskapsplan."]),
        line(681, [63, "Den skal dekke alle"]),
        line(668, [63, "kritiske fagsystemer."]),
        line(645, [63, "Planen skal godkjennes av kommunen før oppstart."]),
        footer(1),
      ],
    },
    { page: 2, lines: [line(760, [63, "Planen skal oppdateres årlig."]), line(735, [63, "Bakgrunn"]), line(715, [63, "Kommunen hadde tidligere en annen ordning."]), footer(2)] },
  ]);
  assert.equal(
    ledger.at(-1).text,
    "Leverandøren skal utarbeide en beredskapsplan. Den skal dekke alle kritiske fagsystemer. Planen skal godkjennes av kommunen før oppstart. Planen skal oppdateres årlig.",
  );
  assert.deepEqual(ledger.at(-1).pages, [1, 2]);
});

test("mixed numbering is left to the existing parsers", () => {
  const mixed = [{ ...pages[0], lines: [...pages[0].lines.slice(0, -1), line(530, [63, "K-7"], [90, "Leverandøren skal levere opplæring."]), footer(1)] }, pages[1]];
  assert.deepEqual(buildHierarchicalIdPdfRequirementLedger(mixed), []);
});

test("a DOCX or text register keeps one row per hierarchical ID", () => {
  const raw_text = [
    "2 Generelle krav",
    "K-2.1 Leverandøren skal ha et styringssystem for informasjonssikkerhet.",
    "K-2.2 Leverandøren bør ha minst tre referanser.",
    "3 Plattform",
    "K-3.1.1 Alle kundedata skal lagres innenfor EØS.",
    "K-3.1.2: Plattformen skal driftes fra to datasentre.",
    "- K-3.1.3 Leverandøren bør tilby lagring i Norge.",
    "**K-3.2.1** Leverandøren skal etablere kryptert forbindelse.",
    "Forbindelsen skal overvåkes døgnet rundt.",
    "Bakgrunn",
    "Kommunen hadde tidligere egne servere.",
  ].join("\n");
  assert.deepEqual(
    buildHierarchicalIdTextRequirementLedger({ file_format: "docx", raw_text }).map((entry) => [entry.id, entry.text, entry.heading]),
    [
      ["K-2.1", "Leverandøren skal ha et styringssystem for informasjonssikkerhet.", "2 Generelle krav"],
      ["K-2.2", "Leverandøren bør ha minst tre referanser.", "2 Generelle krav"],
      ["K-3.1.1", "Alle kundedata skal lagres innenfor EØS.", "3 Plattform"],
      ["K-3.1.2", "Plattformen skal driftes fra to datasentre.", "3 Plattform"],
      ["K-3.1.3", "Leverandøren bør tilby lagring i Norge.", "3 Plattform"],
      ["K-3.2.1", "Leverandøren skal etablere kryptert forbindelse. Forbindelsen skal overvåkes døgnet rundt.", "3 Plattform"],
    ],
  );
  assert.deepEqual(buildHierarchicalIdTextRequirementLedger({ file_format: "pdf", raw_text }), []);
});

test("a register's own corrections chapter, soft line breaks and type labels keep one row per ID", () => {
  const register = (extra) => [
    "3 Plattform",
    "K-3.1.1 Minstekrav Alle data skal lagres i",
    "Norge uten tillegg i pris.",
    "K-3.1.2 Evalueres Leverandøren bør tilby to datasentre.",
    "K-3.1.3 Leverandøren skal levere drift.",
    "K-3.1.4 Leverandøren skal levere støtte.",
    "K-3.1.5 Leverandøren skal levere opplæring.",
    "K-3.1.6 Leverandøren skal levere rapporter.",
    ...extra,
  ].join("\n");
  const withCorrections = register([
    "9 Rettelser",
    "K-3.1.2 endres og skal nå lyde: «Leverandøren skal tilby to datasentre.»",
    "K-3.1.3 utgår.",
  ]);
  const ledger = buildHierarchicalIdTextRequirementLedger({ file_format: "docx", raw_text: withCorrections });
  assert.deepEqual(ledger.map((entry) => entry.id), ["K-3.1.1", "K-3.1.2", "K-3.1.3", "K-3.1.4", "K-3.1.5", "K-3.1.6"]);
  assert.equal(ledger[0].text, "Alle data skal lagres i Norge uten tillegg i pris.");
  assert.equal(ledger[1].text, "Leverandøren bør tilby to datasentre.");
  assert.match(ledger[1].sourceExcerpt, /^K-3\.1\.2 Evalueres /u);
  // A requirement numbered in another series is not something this parser
  // can represent, so the register stays with the existing parsers.
  assert.deepEqual(
    buildHierarchicalIdTextRequirementLedger({ file_format: "txt", raw_text: register(["R-7 Leverandøren skal levere opplæring."]) }),
    [],
  );
  assert.equal(
    buildHierarchicalIdTextRequirementLedger({ file_format: "txt", raw_text: register(["NS-3451 Bygningsdeltabell gjelder for dokumentasjonen."]) }).length,
    6,
  );
});

test("an unmarked heading after a requirement without a full stop starts a new section", () => {
  const raw_text = [
    "Plattform",
    "K-3.1.1 Alle data skal lagres innenfor EØS",
    "K-3.1.2 Plattformen skal driftes fra to datasentre",
    "Sikkerhet",
    "K-3.2.1 Leverandøren skal bruke flerfaktorautentisering",
    "K-3.2.2 Leverandøren bør tilby IPv6",
    "Beredskap og gjenoppretting",
    "K-3.3.1 Leverandøren skal gjenopprette innen 4 timer",
    "K-3.3.2 Leverandøren skal øve årlig",
  ].join("\n");
  const sections = buildHierarchicalIdTextRequirementLedger({ file_format: "docx", raw_text });
  assert.deepEqual(sections.map((entry) => entry.heading), ["Plattform", "Plattform", "Sikkerhet", "Sikkerhet", "Beredskap og gjenoppretting", "Beredskap og gjenoppretting"]);
  assert.deepEqual(
    sections.map((entry) => [entry.id, entry.text]),
    [
      ["K-3.1.1", "Alle data skal lagres innenfor EØS"],
      ["K-3.1.2", "Plattformen skal driftes fra to datasentre"],
      ["K-3.2.1", "Leverandøren skal bruke flerfaktorautentisering"],
      ["K-3.2.2", "Leverandøren bør tilby IPv6"],
      ["K-3.3.1", "Leverandøren skal gjenopprette innen 4 timer"],
      ["K-3.3.2", "Leverandøren skal øve årlig"],
    ],
  );
});

test("wrapped text lines that start with a capital stay with their requirement", () => {
  const raw_text = [
    "K-1.1 Leverandøren skal være sertifisert etter",
    "ISO/IEC 27001:2022",
    "Gyldig sertifikat skal legges ved tilbudet.",
    "K-1.2 Leverandøren skal stille med tekniker på",
    "Hålandsvik rådhus innen 4 timer ved kritiske",
    "hendelser, hele døgnet.",
    "K-1.3 Alle data skal lagres i",
    "Norge uten tillegg i pris",
    "K-1.4 Løsningen skal støtte",
    "Microsoft Entra ID og SAML",
    "for alle brukere.",
    "K-1.5 Leverandøren skal levere drift.",
    "K-1.6 Leverandøren skal levere støtte.",
  ].join("\n");
  assert.deepEqual(
    buildHierarchicalIdTextRequirementLedger({ file_format: "txt", raw_text }).map((entry) => [entry.id, entry.text]),
    [
      ["K-1.1", "Leverandøren skal være sertifisert etter ISO/IEC 27001:2022 Gyldig sertifikat skal legges ved tilbudet."],
      ["K-1.2", "Leverandøren skal stille med tekniker på Hålandsvik rådhus innen 4 timer ved kritiske hendelser, hele døgnet."],
      ["K-1.3", "Alle data skal lagres i Norge uten tillegg i pris"],
      ["K-1.4", "Løsningen skal støtte Microsoft Entra ID og SAML for alle brukere."],
      ["K-1.5", "Leverandøren skal levere drift."],
      ["K-1.6", "Leverandøren skal levere støtte."],
    ],
  );
});
