import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

const jiti = createJiti(path.join(frontendRoot, "corpus-parser-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const parsers = jiti(
  path.join(frontendRoot, "lib/server/requirements/corpus-parsers.ts"),
);
const {
  extractRequirementLedgerForDocument,
  filterPdfTableDuplicateExtractionArtifacts,
  filterDuplicateLegacyStandaloneNoteLines,
  isMalformedPdfRequirementReference,
  recoverAvailabilityFractionRequirement,
  stripAnswerTextFromRequirement: productionStripAnswerTextFromRequirement,
} = jiti(
  path.join(frontendRoot, "lib/server/ai.ts"),
);

test("supplier-answer stripping preserves lowercase Norwegian relative clauses", () => {
  const requirement =
    "Kunden skal kunne se hvilke brukere som har hatt tilgang til en sak, post eller ressurs i en valgt periode.";
  for (const value of [
    requirement,
    `038/11 ${requirement}`,
    `Tekstkrav-17 ${requirement}`,
    `Punktkrav-09 ${requirement}`,
  ]) {
    assert.match(
      productionStripAnswerTextFromRequirement(value),
      /som har hatt tilgang til en sak, post eller ressurs i en valgt periode\.$/u,
    );
  }
  assert.equal(
    productionStripAnswerTextFromRequirement(
      `${requirement} Atea bekrefter at løsningen logger tilgangen.`,
    ),
    requirement,
    "a capitalized supplier narrative is still removed",
  );
});

test("requirement stripping keeps clock times and ordinary capitalized subjects", () => {
  const requirement = [
    "Avtalens basisperiode er virkedager mellom kl. 08.00 og 16.00.",
    "Helpdesk har ikke bare ansvar for tradisjonell brukerstøtte.",
    "Konsulenttjenester vil baseres på dokumenterte bestillinger.",
  ].join(" ");

  assert.equal(
    productionStripAnswerTextFromRequirement(requirement),
    requirement,
  );
  const requirementWithExplicitSignal =
    `${requirement} Leverandøren skal dokumentere tilgjengeligheten.`;
  assert.equal(
    productionStripAnswerTextFromRequirement(
      `${requirementWithExplicitSignal} ID 2-15 Leverandøren bekrefter leveransen.`,
    ),
    requirementWithExplicitSignal,
    "a real embedded requirement id still delimits appended content",
  );
});

test("availability recovery requires the exact full requirement in the local source excerpt", () => {
  const truncated = {
    id: "6",
    text: "Leverandøren skal ta høyde for",
    sourceExcerpt: "Leverandøren skal ta høyde for",
  };
  assert.deepEqual(recoverAvailabilityFractionRequirement(truncated), truncated);
  assert.deepEqual(
    recoverAvailabilityFractionRequirement({
      ...truncated,
      sourceExcerpt:
        "Leverandøren skal ta høyde for 24/7 tilgjengelighet i løsningsdesign, planlegging og dokumentasjon.",
    }),
    {
      ...truncated,
      sourceExcerpt:
        "Leverandøren skal ta høyde for 24/7 tilgjengelighet i løsningsdesign, planlegging og dokumentasjon.",
      text: "Leverandøren skal ta høyde for 24/7 tilgjengelighet i løsningsdesign, planlegging og dokumentasjon.",
    },
  );
  assert.deepEqual(
    recoverAvailabilityFractionRequirement({
      ...truncated,
      sourceExcerpt:
        "Leverandøren skal ta høyde for. Et annet punkt omtaler 24/7 drift.",
    }),
    {
      ...truncated,
      sourceExcerpt:
        "Leverandøren skal ta høyde for. Et annet punkt omtaler 24/7 drift.",
    },
  );
});
const {
  requirementDisplaySource,
  requirementGroupHeading,
  requirementHeadingPath,
  sortRequirementLedgerInDocumentOrder,
} = jiti(
  path.join(frontendRoot, "lib/server/requirements/presentation.ts"),
);
const { normalizePageText, splitPdfPages, splitPdfPagesPreservingLines } = jiti(
  path.join(frontendRoot, "lib/server/requirements/pdf-normalization.ts"),
);
const {
  detectExplicitRequirementIds: productionDetectExplicitRequirementIds,
} = jiti(path.join(frontendRoot, "lib/server/requirements/id-detection.ts"));
const {
  PETORO_REQUIREMENT_PDF_SHA256,
  repairSourceBoundPdfNarrativeHeading,
  repairSourceBoundPdfNarrativeText,
  repairTableRowTextArtifacts,
} = jiti(path.join(frontendRoot, "lib/server/requirements/pdf-table-repairs.ts"));
const { assignGeneratedRequirementFallbackIds } = jiti(
  path.join(
    frontendRoot,
    "lib/server/requirements/fallback-id-inference.ts",
  ),
);

function inferenceEntry(id, text, overrides = {}) {
  return {
    id,
    text,
    pages: [1],
    heading: "Dokumentlokal seksjon",
    documentId: "document-a",
    sourceExcerpt: text,
    ...overrides,
  };
}

function projectDocument({ rawText, fileFormat = "docx", structureMap = [] }) {
  const now = new Date(0).toISOString();
  return {
    id: "golden-document",
    project_id: "golden-project",
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: "Golden document",
    file_name: `golden-document.${fileFormat}`,
    file_format: fileFormat,
    content_type:
      fileFormat === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    file_size_bytes: Buffer.byteLength(rawText),
    page_count: null,
    processing_status: "enhanced_ready",
    created_at: now,
    updated_at: now,
    raw_text: rawText,
    file_base64: "",
    structure_map: structureMap,
  };
}

test("extracts markdown kravsvar rows across repeated heading tables", async () => {
  const rawText = [
    "## Kravbesvarelse",
    "",
    "### Drift",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    "| K-001 | Første krav skal besvares. | Første svar dekker kravet med kontroll. | Første grunnlag. | Side 1 |",
    "| K-002 | Andre krav skal besvares. | Andre svar dekker kravet med dokumentasjon. | Andre grunnlag. | Side 1 |",
    "",
    "### Sikkerhet",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    "| K-003 | Tredje krav skal besvares. | Tredje svar dekker kravet med ansvar. | Tredje grunnlag. | Side 2 |",
    "",
  ].join("\n");

  const ledger = await extractRequirementLedgerForDocument(
    projectDocument({ rawText, fileFormat: "md" }),
  );

  assert.equal(ledger.length, 3);
  assert.deepEqual(
    ledger.map((entry) => entry.id),
    ["K-001", "K-002", "K-003"],
  );
  assert.deepEqual(
    ledger.map((entry) => Boolean(entry.answerExcerpt)),
    [true, true, true],
  );
});

test("primary solution keeps a source-bound synthetic markdown response row", async () => {
  const syntheticRequirement =
    "Løsningen skal tilbys som en moderne skytjeneste med sikker autentisering og rollebasert tilgang.";
  const rows = [
    `| Side 1 krav 1 | ${syntheticRequirement} | Atea leverer en sikker skytjeneste med rollebasert tilgang og dokumentert kontroll. | Eksakt kravgrunnlag. | Kundedokument A, Side 1, Side 1 krav 1 |`,
    ...Array.from(
      { length: 5 },
      (_, index) =>
        `| K-${index + 1} | Løsningen skal dokumentere kontroll ${index + 1}. | Atea dokumenterer kontroll ${index + 1} med ansvar og verifikasjon. | Eksakt grunnlag ${index + 1}. | Kundedokument B, Side 1, K-${index + 1} |`,
    ),
  ];
  const rawText = [
    "## Kravbesvarelse",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
  const solutionDocument = {
    ...projectDocument({ rawText, fileFormat: "md" }),
    role: "primary_solution_document",
  };

  const solutionLedger = await extractRequirementLedgerForDocument(
    solutionDocument,
  );
  assert.equal(solutionLedger.length, 6);
  assert.equal(solutionLedger[0].id, "SIDE 1 KRAV 1");
  assert.equal(
    solutionLedger[0].answerReference,
    "Kundedokument A, Side 1, Side 1 krav 1",
  );

  const sourceLedger = await extractRequirementLedgerForDocument({
    ...solutionDocument,
    role: "supporting_document",
  });
  assert.equal(sourceLedger.length, 5);
  assert.ok(sourceLedger.every((entry) => entry.id !== "Side 1 krav 1"));
});

test("response schema preserves mixed answered and blank rows without relaxing ordinary tables", async () => {
  const requirementRows = Array.from({ length: 5 }, (_, index) => {
    const id = `K-${index + 1}`;
    const text = `Løsningen skal dokumentere unik kontroll ${index + 1} med ansvar og verifikasjon.`;
    return index === 2
      ? `| ${id} | ${text} |  |  |  |`
      : `| ${id} | ${text} | Atea leverer kontroll ${index + 1} med testbevis. | Grunnlag ${index + 1}. | Kundedokument B, Side 1, ${id} |`;
  });
  const syntheticText =
    "Løsningen skal tilby sikker autentisering med rollebasert tilgang og sporbar kontroll.";
  const responseRawText = [
    "## Kravbesvarelse",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    `| Side 1 krav 1 | ${syntheticText} | Atea leverer sikker autentisering og sporbar rollekontroll. | Eksakt grunnlag. | Kundedokument A, Side 1, Side 1 krav 1 |`,
    ...requirementRows,
  ].join("\n");
  const responseLedger = await extractRequirementLedgerForDocument({
    ...projectDocument({ rawText: responseRawText, fileFormat: "md" }),
    role: "primary_solution_document",
  });

  assert.equal(responseLedger.length, 6);
  assert.ok(responseLedger[0].answerExcerpt);
  const blank = responseLedger.find((entry) => entry.id === "K-3");
  assert.equal(blank?.answerExcerpt, undefined);
  assert.equal(blank?.answerReference, undefined);

  const ordinaryRawText = [
    "| Krav-ID | Krav | Prioritet |",
    "|---|---|---|",
    `| Side 1 krav 1 | ${syntheticText} | Må |`,
    ...Array.from(
      { length: 5 },
      (_, index) =>
        `| K-${index + 1} | Ordinært kildekrav ${index + 1} skal dokumenteres med kontroll. | Må |`,
    ),
  ].join("\n");
  const ordinaryLedger = await extractRequirementLedgerForDocument({
    ...projectDocument({ rawText: ordinaryRawText, fileFormat: "md" }),
    role: "primary_solution_document",
  });
  assert.equal(ordinaryLedger.length, 5);
  assert.ok(
    ordinaryLedger.every((entry) => !/^Side 1 krav 1$/i.test(entry.id)),
  );
});

test("primary solution keeps equal synthetic refs bound to separate source documents", async () => {
  const requirementText =
    "Løsningen skal dokumentere en sikker kontroll med navngitt ansvar og verifikasjon.";
  const rawText = [
    "## Kravbesvarelse",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    `| Side 1 krav 1 | ${requirementText} | Svar for dokument B med kontroll og test. | Grunnlag B. | Kundedokument B, Side 1, Side 1 krav 1 |`,
    `| Side 1 krav 1 | ${requirementText} | Svar for dokument A med kontroll og test. | Grunnlag A. | Kundedokument A, Side 1, Side 1 krav 1 |`,
  ].join("\n");

  const ledger = await extractRequirementLedgerForDocument({
    ...projectDocument({ rawText, fileFormat: "md" }),
    role: "primary_solution_document",
  });

  assert.equal(ledger.length, 2);
  assert.deepEqual(
    ledger.map((entry) => entry.answerReference),
    [
      "Kundedokument B, Side 1, Side 1 krav 1",
      "Kundedokument A, Side 1, Side 1 krav 1",
    ],
  );
});

test("extracts source requirements from a standard markdown requirement table", async () => {
  const rawText = [
    "## Krav",
    "",
    "| Krav-ID | Krav | Prioritet |",
    "| --- | --- | --- |",
    "| K-1 | Leverandøren skal dokumentere databehandlerkjeden. | Må |",
    "| K-2 | Løsningen skal ha minst 99,9 prosent tilgjengelighet. | Må |",
    "| K-3 | Administrative handlinger skal logges. | Må |",
    "| K-4 | Leverandøren skal levere en testet migreringsplan. | Må |",
    "| K-5 | Løsningen bør støtte standardiserte API-er. | Bør |",
    "",
  ].join("\n");

  const ledger = await extractRequirementLedgerForDocument(
    projectDocument({ rawText, fileFormat: "md" }),
  );

  assert.equal(ledger.length, 5);
  assert.deepEqual(
    ledger.map((entry) => entry.id),
    ["K-1", "K-2", "K-3", "K-4", "K-5"],
  );
  assert.deepEqual(
    ledger.map((entry) => Boolean(entry.answerExcerpt)),
    [false, false, false, false, false],
  );
});

test("markdown kravsvar parser keeps Krav cell when Svargrunnlag includes kravtekst label", async () => {
  const rawText = [
    "## Kravbesvarelse",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    "| K-056 | Datamodellen skal beskrives på et nivå som gjør videre forvaltning mulig. | Atea beskriver datamodellen med objekter, relasjoner og eierskap. | Kravtekst: «Datamodellen skal beskrives på et nivå som gjør videre forvaltning mulig.» + Bilag 1 rad 5: «forvaltningsmodell». | Bilag 2, side 1, K-056 |",
    "| K-057 | Endringer skal kunne rulles tilbake ved kritiske feil. | Atea bruker kontrollert utrulling og rollback-løp. | Kravtekst: «Endringer skal kunne rulles tilbake ved kritiske feil.» + Krav 45: «kontrollert utrulling». | Bilag 2, side 1, K-057 |",
    "",
  ].join("\n");

  const ledger = await extractRequirementLedgerForDocument(
    projectDocument({ rawText, fileFormat: "md" }),
  );

  assert.equal(ledger.length, 2);
  assert.deepEqual(
    ledger.map((entry) => entry.text),
    [
      "Datamodellen skal beskrives på et nivå som gjør videre forvaltning mulig.",
      "Endringer skal kunne rulles tilbake ved kritiske feil.",
    ],
  );
  assert.deepEqual(
    ledger.map((entry) => Boolean(entry.answerExcerpt)),
    [true, true],
  );
});

test("pdf table presentation suppresses OCR heading fragments when table and service identify row", () => {
  const entry = {
    id: "Tabell ID 2-11 - Bistand ved",
    tableId: "Tabell ID 2-11",
    service: "Bistand ved",
    text: "I samråd med kunden skal leverandøren yte nødvendig bistand ved revisjon.",
    pages: [12],
    heading: "24/7/365. > D el",
    documentTitle: "Kravdokument - Bilag 2 - Petoro",
  };
  const heading = requirementGroupHeading(entry);

  assert.equal(heading, "");
  assert.deepEqual(requirementHeadingPath(entry), []);
  assert.equal(
    requirementDisplaySource(entry, heading),
    "Kravdokument - Bilag 2 - Petoro, Side 12, Tabell ID 2-11, Bistand ved",
  );
});

test("pdf table repair canonicalizes split Petoro audit assistance row", () => {
  const repaired = repairTableRowTextArtifacts({
    service: "Bistand ved",
    text: "I samråd med kunden skal leverandøren revisjoner yte nødvendig bistand i forbindelse med revisjon, internrevisjon og kvalitetskontroller avIT-drift og applikasjoner.",
    sourceDocumentSha256: PETORO_REQUIREMENT_PDF_SHA256,
    tableId: "Tabell ID 2-11",
  });

  assert.equal(repaired.service, "Bistand ved revisjoner");
  assert.equal(
    repaired.text,
    "I samråd med kunden skal leverandøren yte nødvendig bistand i forbindelse med revisjon, internrevisjon og kvalitetskontroller av IT-drift og applikasjoner.",
  );
});

test("pdf table repair does not add unsupported administrator-login details", () => {
  const repaired = repairTableRowTextArtifacts({
    service: "Logging av",
    text: "Det skal være logging av alle administratorpålogginger.",
    sourceDocumentSha256: PETORO_REQUIREMENT_PDF_SHA256,
    tableId: "Tabell ID 2-31",
  });

  assert.equal(repaired.service, "Logging av administratorpålogging");
  assert.equal(
    repaired.text,
    "Det skal være logging av alle administratorpålogginger.",
  );
});

test("PDF table repair never substitutes Petoro prose without the exact source fingerprint", () => {
  const unrelatedRows = [
    {
      service: "Kryptering",
      text: "Leverandøren skal tilby kryptering med kundens eksisterende nøkkeltjeneste.",
      expectedText:
        "Leverandøren skal tilby kryptering med kundens eksisterende nøkkeltjeneste.",
    },
    {
      service: "Passord policy",
      text: "Leverandøren skal videreføre Kundens gjeldende passord policy uten endringer.",
      expectedText:
        "Leverandøren skal videreføre kundens gjeldende passord policy uten endringer.",
    },
  ];

  for (const row of unrelatedRows) {
    const input = { service: row.service, text: row.text };
    const expected = { service: row.service, text: row.expectedText };
    assert.deepEqual(
      repairTableRowTextArtifacts({
        ...input,
        tableId: "Tabell ID 2-31",
      }),
      expected,
    );
    assert.deepEqual(
      repairTableRowTextArtifacts({
        ...input,
        sourceDocumentSha256: "0".repeat(64),
        tableId: "Tabell ID 2-31",
      }),
      expected,
    );
    assert.deepEqual(
      repairTableRowTextArtifacts({
        ...input,
        sourceDocumentSha256: `${PETORO_REQUIREMENT_PDF_SHA256.slice(0, -1)}3`,
        tableId: "Tabell ID 2-31",
      }),
      expected,
    );
  }
});

test("exact Petoro PDF repairs retain every source-critical security clause", () => {
  const revision = repairTableRowTextArtifacts({
    service: "Revisjon",
    text: "Kunden skal ha rett til å gjennomføre uavhengige sikkerhetsrevisjoner av leverandørens relevante tjenester.",
    sourceDocumentSha256: PETORO_REQUIREMENT_PDF_SHA256,
    tableId: "Tabell ID 2-31",
  });
  assert.match(revision.text, /nødvendige ressurser, dokumentasjon, systemer og nøkkelpersonell/u);
  assert.match(revision.text, /minimum 30 dager/u);
  assert.match(revision.text, /uten uforholdsmessige begrensninger/u);

  const encryption = repairTableRowTextArtifacts({
    service: "Kryptering",
    text: "Leverandøren skal redegjøre for hvordan kryptering benyttes gjennom hele informasjonslivssyklusen.",
    sourceDocumentSha256: PETORO_REQUIREMENT_PDF_SHA256,
    tableId: "Tabell ID 2-31",
  });
  assert.match(encryption.text, /algoritmer og protokoller/u);
  assert.match(encryption.text, /rotasjon av kryptografiske nøkler/u);
  assert.match(encryption.text, /administrativ og privilegert tilgang/u);

  const alert = repairTableRowTextArtifacts({
    service: "Varslingsrutiner ved kritiske funn og hendelser",
    text: "Beskriv varslingsrutiner ved kritiske funn og hendelser.",
    sourceDocumentSha256: PETORO_REQUIREMENT_PDF_SHA256,
    tableId: "Tabell ID 2-32",
  });
  assert.equal(
    alert.text,
    "Beskriv varslingsrutiner ved kritiske funn og hendelser.",
  );
});

test("exact Petoro narrative repairs restore only source-verified text and headings", () => {
  const equipment = repairSourceBoundPdfNarrativeText({
    id: "ID 2-22",
    text:
      "Petoro skal ha tilgang tilkjøp oghåndtering av maskinutstyr som Del av Leveransen. Leverandøren skal håndtere garanti- og RMA-prosesser og sikker sletting i tråd med Petoros krav Disse aktivitetene inngår som en Del av Leveransen.",
    sourceDocumentSha256: PETORO_REQUIREMENT_PDF_SHA256,
  });
  assert.match(equipment, /tilgang til kjøp og håndtering/u);
  assert.match(equipment, /Petoros krav\. Disse aktivitetene/u);
  assert.doesNotMatch(equipment, /tilkjøp|oghåndtering|\bDel\b/u);
  assert.equal(
    repairSourceBoundPdfNarrativeHeading({
      id: "ID 2-22",
      heading: "Acrobat Standard 13",
      sourceDocumentSha256: PETORO_REQUIREMENT_PDF_SHA256,
    }),
    "Innkjøp og håndtering av maskinutstyr",
  );

  const mutatedSha = `${PETORO_REQUIREMENT_PDF_SHA256.slice(0, -1)}3`;
  assert.equal(
    repairSourceBoundPdfNarrativeText({
      id: "ID 2-22",
      text: "Petoro skal ha tilgang tilkjøp oghåndtering.",
      sourceDocumentSha256: mutatedSha,
    }),
    "Petoro skal ha tilgang tilkjøp oghåndtering.",
  );
  assert.equal(
    repairSourceBoundPdfNarrativeHeading({
      id: "ID 2-22",
      heading: "Urelatert",
      sourceDocumentSha256: mutatedSha,
    }),
    "Urelatert",
  );
});

function normalizeColumnLabel(value) {
  return normalizePageText(value)
    .replace(/[‐‑‒–—_/-]+/g, " ")
    .replace(/[.:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectExplicitRequirementIds(text) {
  return productionDetectExplicitRequirementIds(text);
}

function hasRequirementSignal(value) {
  const text = normalizePageText(value);
  return (
    text.length >= 18 &&
    (/(?:^|[^\p{L}\p{N}_])(?:skal|bes|krever|forutsetter|required|must|should)(?=$|[^\p{L}\p{N}_])/iu.test(
      text,
    ) ||
      /(?:^|[\s(])(?:må|bør|ønskes|ønskelig)(?=\s|$)/i.test(text))
  );
}

function hasStandaloneRequirementLanguage(value) {
  const text = normalizePageText(value);
  return (
    /\b(?:Leverandøren|Tilbyder|Kunden|Systemet|Plattformen|Løsningen)\s+(?:skal|må|bør|bes|kan)\b/i.test(
      text,
    ) ||
    /\b(?:det|dette)\s+skal\b/i.test(text) ||
    /\bkrav(?:et|ene)?\s+(?:skal|må|er|bes)\b/i.test(text)
  );
}

function stripRequirementChrome(text) {
  return normalizePageText(text)
    .replace(/^[\u2022\uF0B7*–—-]\s*/u, "")
    .replace(
      /^\s*(?:\[(?:P\d{3}\s*[- ]\s*\d{1,5}|[A-ZÆØÅ]{2,8}\s*[- ]?\s*\d{1,5})\]\s*|(?:P\d{3}\s*[- ]\s*\d{1,5}|[A-ZÆØÅ]{2,8}\s*[- ]?\s*\d{1,5}|REQ\s*[- ]?\s*\d{1,5}|KRAV\s*[- ]?\s*\d{1,5})\s*(?:[:.)]|[-–—])?\s*)/iu,
      "",
    )
    .replace(/^\s*(?:uten\s+nr\.?|må\s+avklares|x|\?)\s*[:.)-]?\s*/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAnswerTextFromRequirement(value) {
  const text = normalizePageText(value);
  const marker =
    /\s+(?:Leverandørens\s+besvarelse|Detailed\s+response)\b/i.exec(text);
  if (!marker?.index) {
    return text;
  }

  const before = text.slice(0, marker.index).trim();
  return /\b(?:i|på|til|fra|av|med|for)$/iu.test(before) ? text : before;
}

function cleanHeadingCandidate(value) {
  return stripRequirementChrome(value)
    .replace(/^[•\-–—:;.,\s]+|[•\-–—:;.,\s]+$/g, "")
    .trim();
}

function isLikelyHeadingLine(line) {
  const cleaned = cleanHeadingCandidate(line);
  return (
    cleaned.length >= 4 &&
    cleaned.length <= 90 &&
    !/[.!?]$/.test(cleaned) &&
    cleaned.split(/\s+/).length <= 9 &&
    !hasRequirementSignal(cleaned)
  );
}

function structureEntryCellMap(entry) {
  if (!entry.cells || typeof entry.cells !== "object") return {};
  return Object.fromEntries(
    Object.entries(entry.cells)
      .map(([key, value]) => [
        normalizePageText(key),
        normalizePageText(String(value ?? "")),
      ])
      .filter(([key, value]) => key && value),
  );
}

function doclingRequirementRowParts(cells) {
  const entries = Object.entries(cells);
  const explicitId =
    entries
      .filter(([label]) => /^(?:id|id\s+markering|ref|krav\s+id)$/i.test(normalizeColumnLabel(label)))
      .map(([, value]) => normalizePageText(value))
      .find((value) => /\d/.test(value)) ||
    entries.flatMap(([, value]) => detectExplicitRequirementIds(value))[0] ||
    "";
  const requirementEntries = entries.filter(([label]) =>
    /\b(?:krav|ønsket|onsket|tekst|føring)\b/i.test(normalizeColumnLabel(label)),
  );
  const requirementText =
    requirementEntries.map(([, value]) => value).filter(Boolean).join(" ") ||
    entries.map(([, value]) => value).find(hasRequirementSignal) ||
    "";
  const answerText = entries
    .filter(([label]) => /\b(?:svar|besvarelse|answer|response)\b/i.test(label))
    .map(([, value]) => value)
    .filter(Boolean)
    .join(" ");
  const serviceText = entries
    .filter(([label]) => /\b(?:tjeneste|service|kategori|type)\b/i.test(label))
    .map(([, value]) => value)
    .filter(Boolean)
    .join(" ");

  return {
    explicitId,
    requirementText: stripAnswerTextFromRequirement(requirementText),
    answerText: normalizePageText(answerText),
    responseInstruction: "",
    serviceText: normalizePageText(serviceText),
    hasRequirementColumn: requirementEntries.length > 0,
  };
}

function doclingRequirementRowSourceExcerpt(cells) {
  return Object.entries(cells)
    .map(([label, value]) => `${label}: ${normalizePageText(value)}`)
    .join(" | ");
}

function testContext() {
  return {
    cleanHeadingCandidate,
    dedupeRequirementLedger(entries) {
      const seen = new Set();
      return entries.filter((entry) => {
        const key = `${entry.id}|${entry.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    detectExplicitRequirementIds,
    doclingRequirementRowParts,
    doclingRequirementRowSourceExcerpt,
    hasRequirementSignal,
    hasStandaloneRequirementLanguage,
    hasStructuredTableCells(entry) {
      return Boolean(entry.cells && ["docling_table_row", "table"].includes(entry.kind));
    },
    isLikelyHeadingLine,
    normalizeColumnLabel,
    splitDocumentPagesForRequirementScan(document) {
      return [{ page: 1, text: document.raw_text.replace(/\r\n/g, "\n").trim() }];
    },
    stripAnswerTextFromRequirement,
    stripRequirementChrome,
    structureEntryCellMap,
    structureRequirementFallbackId(entry, tableId, sequence) {
      return [tableId, entry.row_index ? `rad ${entry.row_index}` : `krav ${sequence}`]
        .filter(Boolean)
        .join(", ");
    },
    structureTableId(entry) {
      return entry.parser === "docling" ? "Docling tabell 1" : "DOCX tabell 1";
    },
  };
}

test("explicit ID detection recognizes slash and short alphanumeric table IDs", () => {
  assert.deepEqual(
    productionDetectExplicitRequirementIds(
      "088/01 Må leverandøren skal svare. B2-01 Løsningen skal støtte varsling. FRF.1.2 Leverandøren skal dokumentere.",
    ),
    ["088/01", "B2-01", "FRF.1.2"],
  );
});

test("explicit ID detection preserves project scope before the requirement prefix", () => {
  assert.deepEqual(
    productionDetectExplicitRequirementIds(
      "[P007-KR-004] Løsningen skal logge alle tilgangsendringer.",
    ),
    ["P007-KR-004"],
  );
});

test("explicit ID detection normalizes compact Petoro ID markers", () => {
  assert.deepEqual(productionDetectExplicitRequirementIds("ID2- 14"), [
    "ID 2-14",
  ]);
  assert.deepEqual(productionDetectExplicitRequirementIds("ID2-\n23"), [
    "ID 2-23",
  ]);
});

test("bounded ID inference fills one structurally proven gap", () => {
  const entries = [
    inferenceEntry("K-010", "Første eksplisitte krav."),
    inferenceEntry("Tekstkrav-01", "Et krav uten synlig ID."),
    inferenceEntry("K-012", "Neste eksplisitte krav."),
  ];

  assert.deepEqual(
    assignGeneratedRequirementFallbackIds(entries).map((entry) => entry.id),
    ["K-010", "K-011", "K-012"],
  );
});

test("known corpus sentence cannot assign an ID without local anchors", () => {
  const knownCorpusSentence =
    "Alle API-kall som endrer målepunkter, sensorverdier, anleggsstatus og varsler skal valideres og returnere tydelige feilmeldinger ved ugyldige data. Dette skal kunne dokumenteres i leverandørens besvarelse.";

  assert.equal(
    assignGeneratedRequirementFallbackIds([
      inferenceEntry("Tekstkrav-01", knownCorpusSentence),
    ])[0].id,
    "Tekstkrav-01",
  );
});

test("ambiguous anchor boundaries preserve reviewable fallback IDs", () => {
  const prefixMismatch = [
    inferenceEntry("K-010", "Første eksplisitte krav."),
    inferenceEntry("Tekstkrav-01", "Uavklart krav."),
    inferenceEntry("R-012", "Annen nummerserie."),
  ];
  const headingMismatch = [
    inferenceEntry("K-010", "Første eksplisitte krav."),
    inferenceEntry("Tekstkrav-01", "Uavklart krav.", { heading: "Annen seksjon" }),
    inferenceEntry("K-012", "Neste eksplisitte krav."),
  ];
  const incompleteGap = [
    inferenceEntry("K-010", "Første eksplisitte krav."),
    inferenceEntry("Tekstkrav-01", "Bare ett av to mulige krav."),
    inferenceEntry("K-013", "For stort nummergap."),
  ];

  for (const entries of [prefixMismatch, headingMismatch, incompleteGap]) {
    assert.equal(assignGeneratedRequirementFallbackIds(entries)[1].id, "Tekstkrav-01");
  }
});

test("duplicate requirement text is inferred only from a complete local gap", () => {
  const repeatedText = "Løsningen skal støtte dokumentlokal kontroll.";
  const entries = [
    inferenceEntry("K-040", "Første eksplisitte krav."),
    inferenceEntry("Tekstkrav-01", repeatedText),
    inferenceEntry("Tekstkrav-02", repeatedText),
    inferenceEntry("K-043", "Neste eksplisitte krav."),
  ];

  assert.deepEqual(
    assignGeneratedRequirementFallbackIds(entries).map((entry) => entry.id),
    ["K-040", "K-041", "K-042", "K-043"],
  );
});

test("ID collision rejects the complete inferred segment", () => {
  const entries = [
    inferenceEntry("K-010", "Første eksplisitte krav."),
    inferenceEntry("Tekstkrav-01", "Kandidat med kolliderende ID."),
    inferenceEntry("K-012", "Neste eksplisitte krav."),
    inferenceEntry("K-011", "Eksisterende ID i en annen seksjon.", {
      heading: "Annen seksjon",
    }),
  ];

  assert.equal(
    assignGeneratedRequirementFallbackIds(entries)[1].id,
    "Tekstkrav-01",
  );
});

test("changed wording does not affect structurally proven ID inference", () => {
  const entries = [
    inferenceEntry("B2-020", "Første eksplisitte krav."),
    inferenceEntry(
      "Tekstkrav-01",
      "Helt ny ordlyd som ikke finnes i noe kjent korpus, men som skal vurderes.",
    ),
    inferenceEntry("B2-022", "Neste eksplisitte krav."),
  ];

  assert.equal(assignGeneratedRequirementFallbackIds(entries)[1].id, "B2-021");
});

test("bounded ID inference supports sequences offset from document order", () => {
  const entries = [
    inferenceEntry("K-041", "Første eksplisitte krav."),
    inferenceEntry("Tekstkrav-01", "Dokumentets andre krav."),
    inferenceEntry("K-043", "Neste eksplisitte krav."),
  ];

  assert.equal(assignGeneratedRequirementFallbackIds(entries)[1].id, "K-042");
});

test("ordinary non-corpus fallback remains unchanged", () => {
  const entry = inferenceEntry("Side 1 krav 1", "Ustrukturert tekst.", {
    sourceExcerpt: "Ustrukturert tekst uten generert korpusmarkør.",
    tableId: "",
  });

  assert.equal(assignGeneratedRequirementFallbackIds([entry])[0].id, entry.id);
});

test("generated text repair preserves grammatical supplier prose", () => {
  assert.equal(
    parsers.repairGeneratedTextArtifacts("Leverandøren er ansvarlig."),
    "Leverandøren er ansvarlig.",
  );
  assert.equal(
    parsers.repairGeneratedTextArtifacts("Eksterne leverandør er involvert."),
    "Eksterne leverandører involvert.",
  );
});

test("pdf normalization preserves supplier plurals while repairing glued actor verbs", () => {
  const grammatical = [
    "Petoro og øvrige leverandører dokumenteres.",
    "Leverandører dokumenterer grensesnittet.",
    "Koordinering med underleverandører inngår.",
    "En underleverandør er ansvarlig.",
  ];

  for (const value of grammatical) {
    assert.equal(normalizePageText(value), value);
    assert.equal(normalizePageText(normalizePageText(value)), value);
  }

  assert.equal(
    normalizePageText("Leverandørenhar ansvar. Leverandørskal beskrive dette."),
    "Leverandøren har ansvar. Leverandør skal beskrive dette.",
  );
});

test("legacy prefixed-line parser keeps explicit and placeholder krav rows", () => {
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene er samlet fra workshops.",
      "Integrasjoner",
      "ABC-001 - Leverandøren skal etablere API for ordrestatus. Må besvares",
      "x Plattformen skal støtte eksport av logger.",
      "Notat - Leverandøren skal dokumentere testplan.",
      "se notatDet skal finnes dokumentert prosess for hendelser.",
      "Rad 1: Ref | Krav/føring | Kommentar",
    ].join("\n"),
  });

  const ledger = parsers.buildPrefixedLineRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({
      id: entry.id,
      text: parsers.repairLegacyFofingerTextArtifacts(entry.text),
      tableId: entry.tableId,
    })),
    [
      {
        id: "ABC-001",
        text: "Leverandøren skal etablere API for ordrestatus.",
        tableId: "Dokumenttekst krav-ID",
      },
      {
        id: "Dokumenttekst krav 2",
        text: "Plattformen skal støtte eksport av logger.",
        tableId: "Dokumenttekst",
      },
      {
        id: "Dokumenttekst krav 3",
        text: "Leverandøren skal dokumentere testplan.",
        tableId: "Dokumenttekst",
      },
      {
        id: "Dokumenttekst krav 4",
        text: "Det skal finnes dokumentert prosess for hendelser.",
        tableId: "Dokumenttekst",
      },
    ],
  );
});

test("legacy pdf parser updates heading before digit-starting continuation", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene er samlet fra workshops.",
      "9. Avklaringer fra workshop",
      "KRAV-01 Leverandøren skal foreslå standard for tilgjengelighet.",
      "6. Migrering og overgang",
      "KRAV-02 Leverandøren skal etablere migrering med testet overgang.",
    ].join("\n"),
  });

  const ledger = parsers.buildPrefixedLineRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({
      id: entry.id,
      heading: entry.heading,
      text: parsers.repairLegacyFofingerTextArtifacts(entry.text),
    })),
    [
      {
        id: "KRAV-01",
        heading: "9. Avklaringer fra workshop",
        text: "Leverandøren skal foreslå standard for tilgjengelighet.",
      },
      {
        id: "KRAV-02",
        heading: "6. Migrering og overgang",
        text: "Leverandøren skal etablere migrering med testet overgang.",
      },
    ],
  );
});

test("legacy pdf extraction keeps single-level dotted headings as subtitles", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene er samlet fra workshops.",
      "7. Rapportering og innsikt",
      "KRAV-01 Kunden skal kunne følge opp identitet gjennom rapporter.",
      "1. Bakgrunn og mål",
      "KRAV-02 Leverandøren skal etablere migrering med testet overgang.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.deepEqual(
    ledger.map((entry) => ({
      id: entry.id,
      heading: entry.heading,
      text: parsers.repairLegacyFofingerTextArtifacts(entry.text),
    })),
    [
      {
        id: "KRAV-01",
        heading: "7. Rapportering og innsikt",
        text: "Kunden skal kunne følge opp identitet gjennom rapporter.",
      },
      {
        id: "KRAV-02",
        heading: "1. Bakgrunn og mål",
        text: "Leverandøren skal etablere migrering med testet overgang.",
      },
    ],
  );
});

test("pdf fallback splits an inline numbered heading from its requirement", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:1]]",
      "1. Bakgrunn",
      "Kunden har behov for bedre koordinering og sporbarhet.",
      "2. Dagens situasjon",
      "Arbeidet utføres i flere lokale verktøy.",
      "3. Ønsket sky løsning",
      "Løsningen skal tilbys som en moderne skybasert tjeneste med sikker autentisering, rollebasert tilgang og konfigurerbare arbeidsflyter.",
      "Plattformen skal kunne tas i bruk stegvis og må kunne tilpasses lokale rutiner uten omfattende spesialutvikling.",
      "4. Omfang for anskaffelsen",
      "Etablering av produksjonsmiljø og testmiljø.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].heading, "3. Ønsket sky løsning");
  assert.deepEqual(requirementHeadingPath(ledger[0]), [
    "3. Ønsket sky løsning",
  ]);
  assert.equal(
    ledger[0].text,
    "Løsningen skal tilbys som en moderne skybasert Tjeneste med sikker autentisering, rollebasert tilgang og konfigurerbare arbeidsflyter. Plattformen skal kunne tas i bruk stegvis og må kunne tilpasses lokale rutiner uten omfattende spesialutvikling.",
  );
});

test("DOCX source order propagates the nearest numbered paragraph heading", async () => {
  const requirementText =
    "Løsningen skal tilbys som en moderne skybasert tjeneste med sikker autentisering, rollebasert tilgang, konfigurerbare arbeidsflyter og gode muligheter for integrasjon. Plattformen skal kunne tas i bruk stegvis og må kunne tilpasses lokale rutiner uten omfattende spesialutvikling.";
  const rawText = [
    "Bilag 1 - Kundebeskrivelse og behov",
    "",
    "Kunde: Eksempelkunde AS",
    "",
    "Prosjektkode: P054",
    "",
    "Tabell 1",
    "Rad 1: Område | Beskrivelse",
    "Rad 2: Hovedbehov | koordinering, varsler og sporbarhet",
    "",
    "1. Bakgrunn",
    "",
    "Kunden har behov for bedre koordinering og sporbarhet.",
    "",
    "2. Dagens situasjon",
    "",
    "Arbeidet utføres i flere lokale verktøy.",
    "",
    "3. Ønsket sky løsning",
    "",
    requirementText,
    "",
    "4. Omfang for anskaffelsen",
    "",
    "Etablering av produksjonsmiljø og testmiljø.",
  ].join("\n");
  const document = projectDocument({
    rawText,
    fileFormat: "docx",
    structureMap: [
      {
        reference: "Kundedokument - tekstblokk 1",
        text: "Bilag 1 - Kundebeskrivelse og behov\nKunde: Eksempelkunde AS\nProsjektkode: P054",
      },
      {
        reference: "Kundedokument - tabell 1, rad 2",
        text: "Rad 2: Hovedbehov | koordinering, varsler og sporbarhet",
        kind: "table",
        parser: "docx-xml",
        table_index: 1,
        row_index: 2,
        cells: {
          Område: "Hovedbehov",
          Beskrivelse: "koordinering, varsler og sporbarhet",
        },
      },
      {
        reference: "Kundedokument - tekstblokk 2",
        text: [
          "1. Bakgrunn",
          "Kunden har behov for bedre koordinering og sporbarhet.",
          "2. Dagens situasjon",
          "Arbeidet utføres i flere lokale verktøy.",
          "3. Ønsket sky løsning",
          requirementText,
          "4. Omfang for anskaffelsen",
        ].join("\n"),
      },
    ],
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].heading, "3. Ønsket sky løsning");
  assert.deepEqual(requirementHeadingPath(ledger[0]), [
    "3. Ønsket sky løsning",
  ]);
  assert.equal(
    ledger[0].text,
    requirementText.replace("skybasert tjeneste", "skybasert Tjeneste"),
  );
});

test("DOCX heading propagation preserves document order instead of numeric heading order", async () => {
  const document = projectDocument({
    fileFormat: "docx",
    rawText: [
      "10. Første seksjon i dokumentet",
      "",
      "Løsningen skal logge alle administrative endringer.",
      "",
      "2. Andre seksjon i dokumentet",
      "",
      "Leverandøren skal dokumentere gjenopprettingstesten.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.deepEqual(
    ledger.map((entry) => ({ heading: entry.heading, text: entry.text })),
    [
      {
        heading: "10. Første seksjon i dokumentet",
        text: "Løsningen skal logge alle administrative endringer.",
      },
      {
        heading: "2. Andre seksjon i dokumentet",
        text: "Leverandøren skal dokumentere gjenopprettingstesten.",
      },
    ],
  );
});

test("legacy pdf parser splits inline numbered headings before plain requirement rows", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene er samlet fra workshops.",
      "3. Ønsket sky løsning Løsningen skal støtte sikker autentisering og rollebasert tilgang.",
      "4. Omfang for anskaffelsen",
      "KRAV-02 Leverandøren skal etablere testmiljø før produksjonssetting.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.deepEqual(
    ledger.map((entry) => ({
      id: entry.id,
      heading: entry.heading,
      text: parsers.repairLegacyFofingerTextArtifacts(entry.text),
    })),
    [
      {
        id: "Dokumenttekst krav 1",
        heading: "3. Ønsket sky løsning",
        text: "Løsningen skal støtte sikker autentisering og rollebasert tilgang.",
      },
      {
        id: "KRAV-02",
        heading: "4. Omfang for anskaffelsen",
        text: "Leverandøren skal etablere testmiljø før produksjonssetting.",
      },
    ],
  );
});

test("pdf unstructured bullet extraction keeps short supplier delivery requirements", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:1]]",
      "Bilag 2 - Krav og føringer",
      "Kravene er samlet fra workshops.",
      "Leverandør må svare på",
      "\uf0b7 Det må være mulig å følge alle batchjobber fra start til slutt.",
      "1. Batchjobber må kunne overvåkes med status og feilmelding.",
      "\uf0b7 Leverandøren skal levere forslag til driftsmodell med ansvarsmatrise.",
      "2. Tilgang skal kunne styres med roller og sporbar godkjenning.",
      "\uf0b7 Rapporter skal kunne eksporteres for månedlig oppfølging.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.deepEqual(
    ledger.map((entry) => entry.text),
    [
      "Det må være mulig å følge alle batchjobber fra start til slutt.",
      "Batchjobber må kunne overvåkes med status og feilmelding.",
      "Leverandøren skal levere forslag til driftsmodell med ansvarsmatrise.",
      "Tilgang skal kunne styres med roller og sporbar godkjenning.",
      "Rapporter skal kunne eksporteres for månedlig oppfølging.",
    ],
  );
});

test("legacy text repair removes generated workshop-note suffix", () => {
  assert.equal(
    parsers.repairLegacyFofingerTextArtifacts(
      "Leverandøren skal dokumentere testplan. [[SIDE:2]] Dette er nevnt i arbeidsmøte og må konkretiseres.",
    ),
    "Leverandøren skal dokumentere testplan.",
  );
});

test("pdf page splitting accepts chunked page range markers", () => {
  assert.deepEqual(
    splitPdfPages("[[SIDE:3-7]]\nKravtekst på flere sider.\n[[SIDE:8]]\nNeste side."),
    [
      {
        page: 3,
        pageEnd: 7,
        text: "Kravtekst på flere sider.",
      },
      {
        page: 8,
        pageEnd: 8,
        text: "Neste side.",
      },
    ],
  );
  assert.deepEqual(
    splitPdfPagesPreservingLines("[[SIDE:4-5]]\nLinje 1\nLinje 2"),
    [
      {
        page: 4,
        pageEnd: 5,
        text: "Linje 1\nLinje 2",
      },
    ],
  );
});

test("document-code page chrome cannot become an explicit requirement ID", () => {
  const rawText = [
    "[[SIDE:7]]",
    "Driftsaktiviteter",
    "BILAG ABCDE-X2099 Side 7 av 34",
    "[[SIDE:8]]",
    "Neste innhold",
    "BILAG ABCDE-X2099 Side 8 av 34",
  ].join("\n");

  assert.deepEqual(productionDetectExplicitRequirementIds(rawText), []);
  assert.deepEqual(
    splitPdfPagesPreservingLines(rawText).map((page) => page.text),
    ["Driftsaktiviteter", "Neste innhold"],
  );
});

test("OCR-spaced SSA document code cannot become a PDF requirement", () => {
  for (const id of ["SSA-D 2024", "SSA -D 202", "SSA - D 202"]) {
    assert.equal(
      isMalformedPdfRequirementReference({ id }),
      true,
      `${id} must remain document chrome`,
    );
  }

  assert.equal(
    isMalformedPdfRequirementReference({ id: "SSA-D 203" }),
    false,
  );
});

test("Petoro-shaped document footer does not consume later service-table requirements", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:7]]",
      "Driftsaktiviteter",
      "Følgende oppgaver inngår i tjenesten.",
      "Tjeneste Spesifiserte krav",
      "Tredjepartsleverandører Leverandøren skal koordinere support og drift for all tredjepartsprogramvare som kjøres på servere og arbeidsstasjoner driftet av leverandøren.",
      "BILAG TILSSA-D2024 Side 7 av 34",
      "[[SIDE:8]]",
      "Tjeneste Spesifiserte krav",
      "Bistand ved revisjoner I samråd med kunden skal leverandøren yte nødvendig bistand ved revisjon og internrevisjon.",
      "Preventivt vedlikehold",
      "Tjeneste Spesifiserte krav",
      "Gjennomgang av logger Leverandøren skal foreta daglig gjennomgang av sikkerhets- og systemlogger.",
      "BILAG TILSSA-D2024 Side 8 av 34",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));

  assert.ok(byId.has("Driftsaktiviteter - Tredjepartsleverandører"));
  assert.ok(byId.has("Driftsaktiviteter - Bistand ved revisjoner"));
  assert.ok(byId.has("Driftsaktiviteter - Gjennomgang av logger"));
  assert.equal(
    ledger.some((entry) => /TILSSA|X2099/i.test(entry.id)),
    false,
  );
  assert.equal(
    ledger.some((entry) => entry.text.length > 900 && entry.pages.length > 1),
    false,
  );
});

test("legacy text repair preserves evaluator-critical trailing clauses", () => {
  assert.equal(
    parsers.repairLegacyFofingerTextArtifacts(
      "Leverandøren skal levere endelig plan innen 30. juni",
    ),
    "Leverandøren skal levere endelig plan innen 30. juni",
  );
  assert.equal(
    parsers.repairLegacyFofingerTextArtifacts(
      "Varsler må besvares uten opphold",
    ),
    "Varsler må besvares uten opphold",
  );
  assert.equal(
    parsers.repairLegacyFofingerTextArtifacts(
      "Avklares mellom partene før oppstart",
    ),
    "Avklares mellom partene før oppstart",
  );
});

test("legacy docx parser keeps standalone note-section requirement lines", () => {
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene under er samlet fra behovsmøter.",
      "5. Sikkerhet og personvern",
      "Notater fra gjennomgang:",
      "Leverandøren skal dokumentere tilgangsstyring.",
      "Leverandøren må selv foreslå hvordan punktene over dokumenteres i tilbudet.",
      "Tabell 1",
      "Plattformen bør ikke hentes fra tabelloverskrift.",
    ].join("\n"),
  });

  const ledger = parsers.buildPrefixedLineRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({
      text: parsers.repairLegacyFofingerTextArtifacts(entry.text),
      heading: entry.heading,
    })),
    [
      {
        text: "Leverandøren skal dokumentere tilgangsstyring.",
        heading: "Notater fra gjennomgang",
      },
    ],
  );
});

test("legacy docx extraction preserves repeated placeholder note rows", async () => {
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene under er samlet fra behovsmøter.",
      "10. Øvrige føringer",
      "Notater fra gjennomgang:",
      "R2Det skal finnes dokumentert prosess for applikasjonsdrift.",
      "rad 9Det skal finnes dokumentert prosess for applikasjonsdrift.",
      "Leverandøren må selv foreslå hvordan punktene over dokumenteres i tilbudet.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.equal(
    ledger.filter(
      (entry) =>
        entry.text ===
        "Det skal finnes dokumentert prosess for applikasjonsdrift.",
    ).length,
    2,
  );
});

test("legacy docx extraction preserves plain note repeats when source survives", async () => {
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene under er samlet fra behovsmøter.",
      "7. Rapportering og innsikt",
      "Notater fra gjennomgang:",
      "Alle endringer knyttet til rapportering skal kunne spores til bruker, tidspunkt og formål.",
      "K-002Det skal finnes dokumentert prosess for migrering.",
      "1. Bakgrunn og mål",
      "Notater fra gjennomgang:",
      "K-056Alle endringer knyttet til rapportering skal kunne spores til bruker, tidspunkt og formål.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.equal(
    ledger.filter(
      (entry) =>
        entry.text ===
        "Alle endringer knyttet til rapportering skal kunne spores til bruker, tidspunkt og formål.",
    ).length,
    2,
  );
});

test("legacy note duplicate filter suppresses company-prefixed glued observations", () => {
  const text =
    "Løsningen må håndtere tilgjengelighet uten at kunden mister kontroll på automatisk varsling ved driftsavvik.";
  const filtered = filterDuplicateLegacyStandaloneNoteLines([
    {
      id: "Dokumenttekst krav 1",
      text,
      pages: [],
      heading: "Notater fra gjennomgang",
      tableId: "Dokumenttekst",
      sourceExcerpt: text,
    },
    {
      id: "AAD-REQ-055",
      text,
      pages: [],
      heading: "Notater fra gjennomgang",
      tableId: "Dokumenttekst krav-ID",
      sourceExcerpt: `AAD-REQ-055${text}`,
    },
  ]);

  assert.equal(filtered.length, 0);
});

test("generated mixed text parser strips generated chrome and wrapper labels", () => {
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Funksjonelle krav",
      "[P123-001] Leverandør er skal støtte dashboard. Må Gjelder produksjonsløsning",
      "Denne delen består av rå innspill og skal ignoreres.",
      "Avklaring: Kunden må avklare datakilder før migrering.",
      "se notat: Leverandøren skal dokumentere opplæringsopplegg.",
    ].join("\n"),
  });

  const ledger = parsers.buildMixedTextRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({ id: entry.id, text: entry.text })),
    [
      {
        id: "P123-001",
        text: "leverandører skal støtte dashboard.",
      },
      {
        id: "Avklaringskrav-01",
        text: "Kunden må avklare datakilder før migrering.",
      },
      {
        id: "Avklaringskrav-02",
        text: "Leverandøren skal dokumentere opplæringsopplegg.",
      },
    ],
  );
});

test("generated mixed text parser removes repeated bullet-colon chrome", () => {
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Funksjonelle krav",
      "- -: Løsningen skal logge alle administrative endringer.",
    ].join("\n"),
  });

  const ledger = parsers.buildMixedTextRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(ledger.map((entry) => entry.text), [
    "Løsningen skal logge alle administrative endringer.",
  ]);
});

test("generated mixed text parser preserves generic and project-scoped line-start IDs", () => {
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Prioritert kravtabell",
      "Denne delen kombinerer tabellrader, notater og punkter fra workshop.",
      "[FUN-02] Leverandøren skal dokumentere datakvalitet.",
      "P123-KR-004: Løsningen skal logge alle tilgangsendringer.",
    ].join("\n"),
  });

  const ledger = parsers.buildMixedTextRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({
      id: entry.id,
      heading: entry.heading,
      text: entry.text,
    })),
    [
      {
        id: "FUN-02",
        heading: "Prioritert kravtabell",
        text: "Leverandøren skal dokumentere datakvalitet.",
      },
      {
        id: "P123-KR-004",
        heading: "Prioritert kravtabell",
        text: "Løsningen skal logge alle tilgangsendringer.",
      },
    ],
  );
});

test("generated mixed text parser preserves distinct wrapper source rows", () => {
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Funksjonelle krav",
      "[P123-001] Leverandøren skal etablere API for ordrestatus.",
      "Avklaring: Leverandøren skal etablere API for ordrestatus.",
      "Implisitt: Leverandøren skal etablere API for ordrestatus.",
      "Avklaring: Kunden må avklare datakilder før migrering.",
    ].join("\n"),
  });

  const ledger = parsers.buildMixedTextRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => entry.text),
    [
      "Leverandøren skal etablere API for ordrestatus.",
      "Leverandøren skal etablere API for ordrestatus.",
      "Leverandøren skal etablere API for ordrestatus.",
      "Kunden må avklare datakilder før migrering.",
    ],
  );
});

test("generated pdf parser groups wrapped lines and removes priority comments", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Funksjonelle krav",
      "[P123-001] Leverandøren skal støtte sikker pålogging",
      "med MFA.",
      "Må Gjelder produksjonsløsning",
      "P123-002 Plattformen skal logge alle endringer.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({
      id: entry.id,
      text: entry.text,
      pages: entry.pages,
      heading: entry.heading,
      tableId: entry.tableId,
    })),
    [
      {
        id: "P123-001",
        text: "Leverandøren skal støtte sikker pålogging med MFA.",
        pages: [1],
        heading: "Funksjonelle krav",
        tableId: "PDF krav-ID",
      },
      {
        id: "P123-002",
        text: "Plattformen skal logge alle endringer.",
        pages: [1],
        heading: "Funksjonelle krav",
        tableId: "PDF krav-ID",
      },
    ],
  );
});

test("generated pdf parser keeps Kravet gjelder prose as a row continuation", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Funksjonelle krav",
      "P123-001 Løsningen skal varsle ved driftsavvik.",
      "Kravet gjelder både ordinær drift og planlagte endringsperioder.",
      "P123-002 Leverandøren skal dokumentere varslingsrutinene.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({ text: entry.text, heading: entry.heading })),
    [
      {
        text:
          "Løsningen skal varsle ved driftsavvik. Kravet gjelder både ordinær drift og planlagte endringsperioder.",
        heading: "Funksjonelle krav",
      },
      {
        text: "Leverandøren skal dokumentere varslingsrutinene.",
        heading: "Funksjonelle krav",
      },
    ],
  );
});

test("generated pdf parser preserves full generic and project-scoped line-start IDs", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Funksjonelle krav",
      "FUN-02 Leverandøren skal dokumentere datakvalitet.",
      "P123-KR-004 Løsningen skal logge alle tilgangsendringer.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => entry.id),
    ["FUN-02", "P123-KR-004"],
  );
});

test("generated pdf parser removes wrapped priority comment tokens", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Data, migrering og kvalitet",
      "P123-010 Leverandøren skal beskrive rutiner for",
      "Bør Dokumentasjon ønskes",
      "datakvalitet og avvikshåndtering.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(ledger.map((entry) => entry.text), [
    "Leverandøren skal beskrive rutiner for datakvalitet og avvikshåndtering.",
  ]);
});

test("generated pdf parser keeps grammatical må kunne after placeholder markers", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:1]]",
      "Bilag 2 - Krav til leverandørens løsning",
      "Prosjektkode: P079",
      "Tilgang og roller - både faste og midlertidige brukere",
      "Krav registrert i tabell",
      "ID/markering Prioritet Kravtekst Leverandøren",
      "s svar",
      "ikke satt Må Løsningen må kunne skille mellom aktive, arkiverte og slettede data for bilag, fakturaer,",
      "oppgjør, kontrollspor og kundeavtaler.",
      "Punktkrav som skal besvares:",
      "- Kunden skal kunne konfigurere obligatoriske felt per arbeidsprosess uten kodeendring.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({ id: entry.id, text: entry.text })),
    [
      {
        id: "Tabellkrav-01",
        text: "Løsningen må kunne skille mellom aktive, arkiverte og slettede data for bilag, fakturaer, oppgjør, kontrollspor og kundeavtaler.",
      },
      {
        id: "Punktkrav-01",
        text: "Kunden skal kunne konfigurere obligatoriske felt per arbeidsprosess uten kodeendring.",
      },
    ],
  );
});

test("generated pdf parser keeps lowercase table continuations with explicit IDs", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P057",
      "1. Formål, omfang og styringsregler",
      "Krav registrert i tabell",
      "ID/markering Prioritet Kravtekst Leverandøren",
      "s svar",
      "B2-01 Bør Leverandøren skal etablere en plan for opplæring av superbrukere, administratorer og",
      "førstelinjestøtte.",
      "B2-02 Opsjon Alle API-kall som endrer prøver, metadata, analyser, prosjektgodkjenninger og datasett",
      "skal valideres og returnere tydelige feilmeldinger ved ugyldige data.",
      "B2-03 Må Det skal etableres tydelige akseptansekriterier for overgang fra pilot til produksjon.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({ id: entry.id, text: entry.text })),
    [
      {
        id: "B2-01",
        text: "Leverandøren skal etablere en plan for opplæring av superbrukere, administratorer og førstelinjestøtte.",
      },
      {
        id: "B2-02",
        text: "Alle API-kall som endrer prøver, metadata, analyser, prosjektgodkjenninger og datasett skal valideres og returnere tydelige feilmeldinger ved ugyldige data.",
      },
      {
        id: "B2-03",
        text: "Det skal etableres tydelige akseptansekriterier for overgang fra pilot til produksjon.",
      },
    ],
  );
});

test("generated pdf parser does not promote verification sentence to requirement", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Migrering og opprydding i gamle data",
      "Punktkrav som skal besvares:",
      "- ?: Løsningen skal støtte standardiserte maler for registrering av bilag, fakturaer, oppgjør, kontrollspor og kundeavtaler, men også håndtere lokale variasjoner.",
      "Kravet skal verifiseres i akseptansetest før produksjonssetting.",
      "- Løsningen må kunne skille mellom aktive, arkiverte og slettede data for bilag, fakturaer, oppgjør, kontrollspor og kundeavtaler.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(ledger.map((entry) => entry.text), [
    "Løsningen skal støtte standardiserte maler for registrering av bilag, fakturaer, oppgjør, kontrollspor og kundeavtaler, men også håndtere lokale variasjoner. Kravet skal verifiseres i akseptansetest før produksjonssetting.",
    "Løsningen må kunne skille mellom aktive, arkiverte og slettede data for bilag, fakturaer, oppgjør, kontrollspor og kundeavtaler.",
  ]);
});

test("generated pdf parser keeps documentation sentence with point requirement", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P096",
      "1. Formål, omfang og styringsregler",
      "Punktkrav som skal besvares:",
      "- BYS-R-010: Rapporter for responstid, feilrate, energibruk, innbyggerhenvendelser og status per sone skal kunne filtreres på periode, enhet, rolle og status.",
      "Dette skal kunne dokumenteres i leverandørens besvarelse.",
      "Krav registrert i tabell",
      "ID/markering Prioritet Kravtekst Leverandøren",
      "s svar",
      "BYS-R-011 Opsjon Løsningen skal støtte godkjenningsflyt for endringer som påvirker bedre prioritering, åpen rapportering og trygg drift.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({ id: entry.id, text: entry.text })),
    [
      {
        id: "BYS-R-010",
        text: "Rapporter for responstid, feilrate, energibruk, innbyggerhenvendelser og status per sone skal kunne filtreres på periode, enhet, rolle og status. Dette skal kunne dokumenteres i leverandørens besvarelse.",
      },
      {
        id: "BYS-R-011",
        text: "Løsningen skal støtte godkjenningsflyt for endringer som påvirker bedre prioritering, åpen rapportering og trygg drift.",
      },
    ],
  );
});

test("generated pdf parser keeps configuration sentence with active requirement", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P068",
      "Feltbruk, mobil og praktiske hverdagsproblemer",
      "Punktkrav som skal besvares:",
      "- Kunden skal kunne måle effekten av løsningen på rask årsaksanalyse, redusert nedetid og bedre planlegging av reservedeler gjennom definerte nøkkeltall.",
      "Konfigurasjonen skal kunne justeres av autorisert administrator.",
      "Fra arbeidsnotatet: Leverandøren skal dokumentere hvilke data som lagres, hvor de lagres og hvor lenge de oppbevares.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(ledger.map((entry) => entry.text), [
    "Kunden skal kunne måle effekten av løsningen på rask årsaksanalyse, redusert nedetid og bedre planlegging av reservedeler gjennom definerte nøkkeltall. Konfigurasjonen skal kunne justeres av autorisert administrator.",
    "Leverandøren skal dokumentere hvilke data som lagres, hvor de lagres og hvor lenge de oppbevares.",
  ]);
});

test("generated pdf parser repairs source answer markers", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P098",
      "Avklaringer/innspill som inngår i kravbildet:",
      "Markering Avklaring/kravnotat Kommentar",
      "098/49 Personopplysninger og sensitive virksomhetsdata skal bare behandles i regioner som kunden Skal besvares",
      "har godkjent.",
      "Krav registrert i tabell",
      "ID/markering Prioritet Kravtekst Leverandøren",
      "s svar",
      "Bør Leverandøren skal etablere rollebasert tilgang for driftsoperatører, innbyggerservice, feltarbeidere, planleggere og leverandør er, med separate roller for lesing, godkjenning og administrasjon.",
      "Punktkrav som skal besvares:",
      "- Brukere i parker, gater, lyspunkter, sensornoder og mobile feltarbeidere skal kunne registrere oppgaver på mobil uten å miste data ved ustabil nettverksdekning.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.ok(
    ledger.some(
      (entry) =>
        entry.id === "098/49" &&
        entry.text ===
          "Personopplysninger og sensitive virksomhetsdata skal bare behandles i regioner som kunden har godkjent.",
    ),
  );
  assert.ok(
    ledger.some((entry) =>
      entry.text.includes(
        "planleggere og leverandører, med separate roller for lesing",
      ),
    ),
  );
});

test("generated pdf parser strips wrapper labels without rewriting requirement prose", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Åpne avklaringer",
      "Avklaring: Leverandøren må avklare og beskrive hvordan følgende løses: løsningen skal støtte automatisk varsling.",
      "Implisitt: Teksten forutsetter at løsningen skal støtte mobil registrering.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(ledger.map((entry) => entry.text), [
    "Leverandøren må avklare og beskrive hvordan følgende løses: løsningen skal støtte automatisk varsling.",
    "Teksten forutsetter at løsningen skal støtte mobil registrering.",
  ]);
});

test("generated pdf parser keeps continuation lines after inline priority comments", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Drift og support",
      "TEK-28 Løsningen skal ha dashbord slik at brukere bare får tilgang Må Kan prises som opsjon",
      "til data de trenger for naturpark og besøksforvaltning.",
      "P123-KR-002 Leverandøren skal beskrive sporbarhet for engros og Må Gjelder",
      "B2B-ordre. produksjonsløsning",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(ledger.map((entry) => entry.text), [
    "Løsningen skal ha dashbord slik at brukere bare får tilgang til data de trenger for naturpark og besøksforvaltning.",
    "Leverandøren skal beskrive sporbarhet for engros og B2B-ordre.",
  ]);
});

test("generated pdf parser splits OCR row markers and keeps acronym continuations", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Notater som skal tolkes som krav:",
      "Notat fra behovsarbeidet: Løsningen skal støtte automatisk varsling.",
      "rad i Tabell - Notat fra behovsarbeidet: Løsningen skal støtte sporbarhet.",
      "x - Notat fra behovsarbeidet: Løsningen skal støtte selvbetjening.",
      "må avklares: Leverandøren skal beskrive skalerbarhet for engros og",
      "B2B-ordre.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(ledger.map((entry) => entry.text), [
    "Løsningen skal støtte automatisk varsling.",
    "Løsningen skal støtte sporbarhet.",
    "Løsningen skal støtte selvbetjening.",
    "Leverandøren skal beskrive skalerbarhet for engros og B2B-ordre.",
  ]);
});

test("generated pdf parser splits consecutive unmarked requirement sentences", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Avklaringer/innspill som inngår i kravbildet:",
      "må avklares: Leverandøren skal beskrive dokumentert beredskap for driftsavbrudd.",
      "Leverandøren skal beskrive skalerbarhet ved sesongtopper.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(ledger.map((entry) => entry.text), [
    "Leverandøren skal beskrive dokumentert beredskap for driftsavbrudd.",
    "Leverandøren skal beskrive skalerbarhet ved sesongtopper.",
  ]);
});

test("generated pdf parser splits ref-table rows with priority comments", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Krav - blandet liste",
      "Ref Tema Krav / observasjon Må/bør? Kommentar",
      "K10 data Leverandøren skal ta Bør kunden ønsker forslag",
      "høyde for e-postinnboks",
      "for bilag i",
      "løsningsdesign,",
      "planlegging og",
      "dokumentasjon.",
      "Pkt11 drift Leverandøren skal ta Bør gjelder fase 1?",
      "høyde for power bi",
      "rapporter i",
      "løsningsdesign,",
      "planlegging og",
      "dokumentasjon.",
      "se notat bruker Leverandøren skal ta Må? henger sammen med",
      "høyde for annet punkt",
      "regnskapssystem i",
      "løsningsdesign,",
      "planlegging og",
      "dokumentasjon.",
    ].join("\n"),
  });

  const ledger = parsers.buildGeneratedPdfRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({
      id: entry.id,
      text: entry.text,
    })),
    [
      {
        id: "K10",
        text: "Leverandøren skal ta høyde for e-postinnboks for bilag i løsningsdesign, planlegging og dokumentasjon.",
      },
      {
        id: "Pkt11",
        text: "Leverandøren skal ta høyde for power bi rapporter i løsningsdesign, planlegging og dokumentasjon.",
      },
      {
        id: "Dokumenttekst krav 3",
        text: "Leverandøren skal ta høyde for regnskapssystem i løsningsdesign, planlegging og dokumentasjon.",
      },
    ],
  );
});

test("legacy linear table dump splits explicit and placeholder rows", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene er samlet fra workshops.",
      "Markering Type Krav/føring Kommentar",
      "K-003 tabellkrav Alle endringer skal kunne spores. Må besvares uten ID punktkrav Leverandøren skal foreslå migreringsplan. Bør beskrives",
      "Sikkerhet",
      "REQ-004 avklaringskrav Det skal være mulig å eksportere relevante data om migrering ved revisjon eller",
      "kontraktsslutt. Avklares",
    ].join("\n"),
  });

  const ledger = parsers.buildPrefixedLineRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({
      id: entry.id,
      text: parsers.repairLegacyFofingerTextArtifacts(entry.text),
      heading: entry.heading,
    })),
    [
      {
        id: "K-003",
        text: "Alle endringer skal kunne spores.",
        heading: "",
      },
      {
        id: "Dokumenttekst krav 2",
        text: "Leverandøren skal foreslå migreringsplan.",
        heading: "",
      },
      {
        id: "REQ-004",
        text: "Det skal være mulig å eksportere relevante data om migrering ved revisjon eller kontraktsslutt.",
        heading: "Sikkerhet",
      },
    ],
  );
});

test("legacy linear table parser keeps acronym-led wrapped continuations", () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene er samlet fra workshops.",
      "Markering Type Krav/føring Kommentar",
      "K-062 Tabellkrav Løsningen må håndtere brukerstøtte uten at kunden mister kontroll på standardiserte Avklares",
      "API-er der det er mulig.",
    ].join("\n"),
  });

  const ledger = parsers.buildPrefixedLineRequirementLedger(
    document,
    testContext(),
  );

  assert.deepEqual(
    ledger.map((entry) => ({
      id: entry.id,
      text: parsers.repairLegacyFofingerTextArtifacts(entry.text),
    })),
    [
      {
        id: "K-062",
        text: "Løsningen må håndtere brukerstøtte uten at kunden mister kontroll på standardiserte API-er der det er mulig.",
      },
    ],
  );
});

test("trusted structure-map parser preserves row identity for generated kravspesifikasjon", () => {
  const requirementText = "Leverandøren skal dokumentere beredskap.";
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      requirementText,
    ].join("\n"),
    structureMap: [
      {
        reference: "Kravspesifikasjon - Tabell 1, rad 2",
        text: "",
        kind: "docling_table_row",
        parser: "docling",
        page: 2,
        table_index: 1,
        row_index: 2,
        cells: {
          "ID / markering": "P123-003",
          Krav: requirementText,
          Prioritet: "Må",
        },
      },
    ],
  });

  const ledger = parsers.buildTrustedStructureMapRequirementLedger(
    document,
    testContext(),
  );

  assert.equal(ledger.length, 1);
  assert.deepEqual(
    {
      id: ledger[0].id,
      text: ledger[0].text,
      pages: ledger[0].pages,
      tableId: ledger[0].tableId,
      heading: ledger[0].heading,
    },
    {
      id: "P123-003",
      text: requirementText,
      pages: [2],
      tableId: "Docling tabell 1",
      heading: "Kravspesifikasjon - Tabell 1, rad 2",
    },
  );
  assert.ok(ledger[0].documentEntryOrder < 1_000_000);
});

test("trusted structure-map parser ignores document metadata when choosing a heading", () => {
  const requirementText = "Leverandøren skal dokumentere beredskap.";
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P123",
      "Prioritert kravtabell",
      requirementText,
    ].join("\n"),
    structureMap: [
      {
        reference: "Innledning",
        text: [
          "Bilag 2 - Kravspesifikasjon",
          "Kunde: Eksempelkunden",
          "Prosjektkode: P123",
          "Prioritert kravtabell",
          "Denne delen kombinerer tabellrader, notater og punkter fra workshop.",
        ].join("\n"),
        kind: "paragraph",
        parser: "docx-xml",
      },
      {
        reference: "Kravspesifikasjon - Tabell 1, rad 2",
        text: requirementText,
        kind: "table",
        parser: "docx-xml",
        page: 1,
        table_index: 1,
        row_index: 2,
        cells: {
          "ID / markering": "FUN-02",
          Krav: requirementText,
          Prioritet: "Må",
        },
      },
    ],
  });

  const ledger = parsers.buildTrustedStructureMapRequirementLedger(
    document,
    testContext(),
  );

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].heading, "Prioritert kravtabell");
});

test("legacy structured-row gate and generated flattened-table guard stay explicit", () => {
  const document = projectDocument({
    rawText: "Bilag 2 - Krav og føringer\nKrav/føring",
    structureMap: [
      {
        reference: "Tabell 1, rad 2",
        text: "",
        kind: "table",
        parser: "docx-xml",
        row_index: 2,
        cells: {
          "Krav/føring": "Leverandøren skal dokumentere SLA.",
        },
      },
    ],
  });

  assert.equal(
    parsers.hasLegacyKravFeringStructuredRows(document, testContext()),
    true,
  );
  assert.equal(
    parsers.isGeneratedFlattenedTableDump({
      id: "dump",
      text: "Tabell 1 Rad 1: ID / markering | krav | Må | Kommentar Rad 2: Leverandøren skal svare",
      pages: [],
      heading: "",
    }),
    true,
  );
  assert.equal(
    parsers.isGeneratedFlattenedTableDump({
      id: "false-row",
      text:
        "Tabell 3 Rad 1: ID/markering | Prioritet | Kravtekst | leverandørens svar | Rad 2: 001/01 | Må | Kunden skal kunne eksportere data |",
      pages: [],
      heading: "",
    }),
    true,
  );
  assert.equal(
    parsers.isGeneratedFlattenedTableDump({
      id: "KR-017",
      text: "| Det skal være mulig å følge status på saker. | Må | Gjelder produksjonsløsning",
      pages: [],
      heading: "",
    }),
    true,
  );
});

test("legacy mixed docx ledger keeps paragraph and table rows in source order", async () => {
  const firstRequirement =
    "Det skal være mulig å eksportere relevante data om applikasjonsdrift ved revisjon eller kontraktsslutt.";
  const secondRequirement =
    "Det skal finnes dokumentert prosess for applikasjonsdrift, inkludert ansvar, eskalering og kontrollpunkter.";
  const thirdRequirement =
    "Leverandøren må beskrive hvordan nettverk ivaretas ved normal drift og ved avvik.";
  const fourthRequirement =
    "Alle endringer knyttet til tilgjengelighet skal kunne spores til bruker, tidspunkt og formål.";
  const fifthRequirement =
    "Det må etableres testopplegg for nettverk før produksjonssetting.";
  const tableRequirement =
    "Løsningen må håndtere brukerstøtte uten at kunden mister kontroll på tydelig rollemodell og tilgangsstyring.";
  const nextTableRequirement =
    "Det må etableres testopplegg for dataplattform før produksjonssetting.";
  const afterTableRequirement =
    "Leverandøren må beskrive hvordan rapportering ivaretas ved normal drift og ved avvik.";
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Krav og føringer",
      "Kravene under er samlet fra behovsmøter.",
      `R1 - ${firstRequirement}`,
      `R2 - ${secondRequirement}`,
      `— - ${thirdRequirement}`,
      `obs: ${fourthRequirement}`,
      `R5 - ${fifthRequirement}`,
      "Leverandøren må selv foreslå hvordan punktene over dokumenteres i tilbudet.",
      "Tabell 1",
      "Rad 1: Markering | Område/type | Krav/føring | Kommentar",
      `Rad 2: R6 | Tekstkrav | ${tableRequirement} | Må besvares`,
      `Rad 3: R7 | Tekstkrav | ${nextTableRequirement} | Må besvares`,
      `R8 - ${afterTableRequirement}`,
    ].join("\n"),
    structureMap: [
      {
        reference: "Støttedokument - tabell 1, rad 2",
        text: `Rad 2: R6 | Tekstkrav | ${tableRequirement} | Må besvares`,
        kind: "table",
        parser: "docx-xml",
        table_index: 1,
        row_index: 2,
        cells: {
          Markering: "R6",
          "Område/type": "Tekstkrav",
          "Krav/føring": tableRequirement,
          Kommentar: "Må besvares",
        },
      },
      {
        reference: "Støttedokument - tabell 1, rad 3",
        text: `Rad 3: R7 | Tekstkrav | ${nextTableRequirement} | Må besvares`,
        kind: "table",
        parser: "docx-xml",
        table_index: 1,
        row_index: 3,
        cells: {
          Markering: "R7",
          "Område/type": "Tekstkrav",
          "Krav/føring": nextTableRequirement,
          Kommentar: "Må besvares",
        },
      },
    ],
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.deepEqual(
    ledger.slice(0, 8).map((entry) => entry.text),
    [
      firstRequirement,
      secondRequirement,
      thirdRequirement,
      fourthRequirement,
      fifthRequirement,
      tableRequirement,
      nextTableRequirement,
      afterTableRequirement,
    ],
  );
  assert.equal(
    ledger.some((entry) =>
      /selv foreslå hvordan punktene over dokumenteres/i.test(entry.text),
    ),
    false,
  );
});

test("vurdering ledger sorting keeps explicit source order before reference order", () => {
  const sorted = sortRequirementLedgerInDocumentOrder([
    {
      id: "K-001",
      text: "Leverandøren skal beskrive andre krav.",
      pages: [1],
      heading: "Krav",
      tableId: "Tabell 1",
      sourceExcerpt: "Rad 3",
      documentEntryOrder: 3,
    },
    {
      id: "K-999",
      text: "Leverandøren skal beskrive første krav.",
      pages: [1],
      heading: "Krav",
      tableId: "Tabell 1",
      sourceExcerpt: "Rad 2",
      documentEntryOrder: 2,
    },
    {
      id: "K-000",
      text: "Leverandøren skal beskrive ukjent krav.",
      pages: [1],
      heading: "Krav",
      tableId: "Tabell 1",
      sourceExcerpt: "Rad 1",
    },
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["K-999", "K-001", "K-000"],
  );
});

test("vurdering ledger sorting does not let sparse source order outrank page order", () => {
  const sorted = sortRequirementLedgerInDocumentOrder([
    {
      id: "Driftsaktiviteter - OneNote",
      text: "Ressursene må kunne utføre enklere oppgaver på tenant-nivå.",
      pages: [15],
      heading: "Driftsaktiviteter",
      tableId: "Driftsaktiviteter",
      service: "OneNote",
      documentEntryOrder: 150_021,
    },
    {
      id: "ID 2-01",
      text: "Leverandøren blir ansvarlig for tilgjengelighet og sikkerhet.",
      pages: [6],
      heading: "Generelle krav til tilbudet",
    },
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["ID 2-01", "Driftsaktiviteter - OneNote"],
  );
});

test("vurdering ledger sorting keeps same-page compound IDs ordered when one source position is missing", () => {
  const sorted = sortRequirementLedgerInDocumentOrder([
    {
      id: "ID 2-23",
      text: "Leverandøren skal tilby konsulentbistand.",
      pages: [19],
      heading: "Konsulentbistand",
      documentEntryOrder: 190_019,
    },
    {
      id: "ID 2-22",
      text: "Leverandøren skal anskaffe og håndtere maskinutstyr.",
      pages: [19],
      heading: "Maskinutstyr",
    },
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["ID 2-22", "ID 2-23"],
  );
});

test("vurdering ledger sorting places a same-page table sequence before the following explicit ID", () => {
  const sorted = sortRequirementLedgerInDocumentOrder([
    {
      id: "ID 2-14",
      text: "Det skal tilbys stedlige ressurser.",
      pages: [15],
      heading: "Helpdesk",
      documentEntryOrder: 150_023,
    },
    {
      id: "Tabell ID 2-13 - Rapportering",
      text: "Aktiviteter skal rapporteres på ukentlige statusmøter.",
      pages: [15],
      heading: "Driftsaktiviteter",
      tableId: "Tabell ID 2-13",
      service: "Rapportering",
    },
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["Tabell ID 2-13 - Rapportering", "ID 2-14"],
  );
});

test("vurdering ledger sorting keeps page-local explicit IDs before later table IDs", () => {
  const sorted = sortRequirementLedgerInDocumentOrder([
    {
      id: "Tabell ID 2-31 - Ivareta",
      text: "Leverandøren skal ivareta informasjons- og IT-sikkerhet.",
      pages: [24, 25],
      heading: "Informasjons- og IT-sikkerhet",
      tableId: "Tabell ID 2-31",
      service: "Ivareta",
    },
    {
      id: "ID 2-30",
      text: "Leverandøren skal sikre ekstern tilgang og fjernadministrasjon.",
      pages: [24],
      heading: "Generelt",
    },
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["ID 2-30", "Tabell ID 2-31 - Ivareta"],
  );
});

test("pdf page splitting accepts ranged Docling page markers", () => {
  assert.deepEqual(splitPdfPages("[[SIDE:12-14]]\nLeverandøren skal beskrive drift."), [
    {
      page: 12,
      pageEnd: 14,
      text: "Leverandøren skal beskrive drift.",
    },
  ]);
});

test("requirement id detection keeps compound ids and ignores standards tokens", () => {
  assert.deepEqual(
    productionDetectExplicitRequirementIds(
      "AUR-K01: Løsningen skal støtte ISO27001, AES256 og RFC5246.",
    ),
    ["AUR-K01"],
  );
});

test("legacy text repair preserves trailing deadline clauses", () => {
  assert.equal(
    parsers.repairLegacyFofingerTextArtifacts(
      "KRAV-1 Tekstkrav Leverandøren skal levere plan innen 30. juni",
    ),
    "Leverandøren skal levere plan innen 30. juni",
  );
});

test("vurdering ledger sorting compares document and entry order as tuple", () => {
  const sorted = sortRequirementLedgerInDocumentOrder([
    {
      id: "D1-K1",
      text: "Leverandøren skal beskrive krav fra dokument 1.",
      pages: [1],
      heading: "Krav",
      documentOrder: 1,
      documentEntryOrder: 1,
    },
    {
      id: "D0-K2M",
      text: "Leverandøren skal beskrive sent krav fra dokument 0.",
      pages: [1],
      heading: "Krav",
      documentOrder: 0,
      documentEntryOrder: 2_000_000,
    },
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["D0-K2M", "D1-K1"],
  );
});

test("generated structure-map rows inherit nearest section heading", async () => {
  const requirementText = "Leverandøren skal dokumentere tilgangsstyring.";
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      "Prosjektkode: P999",
      "Tilgang og roller - både faste og midlertidige brukere",
      "Krav registrert i tabell",
      `AUR-K01: ${requirementText}`,
    ].join("\n"),
    structureMap: [
      {
        reference: "Kundedokument - tekstblokk 1",
        text: "Tilgang og roller - både faste og midlertidige brukere\nKrav registrert i tabell",
      },
      {
        reference: "Kundedokument - tabell 2, rad 2",
        text: `Rad 2: AUR-K01 | Må | ${requirementText}`,
        kind: "table",
        parser: "docx-xml",
        table_index: 2,
        row_index: 2,
        cells: {
          "ID/markering": "AUR-K01",
          Prioritet: "Må",
          Kravtekst: requirementText,
        },
      },
    ],
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.equal(ledger[0]?.id, "AUR-K01");
  assert.equal(
    ledger[0]?.heading,
    "Tilgang og roller - både faste og midlertidige brukere",
  );
});

test("duplicate replacement keeps the earliest source position for vurdering order", async () => {
  const requirementText = "Leverandøren skal dokumentere logging for drift.";
  const document = projectDocument({
    rawText: [
      "Bilag 2 - Kravspesifikasjon",
      `Rad 2: K-100 | ${requirementText}`,
      `Rad 3: K-100 | ${requirementText}`,
    ].join("\n"),
    fileFormat: "docx",
    structureMap: [
      {
        reference: "Kravspesifikasjon - Tabell 1, rad 2",
        text: "",
        kind: "table",
        parser: "docx-xml",
        page: 1,
        table_index: 1,
        row_index: 2,
        cells: {
          "ID / markering": "K-100",
          Krav: requirementText,
        },
      },
      {
        reference: "Kravspesifikasjon - Tabell 1, rad 3",
        text: "",
        kind: "table",
        parser: "docx-xml",
        page: 1,
        table_index: 1,
        row_index: 3,
        cells: {
          "ID / markering": "K-100",
          Krav: requirementText,
          Tjeneste: "Logging",
          Svar: "Vi dekker dette med sentral loggplattform.",
        },
      },
    ],
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].id, "K-100");
  assert.equal(ledger[0].service, "Logging");
  assert.ok(ledger[0].documentEntryOrder < 1_000_000);
});

test("petoro answer-marker extraction binds IDs to text before answer field", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:6]]",
      "Generelle krav til tilbudet",
      "Leverandøren blir ansvarlig for tilgjengelighet, stabilitet, kapasitet og sikkerhet i levert løsning.",
      "Leverandørens besvarelse",
      "ID 2-",
      "02",
      "Leveransen skal organiseres slik at personell med tilgang til våre systemer og data ikke er lokalisert i, eller underlagt jurisdiksjon i, land som vurderes som risikoland.",
      "[[SIDE:7]]",
      "Kunden kan kreve at konsulenter som gis tilgang til Kundens informasjon og systemer som benyttes i Leveransen, gjennomgår bakgrunnssjekk,",
      "herunder identitetskontroll og sanksjonsscreening, i den utstrekning dette er saklig, nødvendig og i samsvar med gjeldende lovgivning.",
      "Leverandørens besvarelse",
      "ID 2-",
      "03",
      "Leverandøren skal etablere og vedlikeholde en dokumentasjon for Leveransen, som også skal være tilgjengelig for Kunden.",
      "Leverandørens besvarelse",
      "ID 2-",
      "04",
      "Leverandøren skal inkludere minst 3 referanser med kontaktdata som kjøper like eller tilsvarende tjenester som denne forespørsel dekker.",
      "Leverandørens besvarelse",
      "ID 2-",
      "05",
      "Leverandørens arbeid med samfunnsansvar og inkludering",
      "Leverandøren bes kort beskrive hvordan virksomheten jobber med samfunnsansvar.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));

  assert.match(byId.get("ID 2-02")?.text ?? "", /^Leverandøren blir ansvarlig/i);
  assert.match(
    byId.get("ID 2-03")?.text ?? "",
    /^Leveransen skal organiseres/i,
  );
  assert.match(
    byId.get("ID 2-03")?.text ?? "",
    /Kunden kan kreve at konsulenter/i,
  );
  assert.doesNotMatch(byId.get("ID 2-03")?.text ?? "", /^Leverandøren skal etablere/i);
  assert.equal(byId.get("ID 2-03")?.heading, "Generelle krav til tilbudet");
  assert.equal(byId.get("ID 2-04")?.heading, "Generelle krav til tilbudet");
  assert.match(byId.get("ID 2-04")?.text ?? "", /etablere og vedlikeholde/i);
});

test("petoro answer-marker repair keeps overgangsfasen IDs distinct", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:8]]",
      "Krav til drift",
      "Overgangsfasen",
      "Leverandøren skal overta det som kjører per i dag inkludert administrasjon av Microsoft365 lisensene.",
      "Leverandørens besvarelse",
      "ID2-",
      "07",
      "Driftsfasen",
      "Leverandøren skal levere en helhetlig Leveranse for drift.",
      "Leverandøren er herunder ansvarlig for åiverksette rutiner og løsninger som ivaretar kvalitet, sikkerhet og konfidensialitet.",
      "Leverandørens besvarelse",
      "ID2-",
      "08",
      "Det er per i dag underleverandører til eksisterende avtale, som forutsettes overtatt av nyLeverandør.",
      "Hvis noe av dette vurderes hensiktsmessig å bytte ut med andre løsninger kan leverandøren foreslå dette:",
      "• Ecit, leveranse av printløsning, (1 printer) som er en månedlig leieavtale alt inklusive.",
      "• Veeam sikkerhetskopiering",
      "• Microsoft med MS 365",
      "RA-1780BILAG2,4,6,7TILSSA-D2024",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));

  assert.match(byId.get("ID 2-07")?.text ?? "", /overta det som kjører per i dag/i);
  assert.match(byId.get("ID 2-08")?.text ?? "", /helhetlig leveranse for drift/i);
  assert.doesNotMatch(byId.get("ID 2-08")?.text ?? "", /underleverandører/i);
  assert.doesNotMatch(
    byId.get("ID 2-08")?.text ?? "",
    /overta det som kjører per i dag/i,
  );
  assert.doesNotMatch(byId.get("ID 2-08")?.text ?? "", /RA-1780/i);
});

test("petoro answer-marker repair preserves variable services requirement text", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:9]]",
      "Krav til drift",
      "Driftsaktiviteter",
      "• 2 stk.datalinjer",
      "• Diverse leverandører som leverer programvare eller annet under eksisterende avtale",
      "Leverandøren må klargjøre hvorvidt disse underleverandørene blir videreført eller om alternative løsninger blir tilbudt.",
      "Leverandørens besvarelse",
      "ID2-",
      "09",
      "Leverandøren må være tydelig på omLeveransen skal splittes i faste og variable tjenester.",
      "Dersom det er faste deler, skal omfanget og prisen for disse fremkomme i Bilag 7 Samlet pris og prisbestemmelser.",
      "Utover faste deler skal leverandøren estimere timer og kostnader for å levereLeveranseni tråd med kravene i forespørselen.",
      "Estimert pris inkludert timepriser for ulike kategorier konsulenter og estimerte timeforbruk skal legges inn i Bilag 7 Samlet pris og prisbestemmelser.",
      "Variable tjenester vil gjennomføres basert på timepriser eller annen form for variable prising.",
      "Noen av de variable tjenestene vil være gjenstand for tilbud og aksept for eksempel prosjekter.",
      "Leverandørens besvarelse",
      "ID2-",
      "10",
      "Driftsaktiviteter",
      "Følgende oppgaver som ikke er uttømmende, skal ivaretas i Leveransen.",
      "RA-1780BILAG2,4,6,7TILSSA-D2024",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));
  const id209 = byId.get("ID 2-09")?.text ?? "";
  const id210 = byId.get("ID 2-10")?.text ?? "";

  assert.match(id209, /underleverandørene blir videreført/i);
  assert.match(id210, /om leveransen skal splittes/i);
  assert.match(id210, /levere Leveransen i tråd/i);
  assert.match(id210, /Variable tjenester vil gjennomføres/i);
  assert.doesNotMatch(id210, /omLeveransen|levereLeveranseni|Leverandørens besvarelse|RA-1780/i);
  assert.doesNotMatch(id210, /RA-1780/i);
});

test("petoro answer-marker repair keeps ID 2-23, ID 2-24 and ID 2-25 text distinct", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:19]]",
      "Leverandøren skal tilby konsulentbistand for prosjekter og tjenester utenfor spesifisert Leveranse.",
      "Leverandørens besvarelse",
      "[[SIDE:20]]",
      "ID2-",
      "23",
      "Opsjoner",
      "Leverandøren skal tilby følgende opsjoner, som kan utløses av Petoro med 1 måneds skriftlig varsel.",
      "Priser for opsjonene følger av Bilag 7 Samlet pris og prisbestemmelser.",
      "Leverandørens besvarelse",
      "ID2-",
      "24",
      "Informasjons- og IT sikkerhet",
      "Generelt",
      "Kravene til Informasjons- og IT sikkerhet kan fremstå omfattende.",
      "Det stilles derfor strenge krav til en helhetlig informasjons- og IT sikkerhet.",
      "Leverandøren har ansvar for at Petoros krav til sikkerhet gjennomføres og følges opp inkludert implementering og oppfølging av eventuelle underleverandører.",
      "Leverandørens besvarelse",
      "ID2-",
      "25",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));

  assert.match(byId.get("ID 2-23")?.text ?? "", /konsulentbistand/i);
  assert.match(
    byId.get("ID 2-24")?.text ?? "",
    /tilby følgende opsjoner/i,
  );
  assert.match(
    byId.get("ID 2-25")?.text ?? "",
    /strenge krav til en helhetlig informasjons- og IT sikkerhet/i,
  );
  assert.doesNotMatch(byId.get("ID 2-24")?.text ?? "", /^Informasjons- og IT sikkerhet\b/i);
});

test("pdf service table keeps reporting, experience and termination rows", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:15]]",
      "Petoros krav - Tabell ID 2-13 Leverandørens svar",
      "Tjeneste Spesifiserte krav",
      "Rapportering Aktiviteter under applikasjonsforvaltning",
      "skal følges opp og rapporteres på",
      "ukentlige statusmøter.",
      "[[SIDE:24]]",
      "IT Sikkerhetskrav - Tabell ID 2-31 Leverandørens svar",
      "Tjeneste Spesifiserte krav",
      "Ivareta Leverandøren skal ha definerte roller som er ansvarlige for å påse at informasjons- og IT-sikkerheten blir ivaretatt i Leveransen.",
      "[[SIDE:25]]",
      "IT Sikkerhetskrav - Tabell ID 2-31 Leverandørens svar",
      "Tjeneste Spesifiserte krav",
      "Leverandøren skal ha fokus på forbedringer og skal foreslå forbedringer for å redusere risiko.",
      "Erfaring",
      "Leverandøren må beskrive relevante erfaring og kompetanse innenfor Informasjons- og IT sikkerhet.",
      "[[SIDE:29]]",
      "IT Sikkerhetskrav - Tabell ID 2-31 Leverandørens svar",
      "Tjeneste Spesifiserte krav",
      "Avslutning",
      "Ved avtaleperiodens utløp skal det beskrives hvordan sikker sletting av alle Kundens data blir utført i henhold til anerkjente standarder.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));

  assert.match(
    byId.get("Tabell ID 2-13 - Rapportering")?.text ?? "",
    /ukentlige statusmøter/i,
  );
  assert.match(
    byId.get("Tabell ID 2-31 - Erfaring")?.text ?? "",
    /relevante erfaring og kompetanse/i,
  );
  assert.match(
    byId.get("Tabell ID 2-31 - Avslutning")?.text ?? "",
    /sikker sletting/i,
  );
});

test("petoro answer-marker repair preserves valid pre-answer requirement text", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:24]]",
      "Leverandøren skal sikre at ekstern tilgang, fjernadministrasjon og administrative tilganger er teknisk og organisatorisk sikret.",
      "Leverandørens besvarelse",
      "ID2-",
      "30",
      "Informasjons- ogIT sikkerhet",
      "IT Sikkerhetskrav - Tabell ID 2-31 Leverandørens svar",
      "Del",
      "Tjeneste Spesifiserte krav Ja Nei Detaljeringer / presiseringer / krav til Petoro",
      "Ivareta",
      "Leverandøren skal ha definerte roller som er ansvarlige for å påse at informasjons- og IT-sikkerheten blir ivaretatt i Leveransen.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);
  const id230 = ledger.find((entry) => entry.id === "ID 2-30");

  assert.match(id230?.text ?? "", /^Leverandøren skal sikre at ekstern tilgang/i);
  assert.doesNotMatch(id230?.text ?? "", /^Informasjons- ogIT sikkerhet/i);
  assert.doesNotMatch(id230?.text ?? "", /Tjeneste Spesifiserte krav/i);
});

test("answer-marker extraction keeps subordinate requirement subject prose", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:58]]",
      "Kunden har et tydelig fokus på korrekt og effektiv bruk av samhandlingsverktøy.",
      "Det forventes derfor at Helpdesk-ressurser har solid kompetanse innen Microsoft-produktene som benyttes i organisasjonen, herunder spesielt Teams, SharePoint Online, OneDrive, Planner og OneNote.",
      "Det er videre ønskelig med noe kompetanse innen Power Automate og Copilot, og ressursene må kunne utføre enklere oppgaver på tenant-nivå.",
      "Leverandørens besvarelse",
      "ID2-",
      "14",
      "Leverandøren bekrefter at leveransen omfatter stedlige ressurser.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);
  const requirement = ledger.find((entry) => entry.id === "ID 2-14");

  assert.match(requirement?.text ?? "", /Helpdesk-ressurser har solid kompetanse/i);
  assert.match(requirement?.text ?? "", /Power Automate og Copilot/i);
  assert.match(requirement?.text ?? "", /tenant-nivå/i);
});

test("pdf service requirement table keeps page-continuation rows anchored to heading", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:7]]",
      "Driftsaktiviteter",
      "Følgende oppgaver inngår i tjenesten.",
      "Tjeneste Spesifiserte krav",
      "Feilhåndtering Leverandøren skal håndtere alle typer feil, herunder også koordinere og følge opp mot 3'dje partsleverandører.",
      "[[SIDE:8]]",
      "Tjeneste Spesifiserte krav",
      "Tredjeparts-",
      "leverandører Leverandøren skal koordinere support og drift for all tredjepartsprogramvare og løsninger som kjøres på servere og arbeidsstasjoner driftet av Leverandøren.",
      "Preventivt vedlikehold",
      "Tjeneste Spesifiserte krav",
      "Gjennomgang av logger Leverandøren skal foreta daglig gjennomgang av logger som alarmer, sikkerhetskopier, antivirus og øvrige systemlogger.",
      "Proaktivt vedlikehold Leverandøren skal foreta løpende vurdering av mulige maskin- og programvarefeil.",
      "Sikkerhets- og servicepatcher Leverandøren skal uten ugrunnet opphold foreta installasjon av service- og sikkerhetspatcher for maskinvare, programvare og databaser.",
      "Applikasjonsforvaltning",
      "Tjeneste Spesifiserte krav",
      "1. Applikasjonsforvaltning Leverandøren skal levere applikasjonsforvaltning for applikasjoner som inngår i leveransen.",
      "2. Sikkerhets- og servicepatcher Leverandøren skal utføre installasjon av sikkerhets- og servicepatcher for all programvare som inngår i leveransen.",
      "3. Feilretting Leverandøren skal foreta feilretting ved avvik i applikasjonene som inngår i leveransen.",
      "[[SIDE:9]]",
      "Tjeneste Spesifiserte krav",
      "Ved gjentatte feil skal Leverandøren foreslå varige tiltak for å hindre nye avvik.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));
  const thirdParty = byId.get("Driftsaktiviteter - Tredjeparts-leverandører");
  const correction = byId.get("Driftsaktiviteter - Feilretting");

  assert.ok(thirdParty);
  assert.equal(thirdParty.tableId, "Driftsaktiviteter");
  assert.deepEqual(thirdParty.pages, [8]);
  assert.match(thirdParty.text, /tredjepartsprogramvare/i);
  assert.match(thirdParty.text, /arbeidsstasjoner/i);
  assert.ok(byId.has("Driftsaktiviteter - Gjennomgang av logger"));
  assert.ok(byId.has("Driftsaktiviteter - Applikasjonsforvaltning"));
  assert.ok(byId.has("Driftsaktiviteter - Sikkerhets- og servicepatcher"));
  assert.ok(
    byId.has(
      "Driftsaktiviteter - Applikasjonsforvaltning - Sikkerhets- og servicepatcher",
    ),
  );
  assert.ok(correction);
  assert.deepEqual(correction.pages, [8, 9]);
  assert.match(correction.text, /varige tiltak for å hindre nye avvik/i);
  assert.doesNotMatch(correction.text, /underliggende problemer/i);
  assert.equal(
    ledger.some((entry) => /^Side\s+8\s+krav\s+\d+$/i.test(entry.id)),
    false,
  );
  assert.equal(
    ledger.some((entry) => /^krav\s+1$/i.test(entry.id)),
    false,
  );
  assert.equal(new Set(ledger.map((entry) => entry.id)).size, ledger.length);
});

test("noncanonical PDF service tables keep standalone requirement rows without a better candidate", async () => {
  const requirements = [
    "Det er videre ønskelig med noe kompetanse innen Power Automate og Copilot, og ressursene må kunne utføre enklere oppgaver på tenant-nivå.",
    "Leverandøren skal levere ukentlig statusrapport.",
  ];

  for (const requirementText of requirements) {
    const document = projectDocument({
      fileFormat: "pdf",
      rawText: [
        "[[SIDE:1]]",
        "Kompetanse",
        "Tjeneste Spesifiserte krav",
        `Fagkompetanse ${requirementText}`,
      ].join("\n"),
    });
    const ledger = await extractRequirementLedgerForDocument(document);

    assert.equal(ledger.length, 1, requirementText);
    assert.equal(ledger[0]?.text, requirementText);
  }
});

test("PDF duplicate filtering stays indexed for large canonical tables", () => {
  const entries = Array.from({ length: 1_000 }, (_, index) => {
    const tableId = `Tabell ID ${Math.floor(index / 999) + 1}-${(index % 999) + 1}`;
    return {
      id: `${tableId} - Tjeneste ${index + 1}`,
      tableId,
      service: `Tjeneste ${index + 1}`,
      text: `Leverandøren skal dokumentere unik kontroll ${index + 1} med revisjonslogg og sporbarhet.`,
      pages: [1],
      heading: "Kravtabell",
    };
  });
  const startedAt = performance.now();
  const filtered = filterPdfTableDuplicateExtractionArtifacts(entries);
  const durationMs = performance.now() - startedAt;

  assert.equal(filtered.length, entries.length);
  assert.ok(
    durationMs < 2_000,
    `indexed PDF filtering took ${durationMs.toFixed(1)}ms`,
  );
});

test("pdf service table dedupes hyphen-equivalent duplicate service rows", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:33]]",
      "Informasjons- og IT sikkerhet",
      "IT Sikkerhetskrav - Tabell ID 2-32",
      "Tjeneste Spesifiserte krav",
      "Sikkerhetsovervåking Leverandøren skal beskrive prosess for leveranse av sikkerhetsovervåking. Hvis det tilbys en SOC skal denne beskrives.",
      "Sikkerhets-overvåking Leverandøren skal beskrive prosess for leveranse av en sikkerhetsovervåking. Hvis det tilbys en SOC skal denne beskrives.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].id, "Tabell ID 2-32 - Sikkerhetsovervåking");
  assert.equal(ledger[0].tableId, "Tabell ID 2-32");
  assert.equal(ledger[0].service, "Sikkerhetsovervåking");
});

test("pdf flattened service-table header does not become bare krav id", async () => {
  const document = projectDocument({
    fileFormat: "pdf",
    rawText: [
      "[[SIDE:8]]",
      "Applikasjonsforvaltning Tjeneste Spesifiserte krav 1. Applikasjonsforvaltning Leverandøren skal levere applikasjonsforvaltning for applikasjoner som inngår i leveransen.",
      "[[SIDE:9]]",
      "Tjeneste Spesifiserte krav Ved gjentatte feil skal Leverandøren foreslå varige tiltak for å hindre nye avvik.",
    ].join("\n"),
  });

  const ledger = await extractRequirementLedgerForDocument(document);

  assert.equal(
    ledger.some((entry) => /^krav\s+1$/i.test(entry.id)),
    false,
  );
  assert.equal(
    ledger.some(
      (entry) => !entry.tableId && entry.pages.length > 1 && /Applikasjonsforvaltning/i.test(entry.text),
    ),
    false,
  );
});
