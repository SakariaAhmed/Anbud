#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");
const defaultDatasetRoot =
  "/Users/sakariaahmed/Downloads/sky_100_prosjekter_rekkefolge_ekstraksjon";
const defaultOutputPath = path.join(
  repoRoot,
  "reports",
  "document-parser-bakeoff.json",
);
const defaultReportPath = path.join(
  repoRoot,
  "reports",
  "document-parser-bakeoff.md",
);
const defaultCacheDir = path.join(repoRoot, "tmp", "document-parser-bakeoff-cache");

const require = createRequire(import.meta.url);
const xlsx = require(path.join(frontendRoot, "node_modules", "@e965", "xlsx"));
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "document-parser-bakeoff.cjs"), {
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
    cacheDir: valueAfter("--cache-dir", defaultCacheDir),
    providers: valueAfter(
      "--providers",
      "local,docling,firecrawl-auto,firecrawl-ocr,mistral-ocr,llamaparse-agentic",
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    format: valueAfter("--format", "pdf").toLowerCase(),
    only: valueAfter("--only"),
    limit: valueAfter("--limit") ? Math.max(1, Number(valueAfter("--limit"))) : null,
    concurrency: Math.max(1, Number(valueAfter("--concurrency", "4")) || 4),
    doclingConcurrency: Math.max(
      1,
      Number(valueAfter("--docling-concurrency", "1")) || 1,
    ),
    doclingCommand: valueAfter("--docling-command"),
    doclingArtifactsPath: valueAfter("--docling-artifacts-path"),
    doclingUseOcr: args.includes("--docling-ocr"),
    requestTimeoutMs: Math.max(
      5_000,
      Number(valueAfter("--request-timeout-ms", "180000")) || 180_000,
    ),
    noCache: args.includes("--no-cache"),
    skipReport: args.includes("--skip-report"),
    dumpMismatches: args.includes("--dump-mismatches"),
  };
}

async function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return [];
  const loaded = [];
  const text = await readFile(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
    loaded.push(match[1]);
  }
  return loaded;
}

async function loadLocalEnv() {
  const envFiles = [
    path.join(repoRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(frontendRoot, ".env"),
    path.join(frontendRoot, ".env.local"),
  ];
  const loaded = new Set();
  for (const filePath of envFiles) {
    for (const key of await loadEnvFile(filePath)) {
      loaded.add(key);
    }
  }
  return [...loaded].sort();
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
  if (match?.type === "ordered") bucket.orderedTextMatches += 1;
  if (match && match.type !== "fuzzy") bucket.strictTextMatches += 1;
  if (match) bucket.alignedTextMatches += 1;
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
    throw new Error(`Missing fasit workbook: ${fasitPath}`);
  }

  const workbook = xlsx.readFile(fasitPath);
  const sheet = workbook.Sheets["Alle krav"];
  if (!sheet) {
    throw new Error(`Fasit workbook is missing sheet "Alle krav": ${fasitPath}`);
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
  if (!expectedType) return false;
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

function scoreDocument({ rows, ledger, timingMs, parser }) {
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
    provider: parser,
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

function projectDocumentDetailFromParsed({ filePath, parsed, buffer, projectId }) {
  const now = new Date(0).toISOString();
  const fileName = path.basename(filePath);

  return {
    id: `${projectId}-${fileName}-${parsed.parserUsed}`,
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

function buildExternalSourceMap({ providerId, rawText, pages = [] }) {
  if (Array.isArray(pages) && pages.length > 0) {
    return pages
      .map((page, index) => {
        const text = normalizeInlineText(page?.markdown ?? page?.text ?? page ?? "");
        if (!text) return null;
        const pageNumber = Number(page?.index ?? page?.page ?? index) + 1;
        return {
          reference: `Kravgrunnlag - ${providerId} page ${pageNumber}`,
          text,
          kind: "docling_markdown",
          parser: providerId,
          page: pageNumber,
        };
      })
      .filter(Boolean);
  }

  const text = normalizeInlineText(rawText);
  return text
    ? [
        {
          reference: `Kravgrunnlag - ${providerId}`,
          text,
          kind: "docling_markdown",
          parser: providerId,
          page: null,
        },
      ]
    : [];
}

function parsedUploadFromExternal({
  providerId,
  buffer,
  fileName,
  fileFormat,
  contentType,
  rawText,
  sourceMap,
  pages,
}) {
  const normalizedRawText = String(rawText ?? "").replace(/\u0000/g, "").trim();
  if (!normalizedRawText) {
    throw new Error(`${providerId} returned no readable text`);
  }
  return {
    rawText: normalizedRawText,
    contentType,
    fileName,
    fileFormat,
    fileBase64: buffer.toString("base64"),
    sourceMap:
      Array.isArray(sourceMap) && sourceMap.length > 0
        ? sourceMap
        : buildExternalSourceMap({ providerId, rawText: normalizedRawText, pages }),
    parserUsed: providerId,
  };
}

function cacheFilePath({ cacheDir, providerId, filePath, buffer }) {
  const hash = createHash("sha256")
    .update(providerId)
    .update("\0")
    .update(path.basename(filePath))
    .update("\0")
    .update(buffer)
    .digest("hex");
  return path.join(cacheDir, providerId, `${hash}.json`);
}

async function readParseCache(cachePath) {
  if (!existsSync(cachePath)) return null;
  const value = JSON.parse(await readFile(cachePath, "utf8"));
  if (!value || typeof value.rawText !== "string") return null;
  return value;
}

async function writeParseCache(cachePath, value) {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(value, null, 2), "utf8");
}

function commandPath(command) {
  if (!command) return null;
  if (command.includes("/") && existsSync(command)) return command;
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

async function fetchJsonWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      const body = text.length > 600 ? `${text.slice(0, 600)}...` : text;
      throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function getApiKey(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function contentTypeForFile(fileFormat) {
  return contentTypeForUploadFormat(fileFormat);
}

function firecrawlProvider(id, mode) {
  return {
    id,
    label: `Firecrawl ${mode}`,
    concurrencyKind: "cloud",
    skipReason() {
      return getApiKey("FIRECRAWL_API_KEY") ? null : "Missing FIRECRAWL_API_KEY";
    },
    async parse({ buffer, fileName, fileFormat, contentType, options }) {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: contentType }), fileName);
      form.append(
        "options",
        JSON.stringify({
          formats: ["markdown"],
          parsers: [{ type: "pdf", mode }],
          zeroDataRetention: false,
        }),
      );
      const json = await fetchJsonWithTimeout(
        "https://api.firecrawl.dev/v2/parse",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${getApiKey("FIRECRAWL_API_KEY")}`,
          },
          body: form,
        },
        options.requestTimeoutMs,
      );
      const rawText =
        json?.data?.markdown ??
        json?.markdown ??
        json?.data?.content ??
        json?.content ??
        "";
      return parsedUploadFromExternal({
        providerId: id,
        buffer,
        fileName,
        fileFormat,
        contentType,
        rawText,
      });
    },
  };
}

const providers = {
  local: {
    id: "local",
    label: "local pdf-parse/DOCX",
    concurrencyKind: "local",
    skipReason() {
      return null;
    },
    async parse({ buffer, fileName, contentType }) {
      return extractTextFromBuffer({
        buffer,
        fileName,
        contentType,
        role: "requirement",
        useDocling: false,
      });
    },
  },
  docling: {
    id: "docling",
    label: "Docling CLI",
    concurrencyKind: "docling",
    skipReason(options) {
      const resolved = commandPath(
        options.doclingCommand || process.env.DOCLING_CLI_COMMAND || "docling",
      );
      return resolved ? null : "Docling CLI not found";
    },
    async parse({ buffer, fileName, contentType, options }) {
      const resolved = commandPath(
        options.doclingCommand || process.env.DOCLING_CLI_COMMAND || "docling",
      );
      if (!resolved) throw new Error("Docling CLI not found");
      process.env.DOCLING_INGESTION = "on";
      process.env.DOCLING_FORMATS = process.env.DOCLING_FORMATS || "all";
      process.env.DOCLING_CLI_COMMAND = resolved;
      process.env.DOCLING_TIMEOUT_MS = process.env.DOCLING_TIMEOUT_MS || "600000";
      process.env.DOCLING_IMAGE_EXPORT_MODE =
        process.env.DOCLING_IMAGE_EXPORT_MODE || "placeholder";
      if (options.doclingArtifactsPath) {
        process.env.DOCLING_ARTIFACTS_PATH = options.doclingArtifactsPath;
      }

      const parsed = await extractTextFromBuffer({
        buffer,
        fileName,
        contentType,
        role: "requirement",
        useDocling: true,
        useDoclingOcr: options.doclingUseOcr,
      });
      if (parsed.parserUsed !== "docling") {
        throw new Error(`Docling fell back to ${parsed.parserUsed}`);
      }
      return parsed;
    },
  },
  "firecrawl-auto": firecrawlProvider("firecrawl-auto", "auto"),
  "firecrawl-ocr": firecrawlProvider("firecrawl-ocr", "ocr"),
  "mistral-ocr": {
    id: "mistral-ocr",
    label: "Mistral OCR",
    concurrencyKind: "cloud",
    skipReason() {
      return getApiKey("MISTRAL_API_KEY") ? null : "Missing MISTRAL_API_KEY";
    },
    async parse({ buffer, fileName, fileFormat, contentType, options }) {
      const base64 = buffer.toString("base64");
      const json = await fetchJsonWithTimeout(
        "https://api.mistral.ai/v1/ocr",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${getApiKey("MISTRAL_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "mistral-ocr-latest",
            document: {
              type: "document_url",
              document_url: `data:${contentType};base64,${base64}`,
            },
            table_format: "markdown",
          }),
        },
        options.requestTimeoutMs,
      );
      const pages = Array.isArray(json?.pages) ? json.pages : [];
      const rawText = pages
        .map((page) => {
          const pageNumber = Number(page?.index ?? 0) + 1;
          const markdown = String(page?.markdown ?? "").trim();
          return markdown ? `[[SIDE:${pageNumber}]]\n${markdown}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
      return parsedUploadFromExternal({
        providerId: "mistral-ocr",
        buffer,
        fileName,
        fileFormat,
        contentType,
        rawText,
        pages,
      });
    },
  },
  "llamaparse-agentic": {
    id: "llamaparse-agentic",
    label: "LlamaParse agentic",
    concurrencyKind: "cloud",
    skipReason() {
      return getApiKey("LLAMA_CLOUD_API_KEY", "LLAMA_PARSE_API_KEY")
        ? null
        : "Missing LLAMA_CLOUD_API_KEY";
    },
    async parse({ buffer, fileName, fileFormat, contentType, options }) {
      const apiKey = getApiKey("LLAMA_CLOUD_API_KEY", "LLAMA_PARSE_API_KEY");
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: contentType }), fileName);
      form.append("purpose", "parse");
      const uploaded = await fetchJsonWithTimeout(
        "https://api.cloud.llamaindex.ai/api/v1/beta/files",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        },
        options.requestTimeoutMs,
      );
      const fileId = uploaded?.id ?? uploaded?.file?.id ?? uploaded?.data?.id;
      if (!fileId) {
        throw new Error(`LlamaCloud file upload did not return an id`);
      }
      const started = await fetchJsonWithTimeout(
        "https://api.cloud.llamaindex.ai/api/v2/parse",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            file_id: fileId,
            tier: "agentic",
            version: "latest",
          }),
        },
        options.requestTimeoutMs,
      );
      const jobId = started?.job?.id ?? started?.id ?? started?.data?.id;
      if (!jobId) {
        throw new Error(`LlamaParse did not return a job id`);
      }

      let result = null;
      const deadline = Date.now() + options.requestTimeoutMs;
      while (Date.now() < deadline) {
        result = await fetchJsonWithTimeout(
          `https://api.cloud.llamaindex.ai/api/v2/parse/${jobId}?expand=markdown,markdown_full,metadata`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
          Math.min(30_000, options.requestTimeoutMs),
        );
        const status = result?.job?.status ?? result?.status;
        if (status === "COMPLETED") break;
        if (status === "FAILED" || status === "CANCELLED") {
          throw new Error(result?.job?.error_message || `LlamaParse ${status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }

      const finalStatus = result?.job?.status ?? result?.status;
      if (finalStatus !== "COMPLETED") {
        throw new Error(`LlamaParse timed out waiting for job ${jobId}`);
      }
      const pages = Array.isArray(result?.markdown?.pages)
        ? result.markdown.pages
        : [];
      const rawText =
        result?.markdown_full ??
        result?.markdownFull ??
        pages
          .map((page) => {
            const pageNumber = Number(page?.page ?? page?.index ?? 0) + 1;
            const markdown = String(page?.markdown ?? page?.text ?? "").trim();
            return markdown ? `[[SIDE:${pageNumber}]]\n${markdown}` : "";
          })
          .filter(Boolean)
          .join("\n\n");

      return parsedUploadFromExternal({
        providerId: "llamaparse-agentic",
        buffer,
        fileName,
        fileFormat,
        contentType,
        rawText,
        pages,
      });
    },
  },
};

async function parseWithProvider({ provider, filePath, buffer, options }) {
  const fileName = path.basename(filePath);
  const fileFormat = inferUploadFileFormat({ fileName });
  const contentType = contentTypeForFile(fileFormat);
  const cachePath = cacheFilePath({
    cacheDir: options.cacheDir,
    providerId: provider.id,
    filePath,
    buffer,
  });

  if (!options.noCache && provider.id !== "local") {
    const cached = await readParseCache(cachePath);
    if (cached) {
      const parsed = parsedUploadFromExternal({
        providerId: provider.id,
        buffer,
        fileName,
        fileFormat,
        contentType,
        rawText: cached.rawText,
        sourceMap: cached.sourceMap,
      });
      return { parsed, cacheHit: true, cachePath, cachedTimingMs: cached.timingMs };
    }
  }

  const startedAt = performance.now();
  const parsed = await provider.parse({
    buffer,
    fileName,
    fileFormat,
    contentType,
    options,
  });
  const parseMs = Math.round(performance.now() - startedAt);

  if (!options.noCache && provider.id !== "local") {
    await writeParseCache(cachePath, {
      provider: provider.id,
      fileName,
      generatedAt: new Date().toISOString(),
      rawText: parsed.rawText,
      sourceMap: parsed.sourceMap,
      parserUsed: parsed.parserUsed,
      timingMs: parseMs,
    });
  }

  return { parsed, cacheHit: false, cachePath, cachedTimingMs: null, parseMs };
}

async function runDocumentWithProvider({ provider, rows, filesByBaseName, options }) {
  const projectId = normalizeInlineText(rows[0]?.["Prosjekt ID"]);
  const documentName = normalizeInlineText(rows[0]?.["Bilag 2-fil"]);
  const filePath = filesByBaseName.get(documentName);
  if (!filePath) {
    throw new Error(`Missing Bilag 2 file from fasit: ${documentName}`);
  }

  const startedAt = performance.now();
  const buffer = await readFile(filePath);
  const parsedResult = await parseWithProvider({ provider, filePath, buffer, options });
  const parsedAt = performance.now();
  const document = projectDocumentDetailFromParsed({
    filePath,
    parsed: parsedResult.parsed,
    buffer,
    projectId,
  });
  const ledger = await extractRequirementLedgerForDocument(document);
  const scoredAt = performance.now();
  const parseTiming = parsedResult.cacheHit
    ? Number(parsedResult.cachedTimingMs ?? 0)
    : Math.round(parsedAt - startedAt);

  return {
    ...scoreDocument({
      rows,
      ledger,
      parser: provider.id,
      timingMs: {
        total: Math.round(scoredAt - startedAt),
        parse: parseTiming,
        ledger: Math.round(scoredAt - parsedAt),
      },
    }),
    cacheHit: parsedResult.cacheHit,
  };
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function timingStats(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return { avg: 0, p50: 0, p90: 0, max: 0 };
  }
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    avg: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: percentile(0.5),
    p90: percentile(0.9),
    max: sorted[sorted.length - 1],
  };
}

function summarizeProvider({ provider, documents, failures, skippedReason }) {
  if (skippedReason) {
    return {
      id: provider.id,
      label: provider.label,
      status: "skipped",
      skippedReason,
      metrics: finalizeBucket(emptyBucket("overall")),
      failures: 0,
      documents: [],
      cacheHits: 0,
      timing: {
        parse: timingStats([]),
        ledger: timingStats([]),
        total: timingStats([]),
      },
    };
  }

  const overallBucket = emptyBucket("overall");
  const bucketsByStructuregrad = new Map();
  const bucketsByKravtype = new Map();
  for (const result of documents) {
    if (result.error) continue;
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
  }

  const successfulDocuments = documents.filter((document) => !document.error);
  return {
    id: provider.id,
    label: provider.label,
    status: failures.length ? "completed_with_failures" : "completed",
    metrics: {
      overall: finalizeBucket(overallBucket),
      byStructuregrad: [...bucketsByStructuregrad.values()]
        .map(finalizeBucket)
        .sort((left, right) => left.name.localeCompare(right.name, "nb")),
      byKravtype: [...bucketsByKravtype.values()]
        .map(finalizeRequirementTypeBucket)
        .sort((left, right) => left.name.localeCompare(right.name, "nb")),
    },
    failures: failures.length,
    cacheHits: successfulDocuments.filter((document) => document.cacheHit).length,
    timing: {
      parse: timingStats(successfulDocuments.map((document) => document.timingMs?.parse)),
      ledger: timingStats(successfulDocuments.map((document) => document.timingMs?.ledger)),
      total: timingStats(successfulDocuments.map((document) => document.timingMs?.total)),
    },
    documents,
  };
}

async function runProvider({ provider, documentGroups, filesByBaseName, options }) {
  const skippedReason = provider.skipReason(options);
  if (skippedReason) {
    console.log(`[${provider.id}] skipped: ${skippedReason}`);
    return summarizeProvider({ provider, documents: [], failures: [], skippedReason });
  }

  const concurrency =
    provider.concurrencyKind === "docling"
      ? options.doclingConcurrency
      : options.concurrency;
  console.log(
    `[${provider.id}] running ${documentGroups.length} docs with concurrency ${concurrency}`,
  );

  const failures = [];
  const documents = await mapLimit(documentGroups, concurrency, async (rows, index) => {
    const projectId = normalizeInlineText(rows[0]?.["Prosjekt ID"]);
    const documentName = normalizeInlineText(rows[0]?.["Bilag 2-fil"]);
    try {
      const result = await runDocumentWithProvider({
        provider,
        rows,
        filesByBaseName,
        options,
      });
      console.log(
        `[${provider.id}] ${index + 1}/${documentGroups.length} ${projectId} ${documentName}: strict ${result.strictTextMatches}/${result.expectedCount}, id ${result.metrics.idAccuracy}%, heading ${result.metrics.headingAccuracy}%, parse ${result.timingMs.parse}ms${result.cacheHit ? " cache" : ""}`,
      );
      if (options.dumpMismatches) {
        for (const mismatch of result.mismatches.slice(0, 3)) {
          console.log(
            `  ${mismatch.fasitRef} ${mismatch.matchType}: id "${mismatch.actualId}" vs "${mismatch.expectedId}", heading "${mismatch.actualHeading}" vs "${mismatch.expectedHeading}"`,
          );
        }
      }
      return result;
    } catch (error) {
      const failure = {
        provider: provider.id,
        projectId,
        documentName,
        format: normalizeInlineText(rows[0]?.Format),
        structuregrad: normalizeInlineText(rows[0]?.Strukturgrad) || "ukjent",
        expectedCount: rows.length,
        actualCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      failures.push(failure);
      console.log(
        `[${provider.id}] ${index + 1}/${documentGroups.length} ${projectId} ${documentName}: FAILED ${failure.error}`,
      );
      return failure;
    }
  });

  return summarizeProvider({ provider, documents, failures });
}

function providerScore(providerSummary) {
  const overall = providerSummary.metrics?.overall;
  if (!overall?.documents) return -1;
  return (
    ratio(overall.strictTextMatches, overall.expectedRequirements) * 0.45 +
    ratio(
      overall.usableIdCorrect + overall.syntheticIdTypeCorrect,
      overall.usableIdExpected + overall.syntheticIdExpected,
    ) *
      0.25 +
    ratio(overall.headingCorrect, overall.headingExpected) * 0.25 +
    ratio(overall.sourceLocatorPresent, overall.sourceLocatorExpected) * 0.05
  );
}

function markdownTable(rows) {
  return rows.join("\n");
}

function renderReport(summary) {
  const providerRows = [
    "| Provider | Status | Docs | Failures | Cache | Req | Count | Strict text | Aligned text | ID | Heading | Locator | Avg parse | P90 parse | Avg total |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.providers.map((provider) => {
      const overall = provider.metrics?.overall ?? finalizeBucket(emptyBucket("overall"));
      return `| ${provider.label} | ${provider.status}${provider.skippedReason ? ` (${provider.skippedReason})` : ""} | ${overall.documents} | ${provider.failures} | ${provider.cacheHits} | ${overall.expectedRequirements} | ${overall.countAccuracy}% | ${overall.strictTextRecall}% | ${overall.alignedTextAccuracy}% | ${overall.idAccuracy}% | ${overall.headingAccuracy}% | ${overall.sourceLocatorPresence}% | ${provider.timing.parse.avg}ms | ${provider.timing.parse.p90}ms | ${provider.timing.total.avg}ms |`;
    }),
  ];

  const ranked = [...summary.providers]
    .filter((provider) => provider.status !== "skipped")
    .sort((left, right) => providerScore(right) - providerScore(left));

  const winner = ranked[0];
  const winnerText = winner
    ? `Best measured parser: **${winner.label}** (${winner.metrics.overall.strictTextRecall}% strict text, ${winner.metrics.overall.idAccuracy}% ID, ${winner.metrics.overall.headingAccuracy}% heading).`
    : "No parser completed.";

  const worstSections = ranked
    .map((provider) => {
      const rows = provider.documents
        .filter((document) => !document.error)
        .map((document) => ({
          document,
          score:
            ratio(document.strictTextMatches, document.expectedCount) * 0.45 +
            ratio(
              document.usableIdCorrect + document.syntheticIdTypeCorrect,
              document.usableIdExpected + document.syntheticIdExpected,
            ) *
              0.25 +
            ratio(document.headingCorrect, document.headingExpected) * 0.25 +
            ratio(document.sourceLocatorPresent, document.sourceLocatorExpected) *
              0.05,
        }))
        .sort((left, right) => left.score - right.score)
        .slice(0, 8)
        .map(({ document }) => {
          const firstMismatch = document.mismatches?.[0];
          return `| ${document.projectId} | ${document.documentName} | ${document.actualCount}/${document.expectedCount} | ${document.metrics.strictTextRecall}% | ${document.metrics.idAccuracy}% | ${document.metrics.headingAccuracy}% | ${firstMismatch ? `${firstMismatch.fasitRef}: ${firstMismatch.matchType}` : ""} |`;
        });
      return [
        `### ${provider.label}`,
        "",
        "| Prosjekt | Bilag 2 | Count | Strict | ID | Heading | First mismatch |",
        "|---|---|---:|---:|---:|---:|---|",
        ...rows,
        "",
      ].join("\n");
    })
    .join("\n");

  return [
    "# Document Parser Bake-off",
    "",
    `Generated: ${summary.generatedAt}`,
    `Dataset: \`${summary.datasetRoot}\``,
    `Format filter: \`${summary.options.format}\``,
    `Documents selected: ${summary.documentCount}`,
    `No-cache run: ${summary.options.noCache ? "yes" : "no"}`,
    "",
    "## Result",
    "",
    winnerText,
    "",
    markdownTable(providerRows),
    "",
    "## Method",
    "",
    "- Each parser produced text/markdown for the same Bilag 2 files.",
    "- The app's existing deterministic requirement-ledger extractor was run on each parser output.",
    "- Strict text recall counts exact normalized one-to-one requirement text matches, including unordered matches, but excludes the legacy fuzzy substring fallback.",
    "- Aligned text accuracy includes strict matches plus the long-row fuzzy fallback.",
    "- Cloud provider results are skipped when the required API key is absent. Non-local parse outputs are cached under `tmp/document-parser-bakeoff-cache` unless `--no-cache` is used.",
    "",
    "## Lowest Scoring Documents",
    "",
    worstSections || "No completed providers.",
  ].join("\n");
}

async function main() {
  const options = parseArgs();
  const loadedEnvKeys = await loadLocalEnv();
  const rows = loadWorkbookRows(options.datasetRoot);
  const groupedRows = groupRowsByDocument(rows);
  const filesByBaseName = await discoverRequirementFiles(options.datasetRoot);
  let documentGroups = groupedRows;

  if (options.format && options.format !== "all") {
    documentGroups = documentGroups.filter(
      (documentRows) =>
        normalizeInlineText(documentRows[0]?.Format).toLowerCase() === options.format,
    );
  }
  if (options.only) {
    documentGroups = documentGroups.filter((documentRows) => {
      const projectId = normalizeInlineText(documentRows[0]?.["Prosjekt ID"]);
      const documentName = normalizeInlineText(documentRows[0]?.["Bilag 2-fil"]);
      return projectId === options.only || documentName.includes(options.only);
    });
  }
  if (options.limit) {
    documentGroups = documentGroups.slice(0, options.limit);
  }

  const providerList = options.providers.map((id) => {
    const provider = providers[id];
    if (!provider) {
      throw new Error(
        `Unknown provider "${id}". Known providers: ${Object.keys(providers).join(", ")}`,
      );
    }
    return provider;
  });

  console.log(
    JSON.stringify(
      {
        event: "bakeoff_start",
        datasetRoot: options.datasetRoot,
        documents: documentGroups.length,
        format: options.format,
        providers: providerList.map((provider) => provider.id),
        loadedEnvKeys: loadedEnvKeys.filter((key) =>
          /FIRECRAWL|MISTRAL|LLAMA|DOCLING/.test(key),
        ),
      },
      null,
      2,
    ),
  );

  const providerSummaries = [];
  for (const provider of providerList) {
    providerSummaries.push(
      await runProvider({ provider, documentGroups, filesByBaseName, options }),
    );
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    datasetRoot: options.datasetRoot,
    outputPath: options.outputPath,
    reportPath: options.reportPath,
    documentCount: documentGroups.length,
    options: {
      format: options.format,
      providers: providerList.map((provider) => provider.id),
      concurrency: options.concurrency,
      doclingConcurrency: options.doclingConcurrency,
      doclingUseOcr: options.doclingUseOcr,
      noCache: options.noCache,
      cacheDir: options.cacheDir,
    },
    providers: providerSummaries,
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
        event: "bakeoff_complete",
        outputPath: options.outputPath,
        reportPath: options.skipReport ? null : options.reportPath,
        providers: providerSummaries.map((provider) => ({
          id: provider.id,
          status: provider.status,
          skippedReason: provider.skippedReason,
          documents: provider.metrics?.overall?.documents ?? 0,
          strictTextRecall: provider.metrics?.overall?.strictTextRecall ?? 0,
          alignedTextAccuracy: provider.metrics?.overall?.alignedTextAccuracy ?? 0,
          idAccuracy: provider.metrics?.overall?.idAccuracy ?? 0,
          headingAccuracy: provider.metrics?.overall?.headingAccuracy ?? 0,
          avgParseMs: provider.timing?.parse?.avg ?? 0,
          p90ParseMs: provider.timing?.parse?.p90 ?? 0,
        })),
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
