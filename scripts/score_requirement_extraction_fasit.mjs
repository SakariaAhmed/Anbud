#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");
const defaultDatasetRoot =
  "/Users/sakariaahmed/Downloads/sky_100_prosjekter_rekkefolge_ekstraksjon";
const defaultOutputPath = path.join(
  repoRoot,
  "reports",
  "requirement-extraction-fasit-score.json",
);
const defaultReportPath = path.join(
  repoRoot,
  "reports",
  "requirement-extraction-fasit-report.md",
);

const require = createRequire(import.meta.url);
const xlsx = require(path.join(frontendRoot, "node_modules", "@e965", "xlsx"));
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "requirement-fasit-score.cjs"), {
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

function parseArgs() {
  const args = process.argv.slice(2);
  const valueAfter = (name, fallback = "") => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };

  return {
    datasetRoot: valueAfter("--dataset", defaultDatasetRoot),
    outputPath: valueAfter("--output", defaultOutputPath),
    reportPath: valueAfter("--report", defaultReportPath),
    limit: valueAfter("--limit") ? Math.max(1, Number(valueAfter("--limit"))) : null,
    only: valueAfter("--only"),
    skipReport: args.includes("--skip-report"),
    dumpMismatches: args.includes("--dump-mismatches"),
  };
}

function normalizeInlineText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeComparableText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIdentifier(value) {
  return normalizeComparableText(value)
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, "")
    .replace(/[.:;,()[\]]/g, "");
}

function normalizeHeading(value) {
  return normalizeComparableText(value)
    .replace(/\s*>\s*/g, ">")
    .replace(/\s*-\s*/g, " - ");
}

function percent(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function emptyBucket(name) {
  return {
    name,
    documents: 0,
    documentsExactCount: 0,
    expectedRequirements: 0,
    extractedRequirements: 0,
    orderedTextMatches: 0,
    strictTextMatches: 0,
    alignedTextMatches: 0,
    usableIdExpected: 0,
    usableIdCorrect: 0,
    syntheticIdExpected: 0,
    syntheticIdTypeCorrect: 0,
    headingExpected: 0,
    headingCorrect: 0,
    sourceLocatorExpected: 0,
    sourceLocatorPresent: 0,
  };
}

function finalizeBucket(bucket) {
  return {
    ...bucket,
    countAccuracy: percent(bucket.documentsExactCount, bucket.documents),
    orderedTextAccuracy: percent(
      bucket.orderedTextMatches,
      bucket.expectedRequirements,
    ),
    strictTextRecall: percent(
      bucket.strictTextMatches,
      bucket.expectedRequirements,
    ),
    alignedTextAccuracy: percent(
      bucket.alignedTextMatches,
      bucket.expectedRequirements,
    ),
    usableIdAccuracy: percent(bucket.usableIdCorrect, bucket.usableIdExpected),
    syntheticIdTypeAccuracy: percent(
      bucket.syntheticIdTypeCorrect,
      bucket.syntheticIdExpected,
    ),
    idAccuracy: percent(
      bucket.usableIdCorrect + bucket.syntheticIdTypeCorrect,
      bucket.usableIdExpected + bucket.syntheticIdExpected,
    ),
    headingAccuracy: percent(bucket.headingCorrect, bucket.headingExpected),
    sourceLocatorPresence: percent(
      bucket.sourceLocatorPresent,
      bucket.sourceLocatorExpected,
    ),
  };
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

function loadWorkbookRows(datasetRoot) {
  const fasitPath = path.join(
    datasetRoot,
    "Fasit_100_skyprosjekter_rekkefolge_ekstraksjon.xlsx",
  );
  if (!existsSync(fasitPath)) {
    throw new Error(`Fant ikke fasitfil: ${fasitPath}`);
  }

  const workbook = xlsx.readFile(fasitPath);
  const sheet = workbook.Sheets["Alle krav"];
  if (!sheet) {
    throw new Error(`Fasitfilen mangler arket "Alle krav": ${fasitPath}`);
  }

  return xlsx.utils.sheet_to_json(sheet, { defval: "" });
}

function groupRowsByDocument(rows) {
  const groups = new Map();
  for (const row of rows) {
    const projectId = normalizeInlineText(row["Prosjekt ID"]);
    const bilag2 = normalizeInlineText(row["Bilag 2-fil"]);
    if (!projectId || !bilag2) continue;
    const key = `${projectId}||${bilag2}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()].map((documentRows) =>
    documentRows.sort(
      (left, right) =>
        Number(left["Kravrekkefølge i Bilag 2"] ?? 0) -
        Number(right["Kravrekkefølge i Bilag 2"] ?? 0),
    ),
  );
}

async function discoverRequirementFiles(datasetRoot) {
  const files = await walkFiles(datasetRoot);
  const byBaseName = new Map();
  for (const filePath of files) {
    const baseName = path.basename(filePath);
    if (!/\.(?:pdf|docx)$/i.test(baseName) || !/_Bilag_2_Krav_/i.test(baseName)) {
      continue;
    }
    byBaseName.set(baseName, filePath);
  }
  return byBaseName;
}

function projectDocumentDetailFromParsed({ filePath, parsed, buffer, projectId }) {
  const now = new Date(0).toISOString();
  const fileName = path.basename(filePath);

  return {
    id: `${projectId}-${fileName}`,
    project_id: projectId,
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
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    raw_text: parsed.rawText,
    file_base64: parsed.fileBase64,
    structure_map: parsed.sourceMap,
  };
}

async function loadRequirementDocument(filePath, projectId) {
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

  return projectDocumentDetailFromParsed({ filePath, parsed, buffer, projectId });
}

function requirementText(row) {
  return normalizeComparableText(row?.Kravtekst);
}

function entryText(entry) {
  return normalizeComparableText(entry?.text);
}

function alignLedgerToFasitRows(ledger, rows) {
  const matches = new Array(rows.length).fill(null);
  const usedEntryIndexes = new Set();

  for (let index = 0; index < rows.length; index += 1) {
    if (entryText(ledger[index]) === requirementText(rows[index])) {
      matches[index] = { entry: ledger[index], entryIndex: index, type: "ordered" };
      usedEntryIndexes.add(index);
    }
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (matches[rowIndex]) continue;
    const expected = requirementText(rows[rowIndex]);
    if (!expected) continue;

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let entryIndex = 0; entryIndex < ledger.length; entryIndex += 1) {
      if (usedEntryIndexes.has(entryIndex)) continue;
      if (entryText(ledger[entryIndex]) !== expected) continue;
      const distance = Math.abs(entryIndex - rowIndex);
      if (distance < bestDistance) {
        bestIndex = entryIndex;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) {
      matches[rowIndex] = {
        entry: ledger[bestIndex],
        entryIndex: bestIndex,
        type: "unordered",
      };
      usedEntryIndexes.add(bestIndex);
    }
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (matches[rowIndex]) continue;
    const expected = requirementText(rows[rowIndex]);
    if (expected.length < 48) continue;

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let entryIndex = 0; entryIndex < ledger.length; entryIndex += 1) {
      if (usedEntryIndexes.has(entryIndex)) continue;
      const actual = entryText(ledger[entryIndex]);
      if (
        !actual ||
        (actual !== expected && !actual.includes(expected) && !expected.includes(actual))
      ) {
        continue;
      }
      const distance = Math.abs(entryIndex - rowIndex);
      if (distance < bestDistance) {
        bestIndex = entryIndex;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) {
      matches[rowIndex] = {
        entry: ledger[bestIndex],
        entryIndex: bestIndex,
        type: "fuzzy",
      };
      usedEntryIndexes.add(bestIndex);
    }
  }

  return {
    matches,
    unmatchedEntryIndexes: ledger
      .map((_entry, index) => index)
      .filter((index) => !usedEntryIndexes.has(index)),
  };
}

function isUsableFasitId(row) {
  return /^ja$/i.test(normalizeInlineText(row["Har brukbar ID"]));
}

function idMatches(row, entry) {
  const actualCandidates = [
    entry?.id,
    entry?.sourceExcerpt,
    entry?.tableId,
  ].map(normalizeIdentifier);
  const actualJoined = actualCandidates.filter(Boolean).join(" ");

  if (isUsableFasitId(row)) {
    const expectedCandidates = [
      row["ID-identifikator"],
      row["Original ID / markering"],
    ]
      .map(normalizeIdentifier)
      .filter(Boolean);
    return expectedCandidates.some((expected) =>
      actualCandidates.some((actual) => actual === expected),
    );
  }

  const expectedTypeId = normalizeIdentifier(row["Kravtype-identifikasjon"]);
  const expectedType = normalizeIdentifier(row.Kravtype);
  if (expectedTypeId && actualCandidates.some((actual) => actual === expectedTypeId)) {
    return true;
  }
  if (!expectedType) {
    return false;
  }
  return actualJoined.includes(expectedType);
}

function headingMatches(row, entry) {
  const expected = normalizeHeading(row.Underoverskrift);
  if (!expected) return false;
  const heading = normalizeInlineText(entry?.heading);
  const segments = heading
    .split(">")
    .map((part) => normalizeHeading(part))
    .filter(Boolean);

  return normalizeHeading(heading) === expected || segments.includes(expected);
}

function hasSourceLocator(entry) {
  return Boolean(
    normalizeInlineText(entry?.sourceExcerpt) ||
      normalizeInlineText(entry?.heading) ||
      normalizeInlineText(entry?.tableId) ||
      (Array.isArray(entry?.pages) && entry.pages.length > 0),
  );
}

function addDocumentToBucket(bucket, documentResult) {
  bucket.documents += 1;
  bucket.documentsExactCount += documentResult.countExact ? 1 : 0;
  bucket.expectedRequirements += documentResult.expectedCount;
  bucket.extractedRequirements += documentResult.actualCount;
  bucket.orderedTextMatches += documentResult.orderedTextMatches;
  bucket.strictTextMatches += documentResult.strictTextMatches;
  bucket.alignedTextMatches += documentResult.alignedTextMatches;
  bucket.usableIdExpected += documentResult.usableIdExpected;
  bucket.usableIdCorrect += documentResult.usableIdCorrect;
  bucket.syntheticIdExpected += documentResult.syntheticIdExpected;
  bucket.syntheticIdTypeCorrect += documentResult.syntheticIdTypeCorrect;
  bucket.headingExpected += documentResult.headingExpected;
  bucket.headingCorrect += documentResult.headingCorrect;
  bucket.sourceLocatorExpected += documentResult.sourceLocatorExpected;
  bucket.sourceLocatorPresent += documentResult.sourceLocatorPresent;
}

function emptyRequirementTypeBucket(name) {
  return {
    name,
    expectedRequirements: 0,
    orderedTextMatches: 0,
    strictTextMatches: 0,
    alignedTextMatches: 0,
  };
}

function addRowToRequirementTypeBucket(bucket, { match }) {
  bucket.expectedRequirements += 1;
  if (match?.type === "ordered") {
    bucket.orderedTextMatches += 1;
  }
  if (match && match.type !== "fuzzy") {
    bucket.strictTextMatches += 1;
  }
  if (match) {
    bucket.alignedTextMatches += 1;
  }
}

function addRequirementTypeBucket(target, source) {
  target.expectedRequirements += source.expectedRequirements;
  target.orderedTextMatches += source.orderedTextMatches;
  target.strictTextMatches += source.strictTextMatches;
  target.alignedTextMatches += source.alignedTextMatches;
}

function finalizeRequirementTypeBucket(bucket) {
  return {
    ...bucket,
    orderedTextAccuracy: percent(
      bucket.orderedTextMatches,
      bucket.expectedRequirements,
    ),
    strictTextRecall: percent(
      bucket.strictTextMatches,
      bucket.expectedRequirements,
    ),
    alignedTextAccuracy: percent(
      bucket.alignedTextMatches,
      bucket.expectedRequirements,
    ),
  };
}

function scoreDocument({ rows, ledger, timingMs }) {
  const { matches, unmatchedEntryIndexes } = alignLedgerToFasitRows(ledger, rows);
  const mismatches = [];
  let orderedTextMatches = 0;
  let strictTextMatches = 0;
  let alignedTextMatches = 0;
  let usableIdExpected = 0;
  let usableIdCorrect = 0;
  let syntheticIdExpected = 0;
  let syntheticIdTypeCorrect = 0;
  let headingExpected = 0;
  let headingCorrect = 0;
  let sourceLocatorExpected = 0;
  let sourceLocatorPresent = 0;
  const requirementTypeBuckets = new Map();

  for (const [index, row] of rows.entries()) {
    const match = matches[index];
    if (match?.type === "ordered") orderedTextMatches += 1;
    if (match && match.type !== "fuzzy") strictTextMatches += 1;
    if (match) alignedTextMatches += 1;
    const kravtype = normalizeInlineText(row.Kravtype) || "ukjent";
    const typeBucket =
      requirementTypeBuckets.get(kravtype) ?? emptyRequirementTypeBucket(kravtype);
    requirementTypeBuckets.set(kravtype, typeBucket);
    addRowToRequirementTypeBucket(typeBucket, { match });

    const entry = match?.entry;
    if (isUsableFasitId(row)) {
      usableIdExpected += 1;
      if (entry && idMatches(row, entry)) usableIdCorrect += 1;
    } else {
      syntheticIdExpected += 1;
      if (entry && idMatches(row, entry)) syntheticIdTypeCorrect += 1;
    }

    if (normalizeInlineText(row.Underoverskrift)) {
      headingExpected += 1;
      if (entry && headingMatches(row, entry)) headingCorrect += 1;
    }

    sourceLocatorExpected += 1;
    if (entry && hasSourceLocator(entry)) sourceLocatorPresent += 1;

    if (
      !entry ||
      match.type !== "ordered" ||
      !idMatches(row, entry) ||
      !headingMatches(row, entry)
    ) {
      mismatches.push({
        order: Number(row["Kravrekkefølge i Bilag 2"]),
        fasitRef: row["Fasit-ref"],
        matchType: match?.type ?? "missing",
        expectedId: row["ID-identifikator"] || row["Kravtype-identifikasjon"],
        actualId: entry?.id ?? "",
        expectedHeading: row.Underoverskrift,
        actualHeading: entry?.heading ?? "",
        expectedText: row.Kravtekst,
        actualText: entry?.text ?? "",
        actualIndex: match?.entryIndex ?? null,
      });
    }
  }

  const result = {
    projectId: normalizeInlineText(rows[0]?.["Prosjekt ID"]),
    documentName: normalizeInlineText(rows[0]?.["Bilag 2-fil"]),
    format: normalizeInlineText(rows[0]?.Format),
    structuregrad: normalizeInlineText(rows[0]?.Strukturgrad) || "ukjent",
    expectedCount: rows.length,
    actualCount: ledger.length,
    countExact: ledger.length === rows.length,
    orderedTextMatches,
    strictTextMatches,
    alignedTextMatches,
    usableIdExpected,
    usableIdCorrect,
    syntheticIdExpected,
    syntheticIdTypeCorrect,
    headingExpected,
    headingCorrect,
    sourceLocatorExpected,
    sourceLocatorPresent,
    unmatchedExtractedCount: unmatchedEntryIndexes.length,
    timingMs,
    byKravtype: [...requirementTypeBuckets.values()]
      .map(finalizeRequirementTypeBucket)
      .sort((left, right) => left.name.localeCompare(right.name, "nb")),
    mismatches: mismatches.slice(0, 25),
  };

  return {
    ...result,
    metrics: {
      orderedTextAccuracy: percent(orderedTextMatches, rows.length),
      strictTextRecall: percent(strictTextMatches, rows.length),
      alignedTextAccuracy: percent(alignedTextMatches, rows.length),
      idAccuracy: percent(
        usableIdCorrect + syntheticIdTypeCorrect,
        usableIdExpected + syntheticIdExpected,
      ),
      headingAccuracy: percent(headingCorrect, headingExpected),
      sourceLocatorPresence: percent(sourceLocatorPresent, sourceLocatorExpected),
    },
  };
}

async function runDocument(rows, filesByBaseName) {
  const projectId = normalizeInlineText(rows[0]?.["Prosjekt ID"]);
  const documentName = normalizeInlineText(rows[0]?.["Bilag 2-fil"]);
  const filePath = filesByBaseName.get(documentName);
  if (!filePath) {
    throw new Error(`Fant ikke Bilag 2-fil fra fasit: ${documentName}`);
  }

  const startedAt = performance.now();
  const parseStartedAt = performance.now();
  const document = await loadRequirementDocument(filePath, projectId);
  const parsedAt = performance.now();
  const ledger = await extractRequirementLedgerForDocument(document);
  const scoredAt = performance.now();

  return scoreDocument({
    rows,
    ledger,
    timingMs: {
      total: Math.round(scoredAt - startedAt),
      parse: Math.round(parsedAt - parseStartedAt),
      ledger: Math.round(scoredAt - parsedAt),
    },
  });
}

function markdownTable(rows) {
  return rows.join("\n");
}

function renderReport(summary) {
  const overall = summary.metrics.overall;
  const bucketRows = [
    "| Strukturgrad | Docs | Krav | Count | Ordered text | Strict text | Aligned text | ID | Heading | Locator |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.metrics.byStructuregrad.map(
      (bucket) =>
        `| ${bucket.name} | ${bucket.documents} | ${bucket.expectedRequirements} | ${bucket.countAccuracy}% | ${bucket.orderedTextAccuracy}% | ${bucket.strictTextRecall}% | ${bucket.alignedTextAccuracy}% | ${bucket.idAccuracy}% | ${bucket.headingAccuracy}% | ${bucket.sourceLocatorPresence}% |`,
    ),
  ];
  const kravtypeRows = [
    "| Kravtype | Krav | Ordered text | Strict text | Aligned text |",
    "|---|---:|---:|---:|---:|",
    ...summary.metrics.byKravtype.map(
      (bucket) =>
        `| ${bucket.name} | ${bucket.expectedRequirements} | ${bucket.orderedTextAccuracy}% | ${bucket.strictTextRecall}% | ${bucket.alignedTextAccuracy}% |`,
    ),
  ];
  const worstRows = summary.documents
    .filter((document) => !document.error)
    .map((document) => ({
      document,
      score:
        ratio(document.orderedTextMatches, document.expectedCount) * 0.35 +
        ratio(
          document.usableIdCorrect + document.syntheticIdTypeCorrect,
          document.usableIdExpected + document.syntheticIdExpected,
        ) *
          0.3 +
        ratio(document.headingCorrect, document.headingExpected) * 0.3 +
        ratio(document.sourceLocatorPresent, document.sourceLocatorExpected) * 0.05,
    }))
    .sort((left, right) => left.score - right.score)
    .slice(0, 20)
    .map(({ document }) => {
      const firstMismatch = document.mismatches[0];
      return `| ${document.projectId} | ${document.documentName} | ${document.structuregrad} | ${document.actualCount}/${document.expectedCount} | ${document.metrics.idAccuracy}% | ${document.metrics.headingAccuracy}% | ${firstMismatch ? `${firstMismatch.fasitRef}: ${firstMismatch.matchType}` : ""} |`;
    });

  return [
    "# Requirement Extraction Fasit Score",
    "",
    `Generated: ${summary.generatedAt}`,
    `Dataset: \`${summary.datasetRoot}\``,
    "",
    "## Overall",
    "",
    `- Documents: ${overall.documents}`,
    `- Requirements in fasit: ${overall.expectedRequirements}`,
    `- Extracted requirements: ${overall.extractedRequirements}`,
    `- Exact count accuracy: ${overall.countAccuracy}%`,
    `- Ordered text accuracy: ${overall.orderedTextAccuracy}%`,
    `- Strict per-row text recall: ${overall.strictTextRecall}%`,
    `- Aligned text accuracy: ${overall.alignedTextAccuracy}%`,
    `- ID accuracy: ${overall.idAccuracy}%`,
    `- Heading accuracy: ${overall.headingAccuracy}%`,
    `- Source locator presence: ${overall.sourceLocatorPresence}%`,
    "",
    "## By Strukturgrad",
    "",
    markdownTable(bucketRows),
    "",
    "## By Kravtype",
    "",
    markdownTable(kravtypeRows),
    "",
    "## Lowest Scoring Documents",
    "",
    "| Prosjekt | Bilag 2 | Strukturgrad | Count | ID | Heading | First mismatch |",
    "|---|---|---|---:|---:|---:|---|",
    ...worstRows,
    "",
    "## Notes",
    "",
    "- Strict per-row text recall counts only one-to-one exact normalized text matches (`ordered` + `unordered`). Aligned text accuracy also includes the legacy substring fallback for long rows.",
    "- ID accuracy uses `ID-identifikator`/`Original ID / markering` when `Har brukbar ID = Ja`; otherwise it checks whether the synthetic identifier carries the fasit kravtype identifier/type.",
    "- Heading accuracy accepts an exact `entry.heading` match or an exact segment in a `>` heading path.",
  ].join("\n");
}

async function main() {
  const options = parseArgs();
  const rows = loadWorkbookRows(options.datasetRoot);
  const groupedRows = groupRowsByDocument(rows);
  const filesByBaseName = await discoverRequirementFiles(options.datasetRoot);
  let documents = groupedRows;
  if (options.only) {
    documents = documents.filter((documentRows) =>
      normalizeInlineText(documentRows[0]?.["Prosjekt ID"]) === options.only ||
      normalizeInlineText(documentRows[0]?.["Bilag 2-fil"]).includes(options.only),
    );
  }
  if (options.limit) {
    documents = documents.slice(0, options.limit);
  }

  const overallBucket = emptyBucket("overall");
  const bucketsByStructuregrad = new Map();
  const bucketsByKravtype = new Map();
  const results = [];

  for (const [index, documentRows] of documents.entries()) {
    const projectId = normalizeInlineText(documentRows[0]?.["Prosjekt ID"]);
    const documentName = normalizeInlineText(documentRows[0]?.["Bilag 2-fil"]);
    process.stdout.write(
      `[${index + 1}/${documents.length}] ${projectId} ${documentName} ... `,
    );
    try {
      const result = await runDocument(documentRows, filesByBaseName);
      results.push(result);
      addDocumentToBucket(overallBucket, result);
      const bucketName = result.structuregrad || "ukjent";
      const bucket = bucketsByStructuregrad.get(bucketName) ?? emptyBucket(bucketName);
      bucketsByStructuregrad.set(bucketName, bucket);
      addDocumentToBucket(bucket, result);
      for (const typeResult of result.byKravtype ?? []) {
        const typeBucket =
          bucketsByKravtype.get(typeResult.name) ??
          emptyRequirementTypeBucket(typeResult.name);
        bucketsByKravtype.set(typeResult.name, typeBucket);
        addRequirementTypeBucket(typeBucket, typeResult);
      }
      process.stdout.write(
        `text ${result.orderedTextMatches}/${result.expectedCount}, strict ${result.strictTextMatches}/${result.expectedCount}, id ${result.metrics.idAccuracy}%, heading ${result.metrics.headingAccuracy}%\n`,
      );
      if (options.dumpMismatches) {
        for (const mismatch of result.mismatches.slice(0, 5)) {
          console.log(
            `  ${mismatch.fasitRef} ${mismatch.matchType}: id "${mismatch.actualId}" vs "${mismatch.expectedId}", heading "${mismatch.actualHeading}" vs "${mismatch.expectedHeading}"`,
          );
        }
      }
    } catch (error) {
      const failure = {
        projectId,
        documentName,
        format: normalizeInlineText(documentRows[0]?.Format),
        structuregrad: normalizeInlineText(documentRows[0]?.Strukturgrad) || "ukjent",
        expectedCount: documentRows.length,
        actualCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(failure);
      process.stdout.write(`FAILED ${failure.error}\n`);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    datasetRoot: options.datasetRoot,
    outputPath: options.outputPath,
    reportPath: options.reportPath,
    metrics: {
      overall: finalizeBucket(overallBucket),
      byStructuregrad: [...bucketsByStructuregrad.values()]
        .map(finalizeBucket)
        .sort((left, right) => left.name.localeCompare(right.name, "nb")),
      byKravtype: [...bucketsByKravtype.values()]
        .map(finalizeRequirementTypeBucket)
        .sort((left, right) => left.name.localeCompare(right.name, "nb")),
    },
    failures: results.filter((result) => result.error).length,
    documents: results,
  };

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, JSON.stringify(summary, null, 2), "utf8");
  if (!options.skipReport) {
    await mkdir(path.dirname(options.reportPath), { recursive: true });
    await writeFile(options.reportPath, renderReport(summary), "utf8");
  }

  console.log(
    JSON.stringify(
      {
        documents: summary.metrics.overall.documents,
        requirements: summary.metrics.overall.expectedRequirements,
        orderedTextAccuracy: summary.metrics.overall.orderedTextAccuracy,
        strictTextRecall: summary.metrics.overall.strictTextRecall,
        idAccuracy: summary.metrics.overall.idAccuracy,
        headingAccuracy: summary.metrics.overall.headingAccuracy,
        outputPath: options.outputPath,
        reportPath: options.skipReport ? null : options.reportPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
