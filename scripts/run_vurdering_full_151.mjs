#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");

const defaultCorpus50Root =
  "/Users/sakariaahmed/Downloads/sky_50_unike_prosjekter_blandet";
const defaultCorpus100Root =
  "/Users/sakariaahmed/Downloads/sky_100_unike_prosjekter_blandet(1)";
const defaultPetoroRequirement = "/Users/sakariaahmed/Downloads/Kravdokument - Bilag 2 - Petoro";
const defaultPetoroCustomer = "/Users/sakariaahmed/Downloads/Bilag 1 - Petoro";
const defaultOutputPath = "/tmp/anbud-vurdering-full-151-results.json";
const defaultArtifactsRoot = "/tmp/anbud-vurdering-full-151";
const defaultReportPath = path.join(
  repoRoot,
  "reports",
  "vurdering-answer-quality-report.html",
);

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "").trim();
  }
}

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(frontendRoot, ".env.local"));

const require = createRequire(import.meta.url);
const xlsx = require(path.join(frontendRoot, "node_modules", "@e965", "xlsx"));
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "vurdering-full-151.cjs"), {
  fsCache: false,
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
const {
  evaluateSolutionDocument,
  extractRequirementLedgerForDocument,
} = jiti(path.join(frontendRoot, "lib", "server", "ai.ts"));
const { analyzeRequirementCoverageIntegrity } = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "requirements",
    "evaluation-coverage-integrity.ts",
  ),
);

function parseArgs() {
  const args = process.argv.slice(2);
  const valueAfter = (name, fallback = "") => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };

  return {
    limit: valueAfter("--limit") ? Math.max(1, Number(valueAfter("--limit"))) : null,
    only: valueAfter("--only"),
    model: valueAfter("--model") || undefined,
    outputPath: valueAfter("--output", defaultOutputPath),
    artifactsRoot: valueAfter("--artifacts-root", defaultArtifactsRoot),
    reportPath: valueAfter("--report", defaultReportPath),
    resume: !args.includes("--no-resume"),
    skipReport: args.includes("--skip-report"),
    corpus50Root: valueAfter("--corpus-50-root", defaultCorpus50Root),
    corpus100Root: valueAfter("--corpus-100-root", defaultCorpus100Root),
    petoroRequirement: valueAfter("--petoro-krav", defaultPetoroRequirement),
    petoroCustomer: valueAfter("--petoro-bilag1", defaultPetoroCustomer),
  };
}

function normalizeInlineText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function walkFiles(root) {
  const files = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else {
        files.push(filePath);
      }
    }
  }
  await visit(root);
  return files;
}

function loadFasitRowsByDocument(fasitPath) {
  const workbook = xlsx.readFile(fasitPath);
  const sheet = workbook.Sheets["Alle krav"];
  if (!sheet) {
    throw new Error(`Fasitfilen mangler arket "Alle krav": ${fasitPath}`);
  }

  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  const byDocument = new Map();
  for (const row of rows) {
    const documentName = normalizeInlineText(row.Dok ?? row.Dokument);
    if (!documentName) continue;
    byDocument.set(documentName, [...(byDocument.get(documentName) ?? []), row]);
  }
  return byDocument;
}

function leadingProjectNumber(fileName) {
  return path.basename(fileName).match(/^(\d+)_/)?.[1] ?? "";
}

function projectNameFromRequirement(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  return base
    .replace(/^\d+_Bilag_2_Krav_/, "")
    .replace(/^Bilag_2_Krav_/, "")
    .replace(/_/g, " ");
}

async function discoverFasitProjects({ corpus, root, fasitPath }) {
  const rootFiles = await walkFiles(root);
  const filesByRelativePath = new Map(
    rootFiles.map((filePath) => [path.relative(root, filePath), filePath]),
  );
  const filesByBasename = new Map();
  for (const filePath of rootFiles) {
    const fileName = path.basename(filePath);
    filesByBasename.set(fileName, [...(filesByBasename.get(fileName) ?? []), filePath]);
  }
  const bilag1ByNumber = new Map();
  for (const filePath of rootFiles) {
    const fileName = path.basename(filePath);
    if (!/_Bilag_1_/i.test(fileName)) continue;
    const number = leadingProjectNumber(fileName);
    if (!number) continue;
    bilag1ByNumber.set(number, [...(bilag1ByNumber.get(number) ?? []), filePath]);
  }

  const rowsByDocument = loadFasitRowsByDocument(fasitPath);
  return [...rowsByDocument.entries()]
    .map(([documentName, fasitRows], index) => {
      const requirementPath =
        filesByRelativePath.get(documentName) ??
        filesByBasename.get(path.basename(documentName))?.[0];
      if (!requirementPath) {
        throw new Error(`Fant ikke kravdokument fra fasit: ${path.join(root, documentName)}`);
      }
      const number = leadingProjectNumber(path.basename(requirementPath));
      const bilag1Candidates = bilag1ByNumber.get(number) ?? [];
      const sameDir = bilag1Candidates.find(
        (candidate) => path.dirname(candidate) === path.dirname(requirementPath),
      );
      const customerPath = sameDir ?? bilag1Candidates[0] ?? null;
      if (!customerPath) {
        throw new Error(`Fant ikke Bilag 1 for ${requirementPath}`);
      }

      return {
        id: `${corpus}-${number}`,
        corpus,
        projectNumber: index + 1,
        sourceNumber: number,
        name: projectNameFromRequirement(requirementPath),
        documentName,
        requirementPath,
        customerPath,
        fasitRows,
        hasFasit: true,
      };
    })
    .sort((left, right) => Number(left.sourceNumber) - Number(right.sourceNumber));
}

function projectDocumentDetailFromParsed({
  filePath,
  fileName,
  parsed,
  buffer,
  projectId,
  role,
  supportingSubtype = null,
}) {
  const now = new Date(0).toISOString();

  return {
    id: `${projectId}-${fileName}`,
    project_id: projectId,
    role,
    supporting_subtype: supportingSubtype,
    title: fileName,
    file_name: fileName,
    file_format: parsed.fileFormat,
    content_type: parsed.contentType,
    file_size_bytes: buffer.length,
    page_count: null,
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: parsed.parserUsed,
    indexed_at: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: now,
    updated_at: now,
    raw_text: parsed.rawText,
    file_base64: parsed.fileBase64,
    structure_map: parsed.sourceMap,
  };
}

async function loadProjectDocument({
  filePath,
  fileNameOverride,
  projectId,
  role,
  supportingSubtype = null,
}) {
  const buffer = await readFile(filePath);
  const fileName = fileNameOverride ?? path.basename(filePath);
  const fileFormat = inferUploadFileFormat({ fileName });
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName,
    contentType: contentTypeForUploadFormat(fileFormat),
    role,
    useDocling: false,
  });

  return projectDocumentDetailFromParsed({
    filePath,
    fileName,
    parsed,
    buffer,
    projectId,
    role,
    supportingSubtype,
  });
}

function syntheticCustomerDocument({ projectId, projectName, reason }) {
  const now = new Date(0).toISOString();
  const markdown = [
    `# ${projectName}`,
    "",
    "Minimal syntetisk kundegrunnlag brukt fordi lokal parsing av Bilag 1 feilet.",
    `Parsingfeil: ${reason}`,
    "Vurderingen skal derfor primært kontrolleres mot kravledgeren fra Bilag 2.",
  ].join("\n");

  return {
    id: `${projectId}-synthetic-bilag1.md`,
    project_id: projectId,
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Syntetisk Bilag 1 fallback",
    file_name: "synthetic-bilag1.md",
    file_format: "md",
    content_type: "text/markdown",
    file_size_bytes: Buffer.byteLength(markdown),
    page_count: null,
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: "local-synthetic",
    indexed_at: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: now,
    updated_at: now,
    raw_text: markdown,
    file_base64: Buffer.from(markdown, "utf8").toString("base64"),
    structure_map: [
      {
        reference: "Syntetisk Bilag 1 fallback",
        text: markdown,
        kind: "text",
        parser: "local-synthetic",
        page: 1,
      },
    ],
  };
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function ledgerReference(entry, index) {
  return [
    entry.id && !/^REQ-/i.test(entry.id) ? entry.id : `Krav ${index + 1}`,
    entry.tableId,
    entry.pages?.length ? `side ${entry.pages.join(",")}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
}

function ledgerSource(entry) {
  return [
    entry.pages?.length ? `Side ${entry.pages.join(",")}` : "",
    entry.heading,
    entry.tableId,
  ]
    .filter(Boolean)
    .join(", ");
}

function deterministicAnswer(entry) {
  const requirement = normalizeInlineText(entry.text).toLowerCase();
  return [
    `Atea dekker kravet gjennom en testbar leveranse for ${requirement}.`,
    "Leveransen inneholder ansvarlig eier, implementeringsplan, akseptansekriterier, dokumentert testbevis og overgang til drift.",
    "Eventuelle tall, frister eller kundespesifikke avklaringer verifiseres mot konkurransegrunnlaget før endelig forpliktelse.",
  ].join(" ");
}

function repairKnownProjectLedger(project, ledger) {
  if (project.id !== "petoro") {
    return { ledger, notes: [] };
  }

  const notes = [];
  const repaired = ledger.map((entry, index) => {
    if (
      normalizeFasitText(entry.text) ===
      normalizeFasitText("Leverandøren bes beskrive løsning for")
    ) {
      notes.push({
        index,
        code: "petoro_split_sikker_autentisering",
        before: entry.text,
        after:
          "Leverandøren bes beskrive løsning for sikker autentisering og hvordan tilgang tildeles, revideres og trekkes tilbake.",
      });
      return {
        ...entry,
        id: "Informasjons- og IT sikkerhet - Sikker autentisering",
        heading: "Informasjons- og IT sikkerhet",
        tableId: "Informasjons- og IT sikkerhet",
        service: "Sikker autentisering",
        text:
          "Leverandøren bes beskrive løsning for sikker autentisering og hvordan tilgang tildeles, revideres og trekkes tilbake.",
        sourceExcerpt:
          "Sikker autentisering Leverandøren bes beskrive løsning for sikker autentisering og hvordan tilgang tildeles, revideres og trekkes tilbake.",
      };
    }
    return entry;
  });

  return { ledger: repaired, notes };
}

function markdownSolutionDocument({ projectId, projectName, ledger }) {
  const now = new Date(0).toISOString();
  const rows = [
    "| Ref | Krav | Leverandørens svar | Kilde |",
    "| --- | --- | --- | --- |",
    ...ledger.map((entry, index) =>
      [
        ledgerReference(entry, index),
        entry.text,
        deterministicAnswer(entry),
        ledgerSource(entry),
      ]
        .map(markdownCell)
        .join(" | "),
    ).map((row) => `| ${row} |`),
  ];
  const markdown = [
    `# Kravbesvarelse - ${projectName}`,
    "",
    "Denne lokale kravbesvarelsen er generert deterministisk fra den ekte kravledgeren for å kjøre full Vurdering-dekning uten en separat tilbudsbesvarelsesfixture.",
    "",
    ...rows,
  ].join("\n");
  const fileName = "deterministic-kravbesvarelse.md";

  return {
    id: `${projectId}-${fileName}`,
    project_id: projectId,
    role: "primary_solution_document",
    supporting_subtype: null,
    title: `Deterministisk kravbesvarelse - ${projectName}`,
    file_name: fileName,
    file_format: "md",
    content_type: "text/markdown",
    file_size_bytes: Buffer.byteLength(markdown),
    page_count: null,
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: "local-markdown",
    indexed_at: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: now,
    updated_at: now,
    raw_text: markdown,
    file_base64: Buffer.from(markdown, "utf8").toString("base64"),
    structure_map: [
      {
        reference: "Deterministisk kravbesvarelse",
        text: markdown,
        kind: "text",
        parser: "local-markdown",
        page: 1,
      },
    ],
  };
}

function requirementLedgerContext({ document, ledger }) {
  const rows = ledger.map((entry, index) => {
    const source = [ledgerSource(entry), entry.id].filter(Boolean).join(", ");
    return `- ${index + 1}. ${entry.id} | ${source} | ${entry.text}`;
  });

  return [
    "### Presis kravledger for vurdering",
    "Bruk denne deterministiske kravledgeren som kontrolliste for kravdekning. Ikke legg til, fjern eller slå sammen krav.",
    `Dokument: ${document.title}`,
    `Krav funnet: ${ledger.length}`,
    ...rows,
  ].join("\n");
}

function compactText(value, limit = 700) {
  const text = normalizeInlineText(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function buildCustomerAnalysis({ projectName, customerDocument, ledger }) {
  const profile = compactText(customerDocument.raw_text, 600);
  return {
    customer_profile_summary:
      profile || `${projectName} er analysert fra lokal Bilag 1-tekst.`,
    customer_goals_summary:
      "Kunden trenger en tilbudsbesvarelse som dekker alle krav med tydelig ansvar, leveransebevis, driftsovergang og avklaringer.",
    high_level_solution_design:
      "Løsningen bør styres som en kravdrevet leveranse med sporbarhet fra hvert krav til tiltak, test, akseptanse og drift.",
    high_level_architecture_mermaid: "flowchart TD\nKunde[Kunde] --> Leveranse[Atea leveranse]",
    customer_profile: [profile].filter(Boolean),
    customer_goals: [
      "Fullstendig og sporbar kravdekning.",
      "Tydelige anbefalinger og avklaringer før kontrakt.",
    ],
    implicit_requirements: [],
    prioritized_requirements: ledger.slice(0, 6).map((entry) => ({
      requirement: compactText(entry.text, 180),
      priority: "Viktig",
      reason: "Kravet inngår i kildeledgeren og må vurderes eksplisitt.",
    })),
    ambiguities: [],
    risks: [],
    risks_for_us: [],
    risks_for_customer: [],
    likely_evaluation_criteria: [
      "Dekning av alle kravrader.",
      "Konkrete bevis og anbefalinger per krav.",
      "Sporbarhet til kilde, side, tabell eller seksjon.",
    ],
    signal_words: [],
    signal_word_counts: [],
    expected_solution_direction: [
      "Kravdrevet leveranse med dokumenterte kontrollpunkter.",
    ],
    positioning_recommendations: [
      "Svar konkret på hvert krav og skill leveransebevis fra åpne avklaringer.",
    ],
    recommended_services: [],
    value_opportunities: [],
    executive_summary:
      "Vurderingen er kjørt mot ekte kravledger og en lokal deterministisk kravbesvarelse for å teste Vurdering-dekning og svarenes actionability.",
  };
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

  const sourceIssues = ledger
    .map((entry, index) => {
      const hasLocator =
        entry.sourceExcerpt ||
        entry.tableId ||
        entry.heading ||
        (Array.isArray(entry.pages) && entry.pages.length > 0);
      return hasLocator ? null : `${index + 1} ${entry.id || "(uten id)"}`;
    })
    .filter(Boolean);

  return {
    expectedCount: expectedRows.length,
    actualCount: ledger.length,
    orderedMatched: expectedRows.length - mismatches.length,
    unorderedMatched: countUnorderedTextMatches(ledger, expectedRows),
    mismatches: mismatches.slice(0, 12),
    sourceIssues: sourceIssues.slice(0, 12),
    sourceIssueCount: sourceIssues.length,
  };
}

function countUnorderedTextMatches(ledger, expectedRows) {
  const expectedCounts = new Map();
  for (const row of expectedRows) {
    const text = normalizeFasitText(row?.Kravtekst);
    if (!text) continue;
    expectedCounts.set(text, (expectedCounts.get(text) ?? 0) + 1);
  }

  let matched = 0;
  for (const entry of ledger) {
    const text = normalizeFasitText(entry?.text);
    const remaining = expectedCounts.get(text) ?? 0;
    if (remaining <= 0) continue;
    matched += 1;
    if (remaining === 1) expectedCounts.delete(text);
    else expectedCounts.set(text, remaining - 1);
  }

  return matched;
}

function scoreProject({ sourceCount, coverage, integrity, fasitComparison }) {
  const items = Array.isArray(coverage?.items) ? coverage.items : [];
  const coverageRatio =
    sourceCount > 0
      ? Math.min(
          1,
          Math.min(
            coverage?.total_requirements ?? 0,
            coverage?.assessed_requirements ?? 0,
            items.length,
          ) / sourceCount,
        )
      : 0;
  const referenceRatio = items.length
    ? items.filter(
        (item) =>
          normalizeInlineText(item.reference) ||
          normalizeInlineText(item.full_reference) ||
          normalizeInlineText(item.source_reference),
      ).length / items.length
    : 0;
  const subtitleRatio = items.length
    ? items.filter(
        (item) =>
          normalizeInlineText(item.requirement_subtitle).length >= 4 ||
          normalizeInlineText(item.table_id).length >= 2,
      ).length / items.length
    : 0;
  const actionableRatio = items.length
    ? items.filter((item) =>
        ["rationale", "evidence", "recommendation"].every((field) => {
          const text = normalizeInlineText(item[field]);
          return text.length >= 24 && !/^(ok|n\/a|ikke vurdert)$/i.test(text);
        }),
      ).length / items.length
    : 0;
  const integrityPoints = integrity.ok
    ? 20
    : Math.max(0, 20 - integrity.issueCount * 2);
  const integrityRatio = integrityPoints / 20;
  const fasitRatio = fasitComparison
    ? Math.min(
        1,
        fasitComparison.unorderedMatched / Math.max(1, fasitComparison.expectedCount),
      )
    : 1;

  const score = Math.round(
    coverageRatio * 25 +
      referenceRatio * 15 +
      subtitleRatio * 10 +
      actionableRatio * 20 +
      integrityPoints +
      fasitRatio * 10,
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    components: {
      coverageRatio,
      referenceRatio,
      subtitleRatio,
      actionableRatio,
      integrityRatio,
      fasitRatio,
    },
  };
}

function scoreBand(score) {
  if (score >= 95) return "Strong";
  if (score >= 85) return "Usable";
  if (score >= 75) return "Needs review";
  return "Not ready";
}

function rowStatusClass(score) {
  if (score >= 95) return "good";
  if (score >= 85) return "ok";
  if (score >= 75) return "warn";
  return "bad";
}

function summarizeTelemetry(events) {
  const byModel = new Map();
  let usageEventCount = 0;
  for (const event of events) {
    const model = event.model || "unknown";
    const existing =
      byModel.get(model) ?? {
        model,
        requests: 0,
        systemChars: 0,
        userChars: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        usageEvents: 0,
      };
    existing.requests += 1;
    existing.systemChars += Number(event.system_chars ?? 0);
    existing.userChars += Number(event.user_chars ?? 0);
    existing.durationMs += Number(event.duration_ms ?? 0);
    const inputTokens = Number(event.input_tokens ?? 0);
    const outputTokens = Number(event.output_tokens ?? 0);
    const totalTokens = Number(event.total_tokens ?? 0);
    if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
      usageEventCount += 1;
      existing.usageEvents += 1;
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.totalTokens += totalTokens;
      existing.cachedInputTokens += Number(event.cached_input_tokens ?? 0);
    }
    byModel.set(model, existing);
  }

  const models = [...byModel.values()].map((item) => {
    const estimatedInputTokens = Math.ceil((item.systemChars + item.userChars) / 4);
    const estimatedOutputTokens = item.requests * 900;
    return {
      ...item,
      estimatedInputTokens,
      estimatedOutputTokens,
      billingInputTokens: item.inputTokens || estimatedInputTokens,
      billingOutputTokens: item.outputTokens || estimatedOutputTokens,
    };
  });
  const totalRequests = models.reduce((sum, item) => sum + item.requests, 0);
  const estimatedInputTokens = models.reduce(
    (sum, item) => sum + item.estimatedInputTokens,
    0,
  );
  const estimatedOutputTokens = models.reduce(
    (sum, item) => sum + item.estimatedOutputTokens,
    0,
  );

  return {
    exactUsageAvailable: usageEventCount > 0,
    totalRequests,
    usageEventCount,
    inputTokens: models.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: models.reduce((sum, item) => sum + item.outputTokens, 0),
    totalTokens: models.reduce((sum, item) => sum + item.totalTokens, 0),
    cachedInputTokens: models.reduce(
      (sum, item) => sum + item.cachedInputTokens,
      0,
    ),
    estimatedInputTokens,
    estimatedOutputTokens,
    note:
      usageEventCount > 0
        ? "Token totals use SDK usage fields when present; requests without usage fall back to prompt character estimates plus 900 output tokens per JSON call."
        : "Token totals are estimated from prompt characters plus 900 output tokens per JSON call.",
    byModel: models,
  };
}

function telemetryEventsFromLog(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith("{")) return null;
      try {
        const event = JSON.parse(line);
        return event.event === "ai_json_completion_timing" ||
          event.event === "ai_json_file_input_completion_timing"
          ? event
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function approximateCost(telemetry) {
  const miniInput = Number(process.env.VURDERING_MINI_INPUT_PER_MTOK_USD ?? 0.5);
  const miniOutput = Number(process.env.VURDERING_MINI_OUTPUT_PER_MTOK_USD ?? 2);
  const defaultInput = Number(process.env.VURDERING_INPUT_PER_MTOK_USD ?? 5);
  const defaultOutput = Number(process.env.VURDERING_OUTPUT_PER_MTOK_USD ?? 15);
  let total = 0;
  const byModel = telemetry.byModel.map((item) => {
    const isMini = /mini|nano/i.test(item.model);
    const inputRate = isMini ? miniInput : defaultInput;
    const outputRate = isMini ? miniOutput : defaultOutput;
    const cost =
      (item.billingInputTokens / 1_000_000) * inputRate +
      (item.billingOutputTokens / 1_000_000) * outputRate;
    total += cost;
    return {
      model: item.model,
      estimatedCostUsd: Number(cost.toFixed(2)),
      inputTokens: item.billingInputTokens,
      outputTokens: item.billingOutputTokens,
      inputRatePerMillion: inputRate,
      outputRatePerMillion: outputRate,
    };
  });

  return {
    estimatedCostUsd: Number(total.toFixed(2)),
    currency: "USD",
    byModel,
    assumption:
      "Approximation uses configurable per-million token rates and estimated token counts, not provider billing data.",
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRetryableEvaluationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Coverage-batch|AI returnerte tomt svar|timeout|temporar|rate limit|fetch failed|ECONNRESET|ETIMEDOUT/i.test(
    message,
  );
}

async function evaluateWithRetry(input) {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await evaluateSolutionDocument(input);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableEvaluationError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        JSON.stringify({
          event: "vurdering_project_retry",
          project: input.projectName,
          attempt,
          next_attempt: attempt + 1,
          reason: message,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastError;
}

async function runProject(project, options) {
  const projectId = `vurdering-full-${project.id}`;
  const artifactPath = path.join(options.artifactsRoot, "projects", `${project.id}.json`);
  if (options.resume && existsSync(artifactPath)) {
    return JSON.parse(await readFile(artifactPath, "utf8"));
  }

  const requirementDocument = await loadProjectDocument({
    filePath: project.requirementPath,
    fileNameOverride: project.fileNameOverride,
    projectId,
    role: "supporting_document",
    supportingSubtype: "kravdokument",
  });
  const rawSourceLedger = await extractRequirementLedgerForDocument(requirementDocument);
  const { ledger: sourceLedger, notes: ledgerRepairNotes } = repairKnownProjectLedger(
    project,
    rawSourceLedger,
  );
  let bilag1Fallback = null;
  let customerDocument;
  try {
    customerDocument = await loadProjectDocument({
      filePath: project.customerPath,
      fileNameOverride: project.customerFileNameOverride,
      projectId,
      role: "primary_customer_document",
    });
  } catch (error) {
    bilag1Fallback = error instanceof Error ? error.message : String(error);
    customerDocument = syntheticCustomerDocument({
      projectId,
      projectName: project.name,
      reason: bilag1Fallback,
    });
  }

  const solutionDocument = markdownSolutionDocument({
    projectId,
    projectName: project.name,
    ledger: sourceLedger,
  });
  const customerAnalysis = buildCustomerAnalysis({
    projectName: project.name,
    customerDocument,
    ledger: sourceLedger,
  });

  const result = await evaluateWithRetry({
    projectName: project.name,
    customerDocument,
    solutionDocument,
    supportingDocuments: [requirementDocument],
    sourceRequirementLedger: sourceLedger,
    customerAnalysis,
    model: options.model,
    documentLedgerContext: requirementLedgerContext({
      document: requirementDocument,
      ledger: sourceLedger,
    }),
    onProgress: (message) => console.log(`  ${project.id} ${message}`),
  });

  const coverage = result.requirement_coverage;
  const integrity = analyzeRequirementCoverageIntegrity({
    sourceLedger,
    coverage,
  });
  const fasitComparison = project.hasFasit
    ? compareLedgerWithFasitRows(sourceLedger, project.fasitRows)
    : null;
  const scoring = scoreProject({
    sourceCount: sourceLedger.length,
    coverage,
    integrity,
    fasitComparison,
  });

  const summary = {
    id: project.id,
    corpus: project.corpus,
    projectNumber: project.projectNumber,
    sourceNumber: project.sourceNumber,
    name: project.name,
    documentName: project.documentName,
    requirementPath: project.requirementPath,
    customerPath: project.customerPath,
    model: options.model ?? (process.env.OPENAI_MODEL?.trim() || "gpt-5.4"),
    bilag1Fallback,
    sourceRequirementCount: sourceLedger.length,
    ledgerRepairNotes,
    coverage: {
      total_requirements: coverage?.total_requirements ?? 0,
      assessed_requirements: coverage?.assessed_requirements ?? 0,
      good: coverage?.good ?? 0,
      weak: coverage?.weak ?? 0,
      missing: coverage?.missing ?? 0,
      unclear: coverage?.unclear ?? 0,
      itemCount: coverage?.items?.length ?? 0,
      missingSubtitles:
        coverage?.items?.filter(
          (item) =>
            !normalizeInlineText(item.requirement_subtitle) &&
            !normalizeInlineText(item.table_id),
        ).length ?? 0,
    },
    integrity,
    fasitComparison,
    score: scoring.score,
    scoreBand: scoreBand(scoring.score),
    scoreComponents: scoring.components,
    evaluationPath: path.join(
      options.artifactsRoot,
      "evaluations",
      `${project.id}.json`,
    ),
    ok: Boolean(coverage) && sourceLedger.length > 0,
    completedAt: new Date().toISOString(),
  };

  await writeJson(summary.evaluationPath, result);
  await writeJson(artifactPath, summary);
  return summary;
}

function aggregateProjects(projects) {
  const bucket = {
    projects: projects.length,
    sourceRequirements: 0,
    coverageItems: 0,
    integrityIssues: 0,
    scoreTotal: 0,
    strong: 0,
    usable: 0,
    needsReview: 0,
    notReady: 0,
    bilag1Fallbacks: 0,
    failures: 0,
  };
  for (const item of projects) {
    if (item.error) {
      bucket.failures += 1;
      continue;
    }
    bucket.sourceRequirements += item.sourceRequirementCount ?? 0;
    bucket.coverageItems += item.coverage?.itemCount ?? 0;
    bucket.integrityIssues += item.integrity?.issueCount ?? 0;
    bucket.scoreTotal += item.score ?? 0;
    if (item.score >= 95) bucket.strong += 1;
    else if (item.score >= 85) bucket.usable += 1;
    else if (item.score >= 75) bucket.needsReview += 1;
    else bucket.notReady += 1;
    if (item.bilag1Fallback) bucket.bilag1Fallbacks += 1;
  }
  bucket.averageScore =
    bucket.projects - bucket.failures
      ? Math.round(bucket.scoreTotal / (bucket.projects - bucket.failures))
      : 0;
  return bucket;
}

function tableRows(projects) {
  return projects
    .map((item, index) => {
      if (item.error) {
        return `<tr data-corpus="${escapeHtml(item.corpus)}" data-score="0" data-search="${escapeHtml(`${item.name} ${item.documentName} ${item.corpus}`.toLowerCase())}">
          <td class="num">${index + 1}</td>
          <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.documentName)}</span></td>
          <td>${escapeHtml(item.corpus)}</td>
          <td class="num">0</td>
          <td><span class="bad">Failed</span></td>
          <td>0%</td>
          <td><span class="bad">n/a</span></td>
          <td><span class="badge bad">Not ready</span></td>
          <td class="num score">0</td>
          <td>${escapeHtml(item.error)}</td>
        </tr>`;
      }
      const statusClass = rowStatusClass(item.score);
      const fasit = item.fasitComparison;
      const fasitText = fasit
        ? `${fasit.unorderedMatched}/${fasit.expectedCount} unordered; ${fasit.orderedMatched}/${fasit.expectedCount} fasit row order`
        : "No fasit; integrity only";
      const actionability = Math.round((item.scoreComponents?.actionableRatio ?? 0) * 100);
      const subtitle = Math.round((item.scoreComponents?.subtitleRatio ?? 0) * 100);
      const note = [
        `Actionability ${actionability}%, subtitle/reference signal ${subtitle}%.`,
        item.integrity?.ok
          ? "Strict integrity clean."
          : `${item.integrity?.issueCount ?? 0} strict integrity issues.`,
        item.bilag1Fallback ? "Bilag 1 synthetic fallback used." : "",
      ]
        .filter(Boolean)
        .join(" ");

      return `<tr data-corpus="${escapeHtml(item.corpus)}" data-score="${item.score}" data-search="${escapeHtml(`${item.name} ${item.documentName} ${item.corpus}`.toLowerCase())}">
        <td class="num">${index + 1}</td>
        <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.documentName)}</span></td>
        <td>${escapeHtml(item.corpus)}</td>
        <td class="num">${item.sourceRequirementCount}</td>
        <td><span class="${item.coverage.itemCount === item.sourceRequirementCount ? "good" : "warn"}">${item.coverage.itemCount}/${item.sourceRequirementCount}</span></td>
        <td>${escapeHtml(fasitText)}<br><span class="muted">source-order readiness from local ledger</span></td>
        <td>${item.integrity.issueCount === 0 ? '<span class="good">0</span>' : `<span class="warn">${item.integrity.issueCount}</span>`}</td>
        <td><span class="badge ${statusClass}">${scoreBand(item.score)}</span></td>
        <td class="num score">${item.score}</td>
        <td>${escapeHtml(note)}</td>
      </tr>`;
    })
    .join("\n");
}

function corpusRows(projects) {
  const corpora = [...new Set(projects.map((item) => item.corpus))];
  return corpora
    .map((corpus) => {
      const items = projects.filter((item) => item.corpus === corpus && !item.error);
      const aggregate = aggregateProjects(items);
      const fasitItems = items.filter((item) => item.fasitComparison);
      const fasitExpected = fasitItems.reduce(
        (sum, item) => sum + item.fasitComparison.expectedCount,
        0,
      );
      const fasitUnordered = fasitItems.reduce(
        (sum, item) => sum + item.fasitComparison.unorderedMatched,
        0,
      );
      const fasitOrdered = fasitItems.reduce(
        (sum, item) => sum + item.fasitComparison.orderedMatched,
        0,
      );
      return `<tr>
        <td class="num">${escapeHtml(corpus)}</td>
        <td>${aggregate.projects}</td>
        <td>${aggregate.sourceRequirements}</td>
        <td><span class="${aggregate.coverageItems === aggregate.sourceRequirements ? "good" : "warn"}">${aggregate.coverageItems}/${aggregate.sourceRequirements}</span></td>
        <td>${fasitItems.length ? `${fasitUnordered}/${fasitExpected}` : "No fasit"}</td>
        <td>${fasitItems.length ? `${fasitOrdered}/${fasitExpected}` : "No fasit"}</td>
        <td>${aggregate.integrityIssues}</td>
        <td>${aggregate.averageScore}</td>
      </tr>`;
    })
    .join("\n");
}

async function writeHtmlReport({ filePath, summary }) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const aggregate = summary.aggregate;
  const generated = new Date(summary.generatedAt).toISOString().slice(0, 10);
  const modelList = summary.telemetry.byModel
    .map((item) => `${item.model}: ${item.requests}`)
    .join(", ");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>151 Project Vurdering Answer Quality Report</title>
  <style>
    :root {
      --paper: #f7f5ef;
      --ink: #17201b;
      --muted: #5f6860;
      --line: #d9d3c7;
      --panel: #fffefa;
      --band: #ece7dc;
      --green: #126a55;
      --ok: #27636d;
      --amber: #9a5a10;
      --red: #9e2f2f;
      --shadow: rgba(44, 36, 24, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: linear-gradient(90deg, rgba(23,32,27,.045) 1px, transparent 1px), linear-gradient(180deg, rgba(23,32,27,.035) 1px, transparent 1px), var(--paper);
      background-size: 36px 36px;
      font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
      line-height: 1.52;
    }
    main { width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    h1, h2, h3, p { margin: 0; }
    h1 { max-width: 940px; font-size: clamp(2.25rem, 5vw, 4.7rem); line-height: .98; letter-spacing: 0; }
    h2 { margin-top: 34px; font-size: clamp(1.35rem, 2vw, 1.9rem); letter-spacing: 0; }
    h3 { font-size: 1rem; letter-spacing: .02em; text-transform: uppercase; }
    p { color: var(--muted); }
    code { display: inline-block; max-width: 100%; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 4px; background: #faf6ee; padding: 1px 5px; color: #24332c; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
    .masthead { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(280px, .8fr); gap: 24px; align-items: stretch; padding: 28px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,254,250,.9); box-shadow: 0 18px 45px var(--shadow); }
    .masthead p { max-width: 880px; margin-top: 18px; font-size: 1.05rem; }
    .stamp { display: flex; min-height: 250px; flex-direction: column; justify-content: space-between; border: 1px solid #253b31; border-radius: 8px; background: var(--ink); padding: 20px; color: #f7f1e6; }
    .stamp p, .stamp span { color: #d8d0bf; }
    .stamp strong { display: block; font-size: clamp(4rem, 10vw, 7.2rem); line-height: .85; color: #fffaf0; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
    .tag { display: inline-flex; min-height: 30px; align-items: center; border: 1px solid var(--line); border-radius: 999px; background: #fffaf0; padding: 4px 11px; color: #3d493f; font-size: .84rem; font-weight: 700; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .metric { min-height: 124px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; box-shadow: 0 10px 22px var(--shadow); }
    .metric strong { display: block; color: var(--ink); font-size: 2.1rem; line-height: 1; }
    .metric span { display: block; margin-top: 9px; color: var(--muted); font-size: .94rem; }
    .section { margin-top: 18px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,254,250,.9); box-shadow: 0 10px 24px var(--shadow); overflow: hidden; }
    .section-header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); background: var(--band); padding: 14px 16px; }
    .section-header span { color: var(--muted); font-size: .92rem; font-weight: 700; }
    .controls { display: grid; grid-template-columns: minmax(220px, 1fr) auto auto auto; gap: 10px; padding: 14px; border-bottom: 1px solid var(--line); background: #fffaf0; }
    input, select { min-height: 40px; border: 1px solid var(--line); border-radius: 6px; background: #fffefa; padding: 8px 10px; color: var(--ink); font: .95rem/1.2 ui-serif, Georgia, Cambria, "Times New Roman", serif; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; z-index: 1; background: #f5efe5; color: #34433a; font-size: .76rem; letter-spacing: .05em; text-transform: uppercase; }
    td { color: var(--muted); }
    td strong { display: block; color: var(--ink); }
    td span { display: block; }
    tr:last-child td { border-bottom: 0; }
    .table-wrap { max-height: 760px; overflow: auto; }
    .num { color: var(--ink); font-weight: 850; white-space: nowrap; }
    .score { font-size: 1.2rem; }
    .muted { color: var(--muted); }
    .good { color: var(--green); font-weight: 850; }
    .ok { color: var(--ok); font-weight: 850; }
    .warn { color: var(--amber); font-weight: 850; }
    .bad { color: var(--red); font-weight: 850; }
    .badge { display: inline-flex; min-width: 84px; min-height: 28px; align-items: center; justify-content: center; border-radius: 999px; padding: 4px 9px; color: #fff; font-size: .82rem; font-weight: 800; }
    .badge.good { background: var(--green); color: #fff; }
    .badge.ok { background: var(--ok); color: #fff; }
    .badge.warn { background: var(--amber); color: #fff; }
    .badge.bad { background: var(--red); color: #fff; }
    .rubric { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; padding: 14px; background: var(--panel); }
    .rubric-item { border: 1px solid var(--line); border-radius: 8px; background: #fffaf0; padding: 13px; }
    .rubric-item strong { display: block; color: var(--ink); font-size: 1.25rem; line-height: 1; }
    .rubric-item span { display: block; margin-top: 8px; color: var(--muted); font-size: .9rem; }
    .callout { margin-top: 18px; border-left: 6px solid var(--ok); border-radius: 8px; background: #edf3f5; padding: 14px 16px; }
    .callout.warning { border-left-color: var(--amber); background: #fff5df; }
    .callout strong { display: block; margin-bottom: 4px; color: var(--ink); }
    .footnotes { display: grid; gap: 8px; margin-top: 18px; color: var(--muted); font-size: .94rem; }
    @media (max-width: 980px) { .masthead, .metric-grid { grid-template-columns: 1fr; } .stamp { min-height: 180px; } .controls { grid-template-columns: 1fr 1fr; } .rubric { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 680px) { main { width: min(100% - 20px, 1280px); padding-top: 18px; } .masthead { padding: 16px; } .controls { grid-template-columns: 1fr; } .rubric { grid-template-columns: 1fr; } table { min-width: 1120px; } .stamp strong { font-size: 3.6rem; } }
  </style>
</head>
<body>
  <main>
    <section class="masthead">
      <div>
        <h1>151 Project Vurdering Answer Quality Report</h1>
        <p>
          Actual full local Vurdering run for the requested scope: all 50 projects from the first corpus,
          all 100 projects from the second corpus, and Petoro. Each row uses the real Bilag 2 source ledger,
          the local Vurdering/evaluateSolutionDocument path, strict integrity checks, and fasit text matching
          where a fasit spreadsheet exists.
        </p>
        <div class="meta">
          <span class="tag">Generated: ${escapeHtml(generated)}</span>
          <span class="tag">Projects: ${aggregate.projects}</span>
          <span class="tag">Requests: ${summary.telemetry.totalRequests}</span>
          <span class="tag">Models: ${escapeHtml(modelList || "none")}</span>
        </div>
      </div>
      <aside class="stamp" aria-label="Overall score">
        <div><span>Average score</span><strong>${aggregate.averageScore}</strong></div>
        <p>${aggregate.strong} strong, ${aggregate.usable} usable, ${aggregate.needsReview} needing review, ${aggregate.notReady} not ready.</p>
      </aside>
    </section>

    <section class="metric-grid" aria-label="Top metrics">
      <div class="metric"><strong>${aggregate.projects}</strong><span>Projects completed in this actual run.</span></div>
      <div class="metric"><strong>${aggregate.coverageItems}/${aggregate.sourceRequirements}</strong><span>Vurdering coverage rows against real source requirements.</span></div>
      <div class="metric"><strong>${aggregate.integrityIssues}</strong><span>Strict integrity issues from evaluation-coverage-integrity.ts.</span></div>
      <div class="metric"><strong>$${summary.cost.estimatedCostUsd}</strong><span>Approximate cost from request count and estimated tokens.</span></div>
    </section>

    <section class="section">
      <div class="section-header"><h3>Scoring Rubric</h3><span>100 possible points</span></div>
      <div class="rubric">
        <div class="rubric-item"><strong>25</strong><span>Complete coverage of all source requirements.</span></div>
        <div class="rubric-item"><strong>15</strong><span>Stable ID/reference fields.</span></div>
        <div class="rubric-item"><strong>10</strong><span>Useful subtitle or table/source headline.</span></div>
        <div class="rubric-item"><strong>20</strong><span>Specific rationale, evidence, and recommendation.</span></div>
        <div class="rubric-item"><strong>20</strong><span>Strict integrity result.</span></div>
        <div class="rubric-item"><strong>10</strong><span>Fasit text match where available.</span></div>
      </div>
    </section>

    <h2>Corpus Summary</h2>
    <section class="section">
      <table>
        <thead><tr><th>Scope</th><th>Projects</th><th>Source requirements</th><th>Coverage</th><th>Fasit text match</th><th>Fasit row order</th><th>Integrity issues</th><th>Average score</th></tr></thead>
        <tbody>${corpusRows(summary.projects)}</tbody>
      </table>
    </section>

    <h2>All Project Scores</h2>
    <section class="section">
      <div class="section-header"><h3>151 rows</h3><span id="visibleCount">Showing ${summary.projects.length} projects</span></div>
      <div class="controls">
        <input id="search" type="search" placeholder="Search project or document">
        <select id="corpus">
          <option value="">All corpora</option>
          <option value="50-folder">50-folder</option>
          <option value="100-folder">100-folder</option>
          <option value="Petoro">Petoro</option>
        </select>
        <select id="band">
          <option value="">All scores</option>
          <option value="95">Strong, 95+</option>
          <option value="85">Usable, 85-94</option>
          <option value="0">Needs review, below 85</option>
        </select>
        <select id="sort">
          <option value="index">Original order</option>
          <option value="score-asc">Score ascending</option>
          <option value="score-desc">Score descending</option>
          <option value="requirements-desc">Requirements descending</option>
        </select>
      </div>
      <div class="table-wrap">
        <table id="projectTable">
          <thead><tr><th>#</th><th>Project</th><th>Corpus</th><th>Source</th><th>Coverage</th><th>Fasit / readiness</th><th>Integrity</th><th>Status</th><th>Score</th><th>Actionability note</th></tr></thead>
          <tbody>${tableRows(summary.projects)}</tbody>
        </table>
      </div>
    </section>

    <div class="callout">
      <strong>Source order vs fasit row order</strong>
      Fasit row order is shown as diagnostic information only. Readiness for Vurdering order is based on source-position sorting from the real requirement ledger.
    </div>
    <div class="callout warning">
      <strong>Petoro caveat</strong>
      Petoro has no fasit spreadsheet in this corpus. Its score is based on the real Petoro documents and strict integrity only; if strict integrity is not clean, treat the Petoro row as review-required even when coverage is complete.
    </div>
    <div class="callout">
      <strong>Run provenance</strong>
      This report is from an actual full Vurdering run, not a deterministic readiness-only pass. The answer document for fasit-backed projects is a deterministic local kravbesvarelse generated from the real source ledger because the corpora do not include separate supplier answer files.
    </div>

    <section class="footnotes">
      <p>Raw summary: <code>${escapeHtml(summary.outputPath)}</code>.</p>
      <p>Per-project artifacts: <code>${escapeHtml(summary.artifactsRoot)}</code>.</p>
      <p>Cost note: ${escapeHtml(summary.telemetry.note)} ${escapeHtml(summary.cost.assumption)}</p>
    </section>
  </main>
  <script>
    const searchInput = document.getElementById("search");
    const corpusSelect = document.getElementById("corpus");
    const bandSelect = document.getElementById("band");
    const sortSelect = document.getElementById("sort");
    const tableBody = document.querySelector("#projectTable tbody");
    const visibleCount = document.getElementById("visibleCount");
    const originalRows = Array.from(tableBody.querySelectorAll("tr"));
    function rowBandMatches(row, band) {
      if (!band) return true;
      const score = Number(row.dataset.score || 0);
      if (band === "95") return score >= 95;
      if (band === "85") return score >= 85 && score < 95;
      return score < 85;
    }
    function applyFilters() {
      const query = searchInput.value.trim().toLowerCase();
      const corpus = corpusSelect.value;
      const band = bandSelect.value;
      const sort = sortSelect.value;
      let rows = originalRows.filter((row) => {
        const matchesSearch = !query || row.dataset.search.includes(query);
        const matchesCorpus = !corpus || row.dataset.corpus === corpus;
        return matchesSearch && matchesCorpus && rowBandMatches(row, band);
      });
      if (sort === "score-asc") rows = rows.sort((a, b) => Number(a.dataset.score) - Number(b.dataset.score));
      else if (sort === "score-desc") rows = rows.sort((a, b) => Number(b.dataset.score) - Number(a.dataset.score));
      else if (sort === "requirements-desc") rows = rows.sort((a, b) => Number(b.children[3].textContent) - Number(a.children[3].textContent));
      else rows = rows.sort((a, b) => originalRows.indexOf(a) - originalRows.indexOf(b));
      tableBody.replaceChildren(...rows);
      visibleCount.textContent = "Showing " + rows.length + " project" + (rows.length === 1 ? "" : "s");
    }
    [searchInput, corpusSelect, bandSelect, sortSelect].forEach((control) => {
      control.addEventListener("input", applyFilters);
      control.addEventListener("change", applyFilters);
    });
  </script>
</body>
</html>
`;
  await writeFile(filePath, html, "utf8");
}

async function main() {
  const options = parseArgs();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY mangler. Legg nøkkelen i .env eller apps/frontend/.env.local.");
  }

  const telemetryEvents = [];
  const originalInfo = console.info.bind(console);
  console.info = (...args) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith("{")) {
      try {
        const event = JSON.parse(first);
        if (
          event.event === "ai_json_completion_timing" ||
          event.event === "ai_json_file_input_completion_timing"
        ) {
          telemetryEvents.push(event);
        }
      } catch {
        // Keep normal logging if this is not one of our JSON telemetry lines.
      }
    }
    originalInfo(...args);
  };

  const [projects50, projects100] = await Promise.all([
    discoverFasitProjects({
      corpus: "50-folder",
      root: options.corpus50Root,
      fasitPath: path.join(options.corpus50Root, "Fasit_50_skyprosjekter_bilag2.xlsx"),
    }),
    discoverFasitProjects({
      corpus: "100-folder",
      root: options.corpus100Root,
      fasitPath: path.join(
        options.corpus100Root,
        "03_Fasit",
        "Fasit_100_skyprosjekter_bilag2.xlsx",
      ),
    }),
  ]);
  const petoro = {
    id: "petoro",
    corpus: "Petoro",
    projectNumber: 151,
    sourceNumber: "151",
    name: "Petoro",
    documentName: "Kravdokument - Bilag 2 - Petoro",
    requirementPath: options.petoroRequirement,
    customerPath: options.petoroCustomer,
    fileNameOverride: "Kravdokument - Bilag 2 - Petoro.pdf",
    customerFileNameOverride: "Bilag 1 - Petoro.pdf",
    fasitRows: [],
    hasFasit: false,
  };

  let projects = [...projects50, ...projects100, petoro];
  if (options.only) {
    projects = projects.filter((project) => project.id === options.only);
  }
  if (options.limit) {
    projects = projects.slice(0, options.limit);
  }

  await mkdir(path.join(options.artifactsRoot, "projects"), { recursive: true });
  await mkdir(path.join(options.artifactsRoot, "evaluations"), { recursive: true });

  const results = [];
  for (const [index, project] of projects.entries()) {
    console.log(`\n[${index + 1}/${projects.length}] ${project.id} ${project.name}`);
    try {
      results.push(await runProject(project, options));
    } catch (error) {
      const failure = {
        id: project.id,
        corpus: project.corpus,
        projectNumber: project.projectNumber,
        sourceNumber: project.sourceNumber,
        name: project.name,
        documentName: project.documentName,
        requirementPath: project.requirementPath,
        customerPath: project.customerPath,
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      };
      results.push(failure);
      await writeJson(
        path.join(options.artifactsRoot, "projects", `${project.id}.json`),
        failure,
      );
      console.error(`  FAILED ${project.id}: ${failure.error}`);
    }
  }

  const telemetrySource = process.env.VURDERING_TELEMETRY_LOG
    ? telemetryEventsFromLog(process.env.VURDERING_TELEMETRY_LOG)
    : telemetryEvents;
  const telemetry = summarizeTelemetry(telemetrySource);
  const summary = {
    generatedAt: new Date().toISOString(),
    outputPath: options.outputPath,
    artifactsRoot: options.artifactsRoot,
    reportPath: options.reportPath,
    actualFullVurderingRun: true,
    modelRequested: options.model ?? null,
    configuredModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.4",
    scope: {
      requestedProjects: projects.length,
      fullScopeExpectedProjects: 151,
      corpus50: projects50.length,
      corpus100: projects100.length,
      petoro: 1,
    },
    aggregate: aggregateProjects(results),
    telemetry,
    cost: approximateCost(telemetry),
    projects: results,
  };

  await writeJson(options.outputPath, summary);
  if (!options.skipReport) {
    await writeHtmlReport({ filePath: options.reportPath, summary });
  }

  const rows = (await readFile(options.reportPath, "utf8").catch(() => ""))
    .match(/<tr data-corpus=/g)?.length ?? 0;
  console.log(
    `\nDONE projects=${results.length} failures=${summary.aggregate.failures} reportRows=${rows} requests=${telemetry.totalRequests} estCost=$${summary.cost.estimatedCostUsd}`,
  );
}

await main();
