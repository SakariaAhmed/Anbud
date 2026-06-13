#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  fixtureSearchRoots,
  resolveExistingExplicitFilePath,
  resolveExistingFixturePath,
  resolveFixturePathInRoot,
} from "./fixture_paths.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");

const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const xlsx = require(path.join(frontendRoot, "node_modules", "@e965", "xlsx"));

const jiti = createJiti(path.join(frontendRoot, "requirement-harness.cjs"), {
  moduleCache: false,
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  extractTextFromBuffer,
  contentTypeForUploadFormat,
  inferUploadFileFormat,
} = jiti(path.join(frontendRoot, "lib", "server", "documents.ts"));
const { extractRequirementLedgerForDocument } = jiti(
  path.join(frontendRoot, "lib", "server", "ai.ts"),
);

// Verification-only oracle. These counts are never imported by app code or sent to model prompts.
// External corpus files are optional by default; set REQUIREMENT_VERIFY_FIXTURE_ROOT to run them portably.
const OPTIONAL_REQUIREMENT_FIXTURES = [
  [
    "sky_bilag_5_par_ny/01_Bilag_2_Krav_Nordlys_Logistikk_AS.docx",
    56,
  ],
  [
    "sky_bilag_5_par_ny/02_Bilag_2_Krav_HelseBro_Klinikkdrift_AS.docx",
    64,
  ],
  [
    "sky_bilag_5_par_ny/03_Bilag_2_Krav_Gr_nnFjord_Energi_SA.docx",
    73,
  ],
  [
    "sky_bilag_5_par_ny/04_Bilag_2_Krav_KulturHub_stlandet_IKS.docx",
    82,
  ],
  [
    "sky_bilag_5_par_ny/05_Bilag_2_Krav_TryggVakt_Bemanning_AS.docx",
    88,
  ],
  [
    "sky_bilag_5_par_pdf/06_Bilag_2_Krav_FjellData_Kommuneplattform_AS.pdf",
    57,
  ],
  [
    "sky_bilag_5_par_pdf/07_Bilag_2_Krav_Havblikk_Seafood_Export_AS.pdf",
    66,
  ],
  [
    "sky_bilag_5_par_pdf/08_Bilag_2_Krav_UrbanMobil_Drift_AS.pdf",
    74,
  ],
  [
    "sky_bilag_5_par_pdf/09_Bilag_2_Krav_LaeringsLoeftet_Akademi_AS.pdf",
    81,
  ],
  [
    "sky_bilag_5_par_pdf/10_Bilag_2_Krav_ByggKontroll_Prosjektpartner_AS.pdf",
    88,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/DOCX/11_Bilag_2_Krav_PolarNett_Feltservice_AS.docx",
    58,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/DOCX/12_Bilag_2_Krav_Matrett_Direkte_AS.docx",
    63,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/DOCX/13_Bilag_2_Krav_ArenaPulse_Eventdrift_AS.docx",
    71,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/DOCX/14_Bilag_2_Krav_TreLinje_Modulbygg_AS.docx",
    79,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/DOCX/15_Bilag_2_Krav_OmsorgLink_Hjemmetjeneste_KF.docx",
    87,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/PDF/16_Bilag_2_Krav_FjordByte_Regnskap_AS.pdf",
    55,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/PDF/17_Bilag_2_Krav_NordVask_Industrirens_AS.pdf",
    62,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/PDF/18_Bilag_2_Krav_BySykkel_Verksteddrift_AS.pdf",
    70,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/PDF/19_Bilag_2_Krav_SkoleMat_Pluss_SA.pdf",
    78,
  ],
  [
    "sky_10_unike_ustrukturerte_prosjekter/PDF/20_Bilag_2_Krav_HavnKontroll_Terminaldrift_IKS.pdf",
    86,
  ],
];

const STRICT_FASIT_RELATIVE_PATH = "Fasit_Bilag2_gjenoppbygd.xlsx";
const STRICT_FASIT_RELATIVE_ROOTS = [
  "sky_10_unike_ustrukturerte_prosjekter/DOCX",
  "sky_10_unike_ustrukturerte_prosjekter/PDF",
];

function availableExternalRequirementFixtures() {
  return OPTIONAL_REQUIREMENT_FIXTURES.map(([relativePath, expectedCount]) => ({
    relativePath,
    expectedCount,
    filePath: resolveExistingFixturePath(relativePath),
  })).filter((fixture) => fixture.filePath);
}

function strictFasitPath() {
  const configuredPath = process.env.REQUIREMENT_VERIFY_FASIT_PATH;
  if (configuredPath) {
    return resolveExistingExplicitFilePath(configuredPath);
  }

  return resolveExistingFixturePath(STRICT_FASIT_RELATIVE_PATH) ?? null;
}

function strictFasitDocumentRoots() {
  const configuredRoots = fixtureSearchRoots({
    REQUIREMENT_VERIFY_FIXTURE_ROOTS:
      process.env.REQUIREMENT_VERIFY_STRICT_ROOTS,
  });
  if (configuredRoots.length) return configuredRoots;

  return fixtureSearchRoots().flatMap((root) =>
    STRICT_FASIT_RELATIVE_ROOTS.map((relativeRoot) =>
      resolveFixturePathInRoot(root, relativeRoot),
    ).filter((filePath) => typeof filePath === "string"),
  );
}

function projectDocumentDetailFromParsed(filePath, parsed, buffer) {
  const now = new Date(0).toISOString();
  const fileName = path.basename(filePath);

  return {
    id: fileName,
    project_id: "local-requirement-verification",
    title: fileName,
    file_name: fileName,
    file_format: parsed.fileFormat,
    content_type: parsed.contentType,
    file_size_bytes: buffer.length,
    page_count: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: now,
    updated_at: now,
    role: "requirement",
    raw_text: parsed.rawText,
    file_base64: parsed.fileBase64,
    structure_map: parsed.sourceMap,
  };
}

function syntheticProjectDocument({ fileName, fileFormat, rawText, structureMap }) {
  const now = new Date(0).toISOString();
  return {
    id: fileName,
    project_id: "local-requirement-verification",
    title: fileName,
    file_name: fileName,
    file_format: fileFormat,
    content_type: contentTypeForUploadFormat(fileFormat),
    file_size_bytes: Buffer.byteLength(rawText),
    page_count: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: now,
    updated_at: now,
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    raw_text: rawText,
    file_base64: "",
    structure_map: structureMap,
  };
}

const SYNTHETIC_STRUCTURED_CASES = [
  {
    name: "synthetic-docling-chunked-pdf",
    expected: [
      {
        id: "D-001",
        text: "Leverandøren skal etablere kryptert backup.",
      },
      {
        id: "D-002",
        text: "Leverandøren skal dokumentere restore-test hver måned.",
      },
    ],
    document: syntheticProjectDocument({
      fileName: "synthetic-docling-chunked-pdf.pdf",
      fileFormat: "pdf",
      rawText:
        "[[SIDE:1-40]]\nDocling kravtabell\n[[SIDE:41-80]]\nVidere kravtabell",
      structureMap: [
        {
          reference: "Kravgrunnlag – Docling tabell 1, rad 2, side 41",
          text: "Kravref: D-001 | Kravtekst: Leverandøren skal etablere kryptert backup. | Svarinstruks: Beskriv løsning og verifikasjon | Detailed response: Se vedlegg B.",
          kind: "docling_table_row",
          parser: "docling",
          page: 41,
          table_index: 1,
          row_index: 2,
          columns: [
            "Kravref",
            "Kravtekst",
            "Svarinstruks",
            "Detailed response",
          ],
          cells: {
            Kravref: "D-001",
            Kravtekst: "Leverandøren skal etablere kryptert backup.",
            Svarinstruks: "Beskriv løsning og verifikasjon",
            "Detailed response": "Se vedlegg B.",
          },
          docling_ref: "#/tables/0",
        },
        {
          reference: "Kravgrunnlag – Docling tabell 1, rad 3, side 42",
          text: "Kravref: D-002 | Kravtekst: Leverandøren skal dokumentere restore-test hver måned.",
          kind: "docling_table_row",
          parser: "docling",
          page: 42,
          table_index: 1,
          row_index: 3,
          columns: ["Kravref", "Kravtekst", "Svar"],
          cells: {
            Kravref: "D-002",
            Kravtekst: "Leverandøren skal dokumentere restore-test hver måned.",
            Svar: "Ja",
          },
          docling_ref: "#/tables/0",
        },
      ],
    }),
  },
  {
    name: "synthetic-docx-merged-table",
    expected: [
      {
        id: "M-10",
        text: "Tilbyder skal beskrive rollebasert tilgangsstyring for driftsbrukere.",
      },
    ],
    document: syntheticProjectDocument({
      fileName: "synthetic-docx-merged-table.docx",
      fileFormat: "docx",
      rawText:
        "Requirements to security\nM-10 Tilbyder skal beskrive rollebasert tilgangsstyring for driftsbrukere.",
      structureMap: [
        {
          reference: "DOCX tabell 2 rad 5",
          text: "Req. No.: M-10 | Requirement text: Tilbyder skal beskrive rollebasert tilgangsstyring for driftsbrukere. | Response instruction: Svar med kontrollansvar",
          kind: "table",
          parser: "docx-xml",
          page: 1,
          table_index: 2,
          row_index: 5,
          columns: ["Req. No.", "Requirement text", "Response instruction"],
          cells: {
            "Req. No.": "M-10",
            "Requirement text":
              "Tilbyder skal beskrive rollebasert tilgangsstyring for driftsbrukere.",
            "Response instruction": "",
          },
        },
      ],
    }),
  },
  {
    name: "synthetic-xlsx-requirement-matrix",
    expected: [
      {
        id: "X-20",
        text: "Leverandøren må rapportere kostnadsavvik per tjenesteområde.",
      },
      {
        id: "X-21",
        text: "Leverandøren må støtte eksport av revisjonslogg til SIEM.",
      },
    ],
    document: syntheticProjectDocument({
      fileName: "synthetic-xlsx-requirement-matrix.xlsx",
      fileFormat: "xlsx",
      rawText:
        "Kravref\tKravtekst\tTjeneste\nX-20\tLeverandøren må rapportere kostnadsavvik per tjenesteområde.\tFinOps",
      structureMap: [
        {
          reference: "Ark 1 rad 2",
          text: "Kravref: X-20 | Kravtekst: Leverandøren må rapportere kostnadsavvik per tjenesteområde. | Tjeneste: FinOps",
          kind: "table",
          parser: "xlsx",
          page: 1,
          table_index: 1,
          row_index: 2,
          columns: ["Kravref", "Kravtekst", "Tjeneste"],
          cells: {
            Kravref: "X-20",
            Kravtekst:
              "Leverandøren må rapportere kostnadsavvik per tjenesteområde.",
            Tjeneste: "FinOps",
          },
        },
        {
          reference: "Ark 1 rad 3",
          text: "Kravref: X-21 | Kravtekst: Leverandøren må støtte eksport av revisjonslogg til SIEM. | Svar: Ja",
          kind: "table",
          parser: "xlsx",
          page: 1,
          table_index: 1,
          row_index: 3,
          columns: ["Kravref", "Kravtekst", "Svar"],
          cells: {
            Kravref: "X-21",
            Kravtekst:
              "Leverandøren må støtte eksport av revisjonslogg til SIEM.",
            Svar: "Ja",
          },
        },
        {
          reference: "Ark 1 rad 4",
          text: "Kommentar: Dette er bare veiledning til leverandøren.",
          kind: "table",
          parser: "xlsx",
          page: 1,
          table_index: 1,
          row_index: 4,
          columns: ["Kommentar", "Svar"],
          cells: {
            Kommentar: "Dette er bare veiledning til leverandøren.",
            Svar: "Ikke et krav",
          },
        },
      ],
    }),
  },
];

function headingBreakdown(ledger) {
  const counts = new Map();
  for (const entry of ledger) {
    const heading = entry.heading || "(blank)";
    counts.set(heading, (counts.get(heading) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([heading, count]) => `${count}x ${heading}`)
    .join(" | ");
}

function normalizeInlineText(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeFasitText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/["“”]/g, "")
    .trim();
}

function loadStrictFasitRowsByDocument(fasitPath) {
  if (!existsSync(fasitPath)) {
    throw new Error(`Fant ikke fasitfil: ${fasitPath}`);
  }

  const workbook = xlsx.readFile(fasitPath);
  const sheet = workbook.Sheets["Alle krav"];
  if (!sheet) {
    throw new Error(`Fasitfilen mangler arket "Alle krav": ${fasitPath}`);
  }

  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  const byDocument = new Map();
  for (const row of rows) {
    const documentName = normalizeInlineText(row.Dok);
    if (!documentName) continue;
    byDocument.set(documentName, [...(byDocument.get(documentName) ?? []), row]);
  }

  return byDocument;
}

function strictFasitFilePath(documentName, strictRoots) {
  return strictRoots
    .map((root) => resolveFixturePathInRoot(root, documentName))
    .find((filePath) => filePath && existsSync(filePath));
}

function sourceAnchoringIssues(ledger) {
  const issues = [];
  for (const [index, entry] of ledger.entries()) {
    const hasLocator =
      entry.sourceExcerpt ||
      entry.tableId ||
      entry.heading ||
      (Array.isArray(entry.pages) && entry.pages.length > 0);
    if (!hasLocator) {
      issues.push(`${index + 1} ${entry.id || "(uten id)"}`);
    }
  }
  return issues;
}

function compareLedgerWithFasitRows(ledger, expectedRows) {
  const mismatches = [];
  for (let index = 0; index < expectedRows.length; index += 1) {
    const expectedText = normalizeFasitText(expectedRows[index]?.Kravtekst);
    const actualText = normalizeFasitText(ledger[index]?.text);
    if (actualText !== expectedText) {
      mismatches.push({
        index: index + 1,
        ref: expectedRows[index]?.["Fasit-ref"],
        expected: expectedRows[index]?.Kravtekst,
        actual: ledger[index]?.text,
      });
    }
  }

  return {
    expectedCount: expectedRows.length,
    actualCount: ledger.length,
    mismatches,
    sourceIssues: sourceAnchoringIssues(ledger),
  };
}

function sectionDump(rawText) {
  const headings =
    /^(?:Krav\s*-\s*blandet\s+liste|Leverandør\s+må\s+svare\s+på|Åpne\s+punkter\s+og\s+minimumsbehov|Notater\s+fra\s+møte|Løs\s+tekst\s+fra\s+behovsavklaring|Liten\s+tabell\s+fra\s+fagansvarlige|Må\s+ha\s*\/\s*kanskje\s*\/\s*avklares|Ikke\s+glem\s+dette|Tabell\s+som\s+ikke\s+er\s+ferdig\s+prioritert|Drift,\s*sikkerhet,\s*data\s*-\s*litt\s+om\s+hverandre)$/i;
  const lines = rawText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizeInlineText(line))
    .filter(Boolean);
  const sections = [];
  let current = null;

  for (const line of lines) {
    if (/^Svarformat$/i.test(line)) {
      if (current?.lines.length) sections.push(current);
      current = null;
      continue;
    }
    if (headings.test(line)) {
      if (current?.lines.length) sections.push(current);
      current = { heading: line, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }

  if (current?.lines.length) sections.push(current);
  return sections;
}

function printLedgerDump(result) {
  console.log(`\n--- DUMP ${result.fileName} ---`);
  for (const [index, entry] of result.ledger.entries()) {
    const label = [
      String(index + 1).padStart(3, " "),
      entry.id,
      entry.heading || "(blank)",
      entry.tableId || "",
    ]
      .filter(Boolean)
      .join(" | ");
    console.log(`${label}\n    ${normalizeInlineText(entry.text)}`);
  }

  console.log("\n--- SOURCE SECTIONS ---");
  for (const section of result.sections) {
    console.log(`\n[${section.heading}]`);
    for (const line of section.lines) {
      console.log(`  ${line}`);
    }
  }
}

async function verifyOne(filePath, expectedCount) {
  const buffer = await readFile(filePath);
  const fileName = path.basename(filePath);
  const fileFormat = inferUploadFileFormat({ fileName });
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName,
    contentType: contentTypeForUploadFormat(fileFormat),
    role: "requirement",
    useDocling: false,
  });
  const document = projectDocumentDetailFromParsed(filePath, parsed, buffer);
  const ledger = await extractRequirementLedgerForDocument(document);
  const actualCount = ledger.length;

  return {
    fileName,
    expectedCount,
    actualCount,
    ok: actualCount === expectedCount,
    breakdown: headingBreakdown(ledger),
    ledger,
    sections: sectionDump(parsed.rawText),
  };
}

async function verifySyntheticStructuredCases() {
  const failures = [];

  console.log("\nSYNTHETIC STRUCTURED");
  for (const testCase of SYNTHETIC_STRUCTURED_CASES) {
    const ledger = await extractRequirementLedgerForDocument(testCase.document);
    const sourceIssues = sourceAnchoringIssues(ledger);
    const mismatches = [];

    for (let index = 0; index < testCase.expected.length; index += 1) {
      const expected = testCase.expected[index];
      const actual = ledger[index];
      if (
        normalizeInlineText(actual?.id) !== normalizeInlineText(expected.id) ||
        normalizeInlineText(actual?.text) !== normalizeInlineText(expected.text)
      ) {
        mismatches.push({ index: index + 1, expected, actual });
      }
    }

    const ok =
      ledger.length === testCase.expected.length &&
      mismatches.length === 0 &&
      sourceIssues.length === 0;
    if (!ok) {
      failures.push({ testCase, ledger, mismatches, sourceIssues });
    }

    console.log(
      `${ok ? "OK  " : "FAIL"} ${testCase.name}: ${ledger.length}/${testCase.expected.length}, kilder uten locator=${sourceIssues.length}`,
    );
    for (const mismatch of mismatches.slice(0, 3)) {
      console.log(
        `      ${mismatch.index}: forventet ${mismatch.expected.id} "${mismatch.expected.text}"`,
      );
      console.log(
        `         faktisk ${mismatch.actual?.id ?? "(mangler)"} "${mismatch.actual?.text ?? ""}"`,
      );
    }
  }

  console.log(
    `\nSYNTHETIC TOTAL ${SYNTHETIC_STRUCTURED_CASES.length - failures.length}/${SYNTHETIC_STRUCTURED_CASES.length}`,
  );
  return failures;
}

const args = process.argv.slice(2);
const dumpFilter = args[args.indexOf("--dump") + 1] ?? "";
const dumpAll = args.includes("--dump-all");
const strictFasit = args.includes("--strict-fasit");
const skipSynthetic = args.includes("--skip-synthetic");
const requireExternalFixtures = args.includes("--require-external-fixtures");
let passed = 0;
const failures = [];
const externalFixtures = availableExternalRequirementFixtures();
const missingExternalFixtureCount =
  OPTIONAL_REQUIREMENT_FIXTURES.length - externalFixtures.length;

if (externalFixtures.length) {
  console.log("\nOPTIONAL EXTERNAL CORPUS");
  for (const { filePath, expectedCount } of externalFixtures) {
    const result = await verifyOne(filePath, expectedCount);
    if (result.ok) {
      passed += 1;
    } else {
      failures.push(result);
    }

    console.log(
      `${result.ok ? "OK  " : "FAIL"} ${result.fileName}: ${result.actualCount}/${result.expectedCount}`,
    );
    if (!result.ok) {
      console.log(`      ${result.breakdown}`);
    }
    if (
      dumpAll ||
      (dumpFilter &&
        result.fileName.toLowerCase().includes(dumpFilter.toLowerCase()))
    ) {
      printLedgerDump(result);
    }
  }

  console.log(
    `\nOPTIONAL TOTAL ${passed}/${externalFixtures.length} available files`,
  );
  if (missingExternalFixtureCount) {
    console.log(
      `OPTIONAL SKIPPED ${missingExternalFixtureCount} missing files. Set REQUIREMENT_VERIFY_FIXTURE_ROOT to the corpus root to run them.`,
    );
  }
} else {
  console.log(
    "\nOPTIONAL EXTERNAL CORPUS skipped. Set REQUIREMENT_VERIFY_FIXTURE_ROOT to run private fixture files.",
  );
}

if (requireExternalFixtures && missingExternalFixtureCount) {
  failures.push({
    fileName: "external requirement fixtures",
    expectedCount: OPTIONAL_REQUIREMENT_FIXTURES.length,
    actualCount: externalFixtures.length,
    ok: false,
  });
  console.log(
    `FAIL external requirement fixtures: ${externalFixtures.length}/${OPTIONAL_REQUIREMENT_FIXTURES.length} available`,
  );
}

if (strictFasit) {
  const fasitPath = strictFasitPath();
  if (!fasitPath) {
    throw new Error(
      "Fant ikke fasitfil. Sett REQUIREMENT_VERIFY_FASIT_PATH eller REQUIREMENT_VERIFY_FIXTURE_ROOT.",
    );
  }

  const rowsByDocument = loadStrictFasitRowsByDocument(fasitPath);
  const strictRoots = strictFasitDocumentRoots();
  const strictFailures = [];
  let strictPassed = 0;
  let strictRequirementCount = 0;
  let strictMatchedRequirementCount = 0;

  console.log("\nSTRICT FASIT");
  for (const [documentName, expectedRows] of rowsByDocument.entries()) {
    const filePath = strictFasitFilePath(documentName, strictRoots);
    if (!filePath) {
      strictFailures.push({
        documentName,
        reason: "missing_file",
      });
      console.log(`FAIL ${documentName}: fant ikke dokumentfil`);
      continue;
    }

    const result = await verifyOne(filePath, expectedRows.length);
    const comparison = compareLedgerWithFasitRows(result.ledger, expectedRows);
    strictRequirementCount += expectedRows.length;
    strictMatchedRequirementCount +=
      comparison.expectedCount - comparison.mismatches.length;
    const ok =
      comparison.actualCount === comparison.expectedCount &&
      comparison.mismatches.length === 0 &&
      comparison.sourceIssues.length === 0;

    if (ok) {
      strictPassed += 1;
    } else {
      strictFailures.push({
        documentName,
        comparison,
      });
    }

    console.log(
      `${ok ? "OK  " : "FAIL"} ${documentName}: tekst ${comparison.expectedCount - comparison.mismatches.length}/${comparison.expectedCount}, kilder uten locator=${comparison.sourceIssues.length}`,
    );
    for (const mismatch of comparison.mismatches.slice(0, 5)) {
      console.log(
        `      ${mismatch.index} ${mismatch.ref ?? ""}: forventet "${normalizeInlineText(mismatch.expected)}"`,
      );
      console.log(`         faktisk "${normalizeInlineText(mismatch.actual)}"`);
    }
    if (comparison.sourceIssues.length) {
      console.log(
        `      mangler kildeforankring: ${comparison.sourceIssues.slice(0, 10).join(", ")}`,
      );
    }
  }

  console.log(
    `\nSTRICT TOTAL ${strictPassed}/${rowsByDocument.size} dokumenter, ${strictMatchedRequirementCount}/${strictRequirementCount} krav matchet`,
  );

  if (strictFailures.length) {
    process.exitCode = 1;
  }
}

if (!skipSynthetic) {
  const syntheticFailures = await verifySyntheticStructuredCases();
  if (syntheticFailures.length) {
    process.exitCode = 1;
  }
}

if (failures.length) {
  process.exitCode = 1;
}
