#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { File } from "node:buffer";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");

const defaultCorpus50Root =
  "/Users/sakariaahmed/Downloads/sky_50_unike_prosjekter_blandet";
const defaultCorpus100Root =
  "/Users/sakariaahmed/Downloads/sky_100_unike_prosjekter_blandet(1)";
const defaultRekkefolgeRoot =
  "/Users/sakariaahmed/Downloads/sky_100_prosjekter_rekkefolge_ekstraksjon";
const defaultPetoroRequirement =
  "/Users/sakariaahmed/Downloads/Kravdokument - Bilag 2 - Petoro";
const defaultPetoroCustomer = "/Users/sakariaahmed/Downloads/Bilag 1 - Petoro";
const defaultOutputPath = "/tmp/anbud-vurdering-api-full-251-results.json";
const defaultArtifactsRoot = "/tmp/anbud-vurdering-api-full-251";
const defaultServerLogPath = "/tmp/anbud-vurdering-api-full-251-server.log";
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
const jiti = createJiti(path.join(frontendRoot, "vurdering-api-full-251.cjs"), {
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
const { extractRequirementLedgerForDocument } = jiti(
  path.join(frontendRoot, "lib", "server", "ai.ts"),
);
const { createServiceClient } = jiti(
  path.join(frontendRoot, "lib", "server", "supabase.ts"),
);
const { encryptJson } = jiti(
  path.join(frontendRoot, "lib", "server", "crypto.ts"),
);
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
    baseUrl: valueAfter("--base-url"),
    port: Number(valueAfter("--port", "3000")) || 3000,
    startServer: !args.includes("--no-start-server"),
    keepServer: args.includes("--keep-server"),
    limit: valueAfter("--limit") ? Math.max(1, Number(valueAfter("--limit"))) : null,
    only: valueAfter("--only"),
    fromIndex: valueAfter("--from-index")
      ? Math.max(1, Number(valueAfter("--from-index")))
      : null,
    toIndex: valueAfter("--to-index")
      ? Math.max(1, Number(valueAfter("--to-index")))
      : null,
    shardIndex: valueAfter("--shard-index") !== ""
      ? Number(valueAfter("--shard-index"))
      : null,
    shardCount: valueAfter("--shard-count")
      ? Math.max(1, Number(valueAfter("--shard-count")))
      : null,
    model: valueAfter("--model") || undefined,
    outputPath: valueAfter("--output", defaultOutputPath),
    artifactsRoot: valueAfter("--artifacts-root", defaultArtifactsRoot),
    reportPath: valueAfter("--report", defaultReportPath),
    serverLogPath: valueAfter("--server-log", defaultServerLogPath),
    resume: !args.includes("--no-resume"),
    retryFailures: args.includes("--retry-failures"),
    discoverOnly: args.includes("--discover-only"),
    mergeOnly: args.includes("--merge-only"),
    skipReport: args.includes("--skip-report"),
    customerAnalysisApi: args.includes("--customer-analysis-api"),
    corpus50Root: valueAfter("--corpus-50-root", defaultCorpus50Root),
    corpus100Root: valueAfter("--corpus-100-root", defaultCorpus100Root),
    rekkefolgeRoot: valueAfter("--rekkefolge-root", defaultRekkefolgeRoot),
    petoroRequirement: valueAfter("--petoro-krav", defaultPetoroRequirement),
    petoroCustomer: valueAfter("--petoro-bilag1", defaultPetoroCustomer),
  };
}

function normalizeInlineText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeComparable(value) {
  return normalizeInlineText(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/["“”]/g, "")
    .replace(/[.,;:]+$/g, "")
    .trim();
}

function normalizeRef(value) {
  return normalizeComparable(value)
    .replace(/^(?:-|—|n\/a|na|nei|ingen)$/i, "")
    .replace(/\s*[-/]\s*/g, "-")
    .replace(/\s+/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slug(value) {
  return normalizeInlineText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
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

function loadRows(sheetPath, sheetName = "Alle krav") {
  const workbook = xlsx.readFile(sheetPath);
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Fasitfilen mangler arket "${sheetName}": ${sheetPath}`);
  }
  return xlsx.utils.sheet_to_json(sheet, { defval: "" });
}

function groupRowsByDocument(rows, columnName) {
  const byDocument = new Map();
  for (const row of rows) {
    const documentName = normalizeInlineText(row[columnName]);
    if (!documentName) continue;
    byDocument.set(documentName, [...(byDocument.get(documentName) ?? []), row]);
  }
  return byDocument;
}

function leadingProjectNumber(filePath) {
  return path.basename(filePath).match(/^(\d+)[_-]/)?.[1] ?? "";
}

function projectNameFromRequirement(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .replace(/^\d+_Bilag_2_Krav_/, "")
    .replace(/^\d+_/, "")
    .replace(/^Bilag_2_Krav_/, "")
    .replace(/_/g, " ");
}

function discoveryProjectSummary(project) {
  if (!project) return null;
  return {
    id: project.id,
    corpus: project.corpus,
    sourceNumber: project.sourceNumber,
    name: project.name,
    documentName: project.documentName,
    requirementPath: project.requirementPath,
    customerPath: project.customerPath,
    fasitRows: project.fasitRows?.length ?? 0,
    hasFasit: project.hasFasit,
  };
}

function rowsSortedByFasitOrder(rows) {
  return [...rows].sort((left, right) => {
    const leftOrder = Number(
      left["Kravrekkefølge i Bilag 2"] ?? left.Nr ?? left["Nr"] ?? 0,
    );
    const rightOrder = Number(
      right["Kravrekkefølge i Bilag 2"] ?? right.Nr ?? right["Nr"] ?? 0,
    );
    return leftOrder - rightOrder;
  });
}

async function discoverLegacyFasitProjects({ corpus, root, fasitPath }) {
  const rootFiles = await walkFiles(root);
  const byRelative = new Map(
    rootFiles.map((filePath) => [path.relative(root, filePath), filePath]),
  );
  const byBasename = new Map();
  const bilag1ByNumber = new Map();

  for (const filePath of rootFiles) {
    const fileName = path.basename(filePath);
    byBasename.set(fileName, [...(byBasename.get(fileName) ?? []), filePath]);
    if (!/_Bilag_1_/i.test(fileName)) continue;
    const number = leadingProjectNumber(fileName);
    if (number) {
      bilag1ByNumber.set(number, [...(bilag1ByNumber.get(number) ?? []), filePath]);
    }
  }

  const rowsByDocument = groupRowsByDocument(loadRows(fasitPath), "Dokument");
  return [...rowsByDocument.entries()]
    .map(([documentName, fasitRows], index) => {
      const requirementPath =
        byRelative.get(documentName) ??
        byBasename.get(path.basename(documentName))?.[0];
      if (!requirementPath) {
        throw new Error(`Fant ikke kravdokument fra fasit: ${documentName}`);
      }
      const number = leadingProjectNumber(requirementPath);
      const bilag1Candidates = bilag1ByNumber.get(number) ?? [];
      const sameDir = bilag1Candidates.find(
        (candidate) => path.dirname(candidate) === path.dirname(requirementPath),
      );
      const customerPath = sameDir ?? bilag1Candidates[0] ?? null;
      if (!customerPath) {
        throw new Error(`Fant ikke Bilag 1 for ${requirementPath}`);
      }
      return {
        id: `${corpus}-${number || index + 1}`,
        corpus,
        projectNumber: index + 1,
        sourceNumber: number,
        name: projectNameFromRequirement(requirementPath),
        documentName,
        requirementPath,
        customerPath,
        fasitRows: rowsSortedByFasitOrder(fasitRows),
        hasFasit: true,
      };
    })
    .sort((left, right) => Number(left.sourceNumber) - Number(right.sourceNumber));
}

async function discoverRekkefolgeProjects({ root }) {
  const fasitPath = path.join(
    root,
    "Fasit_100_skyprosjekter_rekkefolge_ekstraksjon.xlsx",
  );
  const rows = loadRows(fasitPath);
  const rootFiles = await walkFiles(root);
  const byBasename = new Map();
  for (const filePath of rootFiles) {
    byBasename.set(path.basename(filePath), filePath);
  }

  const grouped = new Map();
  for (const row of rows) {
    const projectId = normalizeInlineText(row["Prosjekt ID"]);
    const documentName = normalizeInlineText(row["Bilag 2-fil"]);
    if (!projectId || !documentName) continue;
    const key = `${projectId}|${documentName}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return [...grouped.entries()]
    .map(([key, fasitRows], index) => {
      const [projectId, documentName] = key.split("|");
      const requirementPath = byBasename.get(documentName);
      if (!requirementPath) {
        throw new Error(`Fant ikke rekkefolge-kravdokument: ${documentName}`);
      }
      const customerName = documentName.replace("_Bilag_2_Krav_", "_Bilag_1_");
      const customerPath = byBasename.get(customerName);
      if (!customerPath) {
        throw new Error(`Fant ikke rekkefolge-Bilag 1: ${customerName}`);
      }
      const number = leadingProjectNumber(requirementPath);
      return {
        id: `rekkefolge-100-${number || projectId}`,
        corpus: "rekkefolge-100",
        projectNumber: index + 1,
        sourceNumber: number,
        name: normalizeInlineText(fasitRows[0]?.Kunde) ||
          projectNameFromRequirement(requirementPath),
        documentName,
        requirementPath,
        customerPath,
        fasitRows: rowsSortedByFasitOrder(fasitRows),
        hasFasit: true,
      };
    })
    .sort((left, right) => Number(left.sourceNumber) - Number(right.sourceNumber));
}

function projectDocumentDetailFromParsed({
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
    fileName,
    parsed,
    buffer,
    projectId,
    role,
    supportingSubtype,
  });
}

function syntheticCustomerMarkdown({ projectName, reason }) {
  return [
    `# ${projectName}`,
    "",
    "Minimal syntetisk kundegrunnlag brukt fordi lokal/API-parsing av Bilag 1 feilet.",
    `Parsingfeil: ${reason}`,
    "Vurderingen skal primært kontrolleres mot kravledgeren fra Bilag 2.",
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
      reason: "Kravet inngar i kildeledgeren og ma vurderes eksplisitt.",
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
      "Svar konkret pa hvert krav og skill leveransebevis fra apne avklaringer.",
    ],
    recommended_services: [],
    value_opportunities: [],
    executive_summary:
      "Vurderingen er kjort mot ekte kravledger og API-generert kravbesvarelse for a teste dekning og actionability.",
  };
}

function expectedIdFromFasit(row) {
  return (
    normalizeRef(row["ID-identifikator"]) ||
    normalizeRef(row["Original ID / markering"]) ||
    normalizeRef(row["Prosjektspesifikk ID/type-identifikasjon"]) ||
    normalizeRef(row["Prosjektspesifikk identifikasjon"])
  );
}

function countUnorderedTextMatches(ledger, expectedRows) {
  const expectedCounts = new Map();
  for (const row of expectedRows) {
    const text = normalizeComparable(row?.Kravtekst);
    if (!text) continue;
    expectedCounts.set(text, (expectedCounts.get(text) ?? 0) + 1);
  }
  let matched = 0;
  for (const entry of ledger) {
    const text = normalizeComparable(entry?.text);
    const remaining = expectedCounts.get(text) ?? 0;
    if (remaining <= 0) continue;
    matched += 1;
    if (remaining === 1) expectedCounts.delete(text);
    else expectedCounts.set(text, remaining - 1);
  }
  return matched;
}

function compareLedgerWithFasitRows(ledger, expectedRows) {
  const mismatches = [];
  let orderedMatched = 0;
  let idMatched = 0;
  let idComparable = 0;
  let headingMatched = 0;
  let headingComparable = 0;
  const byStructure = new Map();

  for (let index = 0; index < expectedRows.length; index += 1) {
    const row = expectedRows[index];
    const entry = ledger[index];
    const structure = normalizeInlineText(row?.Strukturgrad) || "unknown";
    const bucket =
      byStructure.get(structure) ?? {
        expected: 0,
        orderedMatched: 0,
        idMatched: 0,
        idComparable: 0,
        headingMatched: 0,
        headingComparable: 0,
      };
    bucket.expected += 1;

    const expectedText = normalizeComparable(row?.Kravtekst);
    const actualText = normalizeComparable(entry?.text);
    if (actualText && actualText === expectedText) {
      orderedMatched += 1;
      bucket.orderedMatched += 1;
    } else {
      mismatches.push({
        index: index + 1,
        ref: row?.["Fasit-ref"],
        expected: row?.Kravtekst,
        actual: entry?.text,
      });
    }

    const expectedId = expectedIdFromFasit(row);
    if (expectedId) {
      idComparable += 1;
      bucket.idComparable += 1;
      const actualIds = [
        entry?.id,
        entry?.fullReference,
        entry?.reference,
        entry?.tableId,
      ].map(normalizeRef);
      if (actualIds.some((value) => value === expectedId || value.includes(expectedId))) {
        idMatched += 1;
        bucket.idMatched += 1;
      }
    }

    const expectedHeading = normalizeComparable(row?.Underoverskrift);
    if (expectedHeading) {
      headingComparable += 1;
      bucket.headingComparable += 1;
      const actualHeading = normalizeComparable(
        entry?.heading || entry?.headingPath || entry?.tableId,
      );
      if (
        actualHeading === expectedHeading ||
        actualHeading.includes(expectedHeading) ||
        expectedHeading.includes(actualHeading)
      ) {
        headingMatched += 1;
        bucket.headingMatched += 1;
      }
    }
    byStructure.set(structure, bucket);
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
    orderedMatched,
    unorderedMatched: countUnorderedTextMatches(ledger, expectedRows),
    idComparable,
    idMatched,
    headingComparable,
    headingMatched,
    byStructure: Object.fromEntries(byStructure.entries()),
    mismatches: mismatches.slice(0, 12),
    mismatchCount: mismatches.length,
    sourceIssues: sourceIssues.slice(0, 12),
    sourceIssueCount: sourceIssues.length,
  };
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
        (
          fasitComparison.unorderedMatched / Math.max(1, fasitComparison.expectedCount) +
          (fasitComparison.idComparable
            ? fasitComparison.idMatched / fasitComparison.idComparable
            : 1) +
          (fasitComparison.headingComparable
            ? fasitComparison.headingMatched / fasitComparison.headingComparable
            : 1)
        ) / 3,
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

function telemetryEventsFromLog(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => {
      const jsonStart = line.indexOf("{");
      if (jsonStart < 0) return null;
      try {
        const event = JSON.parse(line.slice(jsonStart));
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
        fileInputRequests: 0,
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
    if (event.event === "ai_json_file_input_completion_timing") {
      existing.fileInputRequests += 1;
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
  const exactUsageAvailable = usageEventCount > 0;

  return {
    exactUsageAvailable,
    totalRequests: models.reduce((sum, item) => sum + item.requests, 0),
    usageEventCount,
    inputTokens: models.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: models.reduce((sum, item) => sum + item.outputTokens, 0),
    totalTokens: models.reduce((sum, item) => sum + item.totalTokens, 0),
    cachedInputTokens: models.reduce(
      (sum, item) => sum + item.cachedInputTokens,
      0,
    ),
    estimatedInputTokens: models.reduce(
      (sum, item) => sum + item.estimatedInputTokens,
      0,
    ),
    estimatedOutputTokens: models.reduce(
      (sum, item) => sum + item.estimatedOutputTokens,
      0,
    ),
    note:
      exactUsageAvailable
        ? "Token totals use SDK usage fields when present; requests without usage fall back to prompt character estimates plus 900 output tokens per JSON call. Embedding requests are not counted because the request was for chat calls."
        : "Token totals are estimated from prompt characters plus 900 output tokens per JSON call. Embedding requests are not counted because the request was for chat calls.",
    byModel: models,
  };
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

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function choosePort(preferred) {
  for (let port = preferred; port < preferred + 20; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`Fant ingen ledig port fra ${preferred} til ${preferred + 19}.`);
}

async function waitForHealth(baseUrl, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { "x-client-ip": "127.251.0.1" },
      });
      if (response.status < 500) return;
      lastError = `${response.status} ${await response.text().catch(() => "")}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Lokal server ble ikke klar: ${lastError}`);
}

async function startLocalServer(options) {
  if (options.baseUrl) {
    await waitForHealth(options.baseUrl, 30_000);
    return { baseUrl: options.baseUrl.replace(/\/+$/, ""), child: null };
  }

  const port = options.startServer ? await choosePort(options.port) : options.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  if (!options.startServer) {
    await waitForHealth(baseUrl, 30_000);
    return { baseUrl, child: null };
  }

  await mkdir(path.dirname(options.serverLogPath), { recursive: true });
  await writeFile(
    options.serverLogPath,
    `# anbud vurdering api full 251 server log ${new Date().toISOString()}\n`,
    "utf8",
  );
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: frontendRoot,
      env: {
        ...process.env,
        TRUST_FORWARDED_RATE_LIMIT_HEADERS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const appendLog = (chunk) => {
    writeFile(options.serverLogPath, chunk, { flag: "a" }).catch(() => undefined);
  };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  child.once("exit", (code) => {
    appendLog(`\n# server exited code=${code}\n`);
  });
  await waitForHealth(baseUrl);
  return { baseUrl, child };
}

function parseSetCookie(headers) {
  const raw = headers.get("set-cookie");
  return raw ? raw.split(";")[0] : "";
}

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.cookie = "";
  }

  async login() {
    const password = process.env.APP_ACCESS_PASSWORD;
    if (!password) return;
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-ip": "127.251.0.2",
      },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      throw new Error(`Login feilet: ${response.status} ${await response.text()}`);
    }
    this.cookie = parseSetCookie(response.headers);
  }

  headers(projectKey, extra = {}) {
    const hash = createHash("sha1").update(projectKey || "global").digest();
    const ip = `10.${hash[0]}.${hash[1]}.${Math.max(1, hash[2])}`;
    return {
      ...extra,
      ...(this.cookie ? { cookie: this.cookie } : {}),
      "x-client-ip": ip,
    };
  }

  async json(pathname, { method = "GET", body, projectKey = "global", headers = {} } = {}) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: this.headers(projectKey, {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 429 && attempt < 5) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 1);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, retryAfter) * 1000),
        );
        continue;
      }
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        throw new Error(
          `${method} ${pathname} feilet ${response.status}: ${
            parsed?.error ?? text.slice(0, 500)
          }`,
        );
      }
      return parsed;
    }
    throw new Error(`${method} ${pathname} feilet etter rate-limit retries.`);
  }

  async uploadDocument({
    projectId,
    projectKey,
    fileName,
    buffer,
    title,
    role,
    supportingSubtype,
    contentType,
  }) {
    const form = new FormData();
    form.set(
      "file",
      new File([buffer], fileName, {
        type: contentType || "application/octet-stream",
      }),
    );
    form.set("title", title || fileName.replace(/\.[^.]+$/, ""));
    form.set("role", role);
    if (supportingSubtype) form.set("supporting_subtype", supportingSubtype);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fetch(
        `${this.baseUrl}/api/projects/${projectId}/documents`,
        {
          method: "POST",
          headers: this.headers(projectKey),
          body: form,
        },
      );
      if (response.status === 429 && attempt < 5) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 1);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, retryAfter) * 1000),
        );
        continue;
      }
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(
          `Upload ${fileName} feilet ${response.status}: ${
            parsed?.error ?? text.slice(0, 500)
          }`,
        );
      }
      return parsed;
    }
    throw new Error(`Upload ${fileName} feilet etter rate-limit retries.`);
  }
}

async function waitForJob(api, { projectId, jobId, projectKey, label }) {
  const started = Date.now();
  let workerKicks = 0;
  while (Date.now() - started < 20 * 60_000) {
    const { job } = await api.json(`/api/projects/${projectId}/jobs/${jobId}`, {
      projectKey,
    });
    if (job?.status === "completed") return job;
    if (job?.status === "failed") {
      throw new Error(`${label} feilet: ${job.error || "ukjent feil"}`);
    }
    if (workerKicks < 2 && Date.now() - started > 3000) {
      workerKicks += 1;
      await api
        .json("/api/project-jobs/worker", {
          method: "POST",
          body: { limit: 1 },
          projectKey,
          headers: process.env.PROJECT_JOB_WORKER_TOKEN
            ? { "x-worker-token": process.env.PROJECT_JOB_WORKER_TOKEN }
            : {},
        })
        .catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`${label} ble ikke ferdig innen tidsgrensen.`);
}

async function uploadAndIngest(api, input) {
  const uploaded = await api.uploadDocument(input);
  const job = await waitForJob(api, {
    projectId: input.projectId,
    jobId: uploaded.job.id,
    projectKey: input.projectKey,
    label: `Ingest ${input.fileName}`,
  });
  return {
    upload: uploaded,
    job,
    document: job.result?.document ?? uploaded.document,
  };
}

async function seedCustomerAnalysis({
  project,
  projectId,
  customerDocumentId,
  customerDocument,
  sourceLedger,
}) {
  const analysis = buildCustomerAnalysis({
    projectName: project.name,
    customerDocument,
    ledger: sourceLedger,
  });
  const supabase = createServiceClient();
  await supabase.from("customer_analyses").delete().eq("project_id", projectId);
  const { error } = await supabase.from("customer_analyses").insert({
    project_id: projectId,
    source_document_ids: [customerDocumentId],
    result_json: encryptJson(analysis),
  });
  if (error) {
    throw new Error(error.message || "Kunne ikke seed-e kundeanalyse.");
  }
  const update = await supabase
    .from("projects")
    .update({
      customer_analysis_generated: true,
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", projectId);
  if (update.error) {
    throw new Error(update.error.message || "Kunne ikke markere kundeanalyse klar.");
  }
  return analysis;
}

async function runProject(project, options, api) {
  const artifactPath = path.join(options.artifactsRoot, "projects", `${project.id}.json`);
  if (options.resume && existsSync(artifactPath)) {
    const previous = JSON.parse(await readFile(artifactPath, "utf8"));
    if (!previous.error || !options.retryFailures) {
      return previous;
    }
  }

  const localProjectId = `api-full-251-${project.id}`;
  const [requirementDocumentForLedger, customerDocumentForAnalysis] =
    await Promise.all([
      loadProjectDocument({
        filePath: project.requirementPath,
        fileNameOverride: project.fileNameOverride,
        projectId: localProjectId,
        role: "supporting_document",
        supportingSubtype: "kravdokument",
      }),
      loadProjectDocument({
        filePath: project.customerPath,
        fileNameOverride: project.customerFileNameOverride,
        projectId: localProjectId,
        role: "primary_customer_document",
      }).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
    ]);
  const sourceLedger = await extractRequirementLedgerForDocument(
    requirementDocumentForLedger,
  );

  const created = await api.json("/api/projects", {
    method: "POST",
    projectKey: project.id,
    body: {
      name: `[full-251 ${new Date().toISOString().slice(0, 10)}] ${project.name}`,
      customer_name: project.name,
      description: `Automated full Vurdering/Krav og svar API benchmark row ${project.id}`,
      industry: project.corpus,
      selected_service_ids: [],
    },
  });
  const apiProjectId = created.id;
  const projectKey = `${project.id}-${apiProjectId}`;

  let bilag1Fallback = null;
  let uploadedCustomer;
  if ("error" in customerDocumentForAnalysis) {
    bilag1Fallback = customerDocumentForAnalysis.error;
    const markdown = syntheticCustomerMarkdown({
      projectName: project.name,
      reason: bilag1Fallback,
    });
    uploadedCustomer = await uploadAndIngest(api, {
      projectId: apiProjectId,
      projectKey,
      fileName: "synthetic-bilag1.md",
      title: "Syntetisk Bilag 1 fallback",
      role: "primary_customer_document",
      buffer: Buffer.from(markdown, "utf8"),
      contentType: "text/markdown",
    });
  } else {
    const customerBuffer = await readFile(project.customerPath);
    const customerFileName =
      project.customerFileNameOverride ?? path.basename(project.customerPath);
    const customerFormat = inferUploadFileFormat({ fileName: customerFileName });
    try {
      uploadedCustomer = await uploadAndIngest(api, {
        projectId: apiProjectId,
        projectKey,
        fileName: customerFileName,
        title: path.basename(customerFileName, path.extname(customerFileName)),
        role: "primary_customer_document",
        buffer: customerBuffer,
        contentType: contentTypeForUploadFormat(customerFormat),
      });
    } catch (error) {
      bilag1Fallback = error instanceof Error ? error.message : String(error);
      const markdown = syntheticCustomerMarkdown({
        projectName: project.name,
        reason: bilag1Fallback,
      });
      uploadedCustomer = await uploadAndIngest(api, {
        projectId: apiProjectId,
        projectKey,
        fileName: "synthetic-bilag1.md",
        title: "Syntetisk Bilag 1 fallback",
        role: "primary_customer_document",
        buffer: Buffer.from(markdown, "utf8"),
        contentType: "text/markdown",
      });
    }
  }

  const requirementBuffer = await readFile(project.requirementPath);
  const requirementFileName =
    project.fileNameOverride ?? path.basename(project.requirementPath);
  const requirementFormat = inferUploadFileFormat({ fileName: requirementFileName });
  const uploadedRequirement = await uploadAndIngest(api, {
    projectId: apiProjectId,
    projectKey,
    fileName: requirementFileName,
    title: path.basename(requirementFileName, path.extname(requirementFileName)),
    role: "supporting_document",
    supportingSubtype: "kravdokument",
    buffer: requirementBuffer,
    contentType: contentTypeForUploadFormat(requirementFormat),
  });

  if (options.customerAnalysisApi) {
    await api.json(`/api/projects/${apiProjectId}/customer-analysis`, {
      method: "POST",
      projectKey,
      body: {},
      headers: options.model ? { "x-openai-model": options.model } : {},
    });
  } else {
    await seedCustomerAnalysis({
      project,
      projectId: apiProjectId,
      customerDocumentId: uploadedCustomer.document.id,
      customerDocument:
        "error" in customerDocumentForAnalysis
          ? projectDocumentDetailFromParsed({
              fileName: "synthetic-bilag1.md",
              parsed: {
                fileFormat: "md",
                contentType: "text/markdown",
                parserUsed: "local-synthetic",
                rawText: syntheticCustomerMarkdown({
                  projectName: project.name,
                  reason: bilag1Fallback,
                }),
                fileBase64: Buffer.from(
                  syntheticCustomerMarkdown({
                    projectName: project.name,
                    reason: bilag1Fallback,
                  }),
                  "utf8",
                ).toString("base64"),
                sourceMap: [],
              },
              buffer: Buffer.from(""),
              projectId: localProjectId,
              role: "primary_customer_document",
            })
          : customerDocumentForAnalysis,
      sourceLedger,
    });
  }

  const generatedJobStart = await api.json(`/api/projects/${apiProjectId}/jobs`, {
    method: "POST",
    projectKey,
    body: {
      kind: "artifact_generation",
      artifact_type: "forbedret_kravsvar",
      source_document_ids: [uploadedRequirement.document.id],
      instructions:
        "Lag en komplett, sporbar kravbesvarelse. Bevar kravrekkefolge, krav-ID og underoverskrift der dette finnes i kravdokumentet.",
      use_solution_evaluation_context: false,
    },
    headers: options.model ? { "x-openai-model": options.model } : {},
  });
  const generatedJob = await waitForJob(api, {
    projectId: apiProjectId,
    jobId: generatedJobStart.job.id,
    projectKey,
    label: "Krav og svar",
  });
  const generated = generatedJob.result;
  const artifact = generated.artifact;
  const artifactMarkdown = artifact?.content_markdown ?? "";
  if (!artifactMarkdown.trim()) {
    throw new Error("Krav og svar API returnerte tomt artefakt.");
  }
  const markdownPath = path.join(
    options.artifactsRoot,
    "kravsvar",
    `${project.id}-${slug(project.name)}.md`,
  );
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, artifactMarkdown, "utf8");

  const solutionFileName = `${project.id}-${slug(project.name)}-kravsvar.md`;
  const uploadedSolution = await uploadAndIngest(api, {
    projectId: apiProjectId,
    projectKey,
    fileName: solutionFileName,
    title: `API-generert Krav og svar - ${project.name}`,
    role: "primary_solution_document",
    buffer: Buffer.from(artifactMarkdown, "utf8"),
    contentType: "text/markdown",
  });

  const evaluationJobStart = await api.json(`/api/projects/${apiProjectId}/jobs`, {
    method: "POST",
    projectKey,
    body: {
      kind: "solution_evaluation",
      solution_document_id: uploadedSolution.document.id,
    },
    headers: options.model ? { "x-openai-model": options.model } : {},
  });
  const evaluationJob = await waitForJob(api, {
    projectId: apiProjectId,
    jobId: evaluationJobStart.job.id,
    projectKey,
    label: "Vurdering",
  });
  const evaluationResult = evaluationJob.result;
  const evaluation = evaluationResult.evaluation;
  const coverage = evaluation?.requirement_coverage;
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
    apiProjectId,
    apiBaseUrl: api.baseUrl,
    model:
      options.model ??
      process.env.OPENAI_MODEL?.trim() ??
      "gpt-5.4",
    customerAnalysisMode: options.customerAnalysisApi
      ? "api"
      : "deterministic-seed",
    bilag1Fallback,
    sourceRequirementCount: sourceLedger.length,
    kravSvar: {
      artifactId: artifact.id,
      title: artifact.title,
      markdownPath,
      sourceDocumentId: uploadedRequirement.document.id,
      solutionDocumentId: uploadedSolution.document.id,
      totalRequirements:
        artifact.input_snapshot?.generation_metadata?.requirement_response
          ?.total_requirements ??
        artifact.input_snapshot?.requirement_response?.total_requirements ??
        null,
    },
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

  await writeJson(summary.evaluationPath, evaluation);
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
    fasitExpected: 0,
    fasitUnorderedMatched: 0,
    fasitOrderedMatched: 0,
    fasitIdComparable: 0,
    fasitIdMatched: 0,
    fasitHeadingComparable: 0,
    fasitHeadingMatched: 0,
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
    if (item.fasitComparison) {
      bucket.fasitExpected += item.fasitComparison.expectedCount;
      bucket.fasitUnorderedMatched += item.fasitComparison.unorderedMatched;
      bucket.fasitOrderedMatched += item.fasitComparison.orderedMatched;
      bucket.fasitIdComparable += item.fasitComparison.idComparable;
      bucket.fasitIdMatched += item.fasitComparison.idMatched;
      bucket.fasitHeadingComparable += item.fasitComparison.headingComparable;
      bucket.fasitHeadingMatched += item.fasitComparison.headingMatched;
    }
  }
  const completed = bucket.projects - bucket.failures;
  bucket.averageScore = completed ? Math.round(bucket.scoreTotal / completed) : 0;
  return bucket;
}

function tableRows(projects) {
  return projects
    .map((item, index) => {
      if (item.error) {
        return `<tr data-project-row="1" data-corpus="${escapeHtml(item.corpus)}" data-score="0" data-search="${escapeHtml(`${item.name} ${item.documentName} ${item.corpus}`.toLowerCase())}">
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
        ? [
            `${fasit.unorderedMatched}/${fasit.expectedCount} text`,
            `${fasit.orderedMatched}/${fasit.expectedCount} row-order`,
            fasit.idComparable
              ? `${fasit.idMatched}/${fasit.idComparable} ID`
              : "ID n/a",
            fasit.headingComparable
              ? `${fasit.headingMatched}/${fasit.headingComparable} heading`
              : "heading n/a",
          ].join("; ")
        : "No fasit; integrity only";
      const actionability = Math.round((item.scoreComponents?.actionableRatio ?? 0) * 100);
      const subtitle = Math.round((item.scoreComponents?.subtitleRatio ?? 0) * 100);
      const note = [
        `Actionability ${actionability}%, subtitle/reference signal ${subtitle}%.`,
        item.integrity?.ok
          ? "Strict integrity clean."
          : `${item.integrity?.issueCount ?? 0} strict integrity issues.`,
        item.bilag1Fallback ? "Bilag 1 synthetic fallback used." : "",
        item.customerAnalysisMode === "deterministic-seed"
          ? "Customer analysis seeded deterministically."
          : "",
      ]
        .filter(Boolean)
        .join(" ");

      return `<tr data-project-row="1" data-corpus="${escapeHtml(item.corpus)}" data-score="${item.score}" data-requirements="${item.sourceRequirementCount}" data-search="${escapeHtml(`${item.name} ${item.documentName} ${item.corpus}`.toLowerCase())}">
        <td class="num">${index + 1}</td>
        <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.documentName)}</span></td>
        <td>${escapeHtml(item.corpus)}</td>
        <td class="num">${item.sourceRequirementCount}</td>
        <td><span class="${item.coverage.itemCount === item.sourceRequirementCount ? "good" : "warn"}">${item.coverage.itemCount}/${item.sourceRequirementCount}</span></td>
        <td>${escapeHtml(fasitText)}<br><span class="muted">source-order readiness from API evaluation ledger</span></td>
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
      const pct = (matched, total) =>
        total ? `${Math.round((matched / total) * 100)}%` : "n/a";
      return `<tr>
        <td>${escapeHtml(corpus)}</td>
        <td>${aggregate.projects}</td>
        <td>${aggregate.sourceRequirements}</td>
        <td><span class="${aggregate.coverageItems === aggregate.sourceRequirements ? "good" : "warn"}">${aggregate.coverageItems}/${aggregate.sourceRequirements}</span></td>
        <td>${aggregate.fasitExpected ? `${aggregate.fasitUnorderedMatched}/${aggregate.fasitExpected} (${pct(aggregate.fasitUnorderedMatched, aggregate.fasitExpected)})` : "No fasit"}</td>
        <td>${aggregate.fasitExpected ? `${aggregate.fasitOrderedMatched}/${aggregate.fasitExpected} (${pct(aggregate.fasitOrderedMatched, aggregate.fasitExpected)})` : "No fasit"}</td>
        <td>${aggregate.fasitIdComparable ? `${aggregate.fasitIdMatched}/${aggregate.fasitIdComparable} (${pct(aggregate.fasitIdMatched, aggregate.fasitIdComparable)})` : "n/a"}</td>
        <td>${aggregate.fasitHeadingComparable ? `${aggregate.fasitHeadingMatched}/${aggregate.fasitHeadingComparable} (${pct(aggregate.fasitHeadingMatched, aggregate.fasitHeadingComparable)})` : "n/a"}</td>
        <td>${aggregate.integrityIssues}</td>
        <td>${aggregate.averageScore}</td>
      </tr>`;
    })
    .join("\n");
}

async function writeHtmlReport({ filePath, summary }) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const aggregate = summary.aggregate;
  const generated = new Date(summary.generatedAt).toISOString().slice(0, 19);
  const modelList = summary.telemetry.byModel
    .map((item) => `${item.model}: ${item.requests}`)
    .join(", ");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>251 Project Vurdering Answer Quality Report</title>
  <style>
    :root { --paper:#f7f5ef; --ink:#17201b; --muted:#5f6860; --line:#d9d3c7; --panel:#fffefa; --band:#ece7dc; --green:#126a55; --ok:#27636d; --amber:#9a5a10; --red:#9e2f2f; --shadow:rgba(44,36,24,.08); }
    * { box-sizing: border-box; }
    body { margin:0; color:var(--ink); background:var(--paper); font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif; line-height:1.5; }
    main { width:min(1320px, calc(100% - 32px)); margin:0 auto; padding:32px 0 56px; }
    h1,h2,h3,p { margin:0; }
    h1 { max-width:940px; font-size:clamp(2.2rem, 5vw, 4.6rem); line-height:.98; letter-spacing:0; }
    h2 { margin-top:34px; font-size:clamp(1.35rem, 2vw, 1.9rem); letter-spacing:0; }
    h3 { font-size:1rem; letter-spacing:.02em; text-transform:uppercase; }
    p { color:var(--muted); }
    code { display:inline-block; max-width:100%; overflow-wrap:anywhere; border:1px solid var(--line); border-radius:4px; background:#faf6ee; padding:1px 5px; color:#24332c; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.9em; }
    .masthead { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(280px,.8fr); gap:24px; align-items:stretch; padding:28px; border:1px solid var(--line); border-radius:8px; background:rgba(255,254,250,.95); box-shadow:0 18px 45px var(--shadow); }
    .masthead p { max-width:900px; margin-top:18px; font-size:1.05rem; }
    .stamp { display:flex; min-height:250px; flex-direction:column; justify-content:space-between; border:1px solid #253b31; border-radius:8px; background:var(--ink); padding:20px; color:#f7f1e6; }
    .stamp p,.stamp span { color:#d8d0bf; }
    .stamp strong { display:block; font-size:clamp(4rem, 10vw, 7.2rem); line-height:.85; color:#fffaf0; }
    .meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:22px; }
    .tag { display:inline-flex; min-height:30px; align-items:center; border:1px solid var(--line); border-radius:999px; background:#fffaf0; padding:4px 11px; color:#3d493f; font-size:.84rem; font-weight:700; }
    .metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:18px; }
    .metric { min-height:124px; border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:16px; box-shadow:0 10px 22px var(--shadow); }
    .metric strong { display:block; color:var(--ink); font-size:2.1rem; line-height:1; }
    .metric span { display:block; margin-top:9px; color:var(--muted); font-size:.94rem; }
    .section { margin-top:18px; border:1px solid var(--line); border-radius:8px; background:rgba(255,254,250,.95); box-shadow:0 10px 24px var(--shadow); overflow:hidden; }
    .section-header { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); background:var(--band); padding:14px 16px; }
    .section-header span { color:var(--muted); font-size:.92rem; font-weight:700; }
    .controls { display:grid; grid-template-columns:minmax(220px,1fr) auto auto auto; gap:10px; padding:14px; border-bottom:1px solid var(--line); background:#fffaf0; }
    input,select { min-height:40px; border:1px solid var(--line); border-radius:6px; background:#fffefa; padding:8px 10px; color:var(--ink); font:.95rem/1.2 ui-serif, Georgia, Cambria, "Times New Roman", serif; }
    table { width:100%; border-collapse:collapse; background:var(--panel); }
    th,td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { position:sticky; top:0; z-index:1; background:#f5efe5; color:#34433a; font-size:.76rem; letter-spacing:.05em; text-transform:uppercase; }
    td { color:var(--muted); }
    td strong { display:block; color:var(--ink); }
    td span { display:block; }
    .table-wrap { max-height:760px; overflow:auto; }
    .num { color:var(--ink); font-weight:850; white-space:nowrap; }
    .score { font-size:1.2rem; }
    .muted { color:var(--muted); }
    .good { color:var(--green); font-weight:850; }
    .ok { color:var(--ok); font-weight:850; }
    .warn { color:var(--amber); font-weight:850; }
    .bad { color:var(--red); font-weight:850; }
    .badge { display:inline-flex; min-width:84px; min-height:28px; align-items:center; justify-content:center; border-radius:999px; padding:4px 9px; color:#fff; font-size:.82rem; font-weight:800; }
    .badge.good { background:var(--green); color:#fff; } .badge.ok { background:var(--ok); color:#fff; } .badge.warn { background:var(--amber); color:#fff; } .badge.bad { background:var(--red); color:#fff; }
    .rubric { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; padding:14px; background:var(--panel); }
    .rubric-item { border:1px solid var(--line); border-radius:8px; background:#fffaf0; padding:13px; }
    .rubric-item strong { display:block; color:var(--ink); font-size:1.25rem; line-height:1; }
    .rubric-item span { display:block; margin-top:8px; color:var(--muted); font-size:.9rem; }
    .callout { margin-top:18px; border-left:6px solid var(--ok); border-radius:8px; background:#edf3f5; padding:14px 16px; }
    .callout.warning { border-left-color:var(--amber); background:#fff5df; }
    .callout strong { display:block; margin-bottom:4px; color:var(--ink); }
    .footnotes { display:grid; gap:8px; margin-top:18px; color:var(--muted); font-size:.94rem; }
    @media (max-width:980px) { .masthead,.metric-grid { grid-template-columns:1fr; } .controls { grid-template-columns:1fr 1fr; } .rubric { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:680px) { main { width:min(100% - 20px,1320px); padding-top:18px; } .masthead { padding:16px; } .controls,.rubric { grid-template-columns:1fr; } table { min-width:1220px; } .stamp strong { font-size:3.6rem; } }
  </style>
</head>
<body>
  <main>
    <section class="masthead">
      <div>
        <h1>251 Project Vurdering Answer Quality Report</h1>
        <p>
          Actual local web-server/API run for Vurdering and Krav og svar. Each project was created through the API, documents were uploaded through the API, Krav og svar was generated through <code>/api/projects/:id/generate</code>, the generated markdown was uploaded as the primary solution document, and Vurdering was run through <code>/api/projects/:id/solution-evaluation</code>.
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
      <div class="metric"><strong>${aggregate.projects}</strong><span>Project rows in this run.</span></div>
      <div class="metric"><strong>${aggregate.coverageItems}/${aggregate.sourceRequirements}</strong><span>Vurdering coverage rows against real source requirements.</span></div>
      <div class="metric"><strong>${aggregate.integrityIssues}</strong><span>Strict integrity issues from evaluation-coverage-integrity.ts.</span></div>
      <div class="metric"><strong>$${summary.cost.estimatedCostUsd}</strong><span>Approximate cost from chat request telemetry.</span></div>
    </section>

    <section class="section">
      <div class="section-header"><h3>Scoring Rubric</h3><span>100 possible points</span></div>
      <div class="rubric">
        <div class="rubric-item"><strong>25</strong><span>Complete coverage of all source requirements.</span></div>
        <div class="rubric-item"><strong>15</strong><span>Stable ID/reference fields.</span></div>
        <div class="rubric-item"><strong>10</strong><span>Useful subtitle or table/source headline.</span></div>
        <div class="rubric-item"><strong>20</strong><span>Specific rationale, evidence, and recommendation.</span></div>
        <div class="rubric-item"><strong>20</strong><span>Strict integrity result.</span></div>
        <div class="rubric-item"><strong>10</strong><span>Fasit text, ID, and heading match where available.</span></div>
      </div>
    </section>

    <h2>Corpus Summary</h2>
    <section class="section">
      <table>
        <thead><tr><th>Scope</th><th>Projects</th><th>Source requirements</th><th>Coverage</th><th>Fasit text match</th><th>Fasit row order</th><th>Fasit ID</th><th>Fasit heading</th><th>Integrity issues</th><th>Average score</th></tr></thead>
        <tbody>${corpusRows(summary.projects)}</tbody>
      </table>
    </section>

    <h2>All Project Scores</h2>
    <section class="section">
      <div class="section-header"><h3>${summary.projects.length} rows</h3><span id="visibleCount">Showing ${summary.projects.length} projects</span></div>
      <div class="controls">
        <input id="search" type="search" placeholder="Search project or document">
        <select id="corpus">
          <option value="">All corpora</option>
          <option value="50-folder">50-folder</option>
          <option value="100-folder">100-folder</option>
          <option value="rekkefolge-100">rekkefolge-100</option>
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
      Fasit row order is diagnostic information. Source-order readiness is based on the requirement ledger the evaluation path consumes.
    </div>
    <div class="callout warning">
      <strong>Petoro caveat</strong>
      Petoro has no fasit spreadsheet in this corpus. Its score is based on the real Petoro documents and strict integrity only; if strict integrity is not clean, treat the row as review-required even when coverage is complete.
    </div>
    <div class="callout">
      <strong>Run provenance</strong>
      This report is from an actual full local web-server/API Vurdering and Krav og svar run, not deterministic readiness scoring. Customer analysis was ${summary.customerAnalysisMode === "api" ? "generated through the API" : "seeded deterministically as a prerequisite"} so the requested benchmark focuses on Vurdering and Krav og svar.
    </div>

    <section class="footnotes">
      <p>Raw summary: <code>${escapeHtml(summary.outputPath)}</code>.</p>
      <p>Per-project artifacts: <code>${escapeHtml(summary.artifactsRoot)}</code>.</p>
      <p>Server log: <code>${escapeHtml(summary.serverLogPath)}</code>.</p>
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
      else if (sort === "requirements-desc") rows = rows.sort((a, b) => Number(b.dataset.requirements || 0) - Number(a.dataset.requirements || 0));
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

async function discoverProjects(options) {
  const [projects50, projects100, rekkefolge] = await Promise.all([
    discoverLegacyFasitProjects({
      corpus: "50-folder",
      root: options.corpus50Root,
      fasitPath: path.join(options.corpus50Root, "Fasit_50_skyprosjekter_bilag2.xlsx"),
    }),
    discoverLegacyFasitProjects({
      corpus: "100-folder",
      root: options.corpus100Root,
      fasitPath: path.join(
        options.corpus100Root,
        "03_Fasit",
        "Fasit_100_skyprosjekter_bilag2.xlsx",
      ),
    }),
    discoverRekkefolgeProjects({ root: options.rekkefolgeRoot }),
  ]);

  const petoro = {
    id: "petoro",
    corpus: "Petoro",
    projectNumber: 251,
    sourceNumber: "251",
    name: "Petoro",
    documentName: "Kravdokument - Bilag 2 - Petoro",
    requirementPath: options.petoroRequirement,
    customerPath: options.petoroCustomer,
    fileNameOverride: "Kravdokument - Bilag 2 - Petoro.pdf",
    customerFileNameOverride: "Bilag 1 - Petoro.pdf",
    fasitRows: [],
    hasFasit: false,
  };

  const projects = [...projects50, ...projects100, ...rekkefolge, petoro];
  return { projects, projects50, projects100, rekkefolge };
}

function validateSelectionOptions(options) {
  if (options.shardCount !== null || options.shardIndex !== null) {
    if (
      !Number.isInteger(options.shardCount) ||
      options.shardCount < 1 ||
      !Number.isInteger(options.shardIndex) ||
      options.shardIndex < 0 ||
      options.shardIndex >= options.shardCount
    ) {
      throw new Error(
        "--shard-index must be 0-based and smaller than --shard-count.",
      );
    }
  }
  if (
    options.fromIndex !== null &&
    (!Number.isInteger(options.fromIndex) || options.fromIndex < 1)
  ) {
    throw new Error("--from-index must be a positive 1-based index.");
  }
  if (
    options.toIndex !== null &&
    (!Number.isInteger(options.toIndex) || options.toIndex < 1)
  ) {
    throw new Error("--to-index must be a positive 1-based index.");
  }
}

function selectProjects(projects, options) {
  validateSelectionOptions(options);
  let selected = [...projects];
  if (options.only) {
    selected = selected.filter((project) => project.id === options.only);
  }
  if (options.fromIndex !== null || options.toIndex !== null) {
    const from = options.fromIndex ?? 1;
    const to = options.toIndex ?? projects.length;
    selected = selected.filter((_, index) => {
      const oneBased = index + 1;
      return oneBased >= from && oneBased <= to;
    });
  }
  if (options.shardCount !== null) {
    selected = selected.filter(
      (_, index) => index % options.shardCount === options.shardIndex,
    );
  }
  if (options.limit) {
    selected = selected.slice(0, options.limit);
  }
  return selected;
}

async function mergeExistingProjectArtifacts({ options, projects, discovered }) {
  const results = [];
  for (const project of projects) {
    const artifactPath = path.join(
      options.artifactsRoot,
      "projects",
      `${project.id}.json`,
    );
    if (existsSync(artifactPath)) {
      results.push(JSON.parse(await readFile(artifactPath, "utf8")));
      continue;
    }
    results.push({
      id: project.id,
      corpus: project.corpus,
      projectNumber: project.projectNumber,
      sourceNumber: project.sourceNumber,
      name: project.name,
      documentName: project.documentName,
      requirementPath: project.requirementPath,
      customerPath: project.customerPath,
      error: "Missing project checkpoint; shard did not complete this row.",
      completedAt: new Date().toISOString(),
    });
  }

  const telemetry = summarizeTelemetry(telemetryEventsFromLog(options.serverLogPath));
  const summary = {
    generatedAt: new Date().toISOString(),
    outputPath: options.outputPath,
    artifactsRoot: options.artifactsRoot,
    reportPath: options.reportPath,
    serverLogPath: options.serverLogPath,
    baseUrl: options.baseUrl || null,
    actualLocalApiRun: true,
    actualFullVurderingRun: true,
    actualKravSvarRun: true,
    mergeOnly: true,
    customerAnalysisMode: options.customerAnalysisApi
      ? "api"
      : "deterministic-seed",
    modelRequested: options.model ?? null,
    configuredModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.4",
    scope: {
      requestedProjects: projects.length,
      fullScopeExpectedProjects: 251,
      corpus50: discovered.projects50.length,
      corpus100: discovered.projects100.length,
      rekkefolge100: discovered.rekkefolge.length,
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
  const html = await readFile(options.reportPath, "utf8").catch(() => "");
  const rows = html.match(/data-project-row="1"/g)?.length ?? 0;
  console.log(
    `MERGED projects=${results.length} failures=${summary.aggregate.failures} reportRows=${rows} requests=${telemetry.totalRequests} estCost=$${summary.cost.estimatedCostUsd}`,
  );
}

async function main() {
  const options = parseArgs();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY mangler. Legg nokkelen i .env eller apps/frontend/.env.local.");
  }

  await mkdir(path.join(options.artifactsRoot, "projects"), { recursive: true });
  await mkdir(path.join(options.artifactsRoot, "evaluations"), { recursive: true });
  await mkdir(path.join(options.artifactsRoot, "kravsvar"), { recursive: true });

  const discovered = await discoverProjects(options);
  const { projects50, projects100, rekkefolge } = discovered;
  const projects = selectProjects(discovered.projects, options);
  if (options.discoverOnly) {
    const discovery = {
      selectedProjects: projects.length,
      totalProjects: discovered.projects.length,
      corpus50: projects50.length,
      corpus100: projects100.length,
      rekkefolge100: rekkefolge.length,
      petoro: discovered.projects.some((project) => project.id === "petoro") ? 1 : 0,
      first: discoveryProjectSummary(projects[0]),
      last: discoveryProjectSummary(projects[projects.length - 1]),
    };
    console.log(JSON.stringify(discovery, null, 2));
    return;
  }
  if (options.mergeOnly) {
    await mergeExistingProjectArtifacts({ options, projects, discovered });
    return;
  }
  const server = await startLocalServer(options);
  const api = new ApiClient(server.baseUrl);
  await api.login();

  const results = [];
  try {
    for (const [index, project] of projects.entries()) {
      console.log(`\n[${index + 1}/${projects.length}] ${project.id} ${project.name}`);
      try {
        results.push(await runProject(project, options, api));
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
  } finally {
    if (server.child && !options.keepServer) {
      server.child.kill("SIGTERM");
    }
  }

  const telemetry = summarizeTelemetry(telemetryEventsFromLog(options.serverLogPath));
  const summary = {
    generatedAt: new Date().toISOString(),
    outputPath: options.outputPath,
    artifactsRoot: options.artifactsRoot,
    reportPath: options.reportPath,
    serverLogPath: options.serverLogPath,
    baseUrl: server.baseUrl,
    actualLocalApiRun: true,
    actualFullVurderingRun: true,
    actualKravSvarRun: true,
    customerAnalysisMode: options.customerAnalysisApi
      ? "api"
      : "deterministic-seed",
    modelRequested: options.model ?? null,
    configuredModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.4",
    scope: {
      requestedProjects: projects.length,
      fullScopeExpectedProjects: 251,
      corpus50: projects50.length,
      corpus100: projects100.length,
      rekkefolge100: rekkefolge.length,
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

  const html = await readFile(options.reportPath, "utf8").catch(() => "");
  const rows = html.match(/data-project-row="1"/g)?.length ?? 0;
  console.log(
    `\nDONE projects=${results.length} failures=${summary.aggregate.failures} reportRows=${rows} requests=${telemetry.totalRequests} estCost=$${summary.cost.estimatedCostUsd}`,
  );
}

await main();
