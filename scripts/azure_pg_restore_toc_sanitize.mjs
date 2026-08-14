#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateFrozenPreflightReport } from "../apps/frontend/scripts/run_azure_migration_control.mjs";

const MAX_TOC_BYTES = 8 * 1024 * 1024;
const MAX_PREFLIGHT_BYTES = 2 * 1024 * 1024;
const PINNED_RLS_AUTO_ENABLE_SHA256 =
  "2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1";
const PLATFORM_ROLE_PATTERN =
  /(?:^|\s)(?:"?)(?:supabase(?:_[a-z0-9_]+)?|dashboard_user|authenticator|pgbouncer|pgsodium_[a-z0-9_]+)(?:"?)(?:\s|$)/iu;
const PLATFORM_OBJECT_PATTERN =
  /(?:^|[\s.])(?:supabase_[a-z0-9_]+|(?:grant|revoke|issue)_(?:pg_cron|pg_graphql|pg_net|pgsodium|realtime|storage|vault)[a-z0-9_]*)(?:\(|\s|$)/iu;
const FORBIDDEN_DESCRIPTOR_PATTERN = /^(?:ACL|DEFAULT ACL|EVENT TRIGGER)(?:\s|$)/u;
const PUBLIC_SCHEMA_ENTRY_PATTERN = /^SCHEMA - public (?:postgres|pg_database_owner)$/u;
const RLS_AUTO_ENABLE_ENTRY = "FUNCTION public rls_auto_enable() postgres";
const EXPECTED_OWNER_PATTERN = / (?:postgres|pg_database_owner)$/u;

export class TocSanitizationError extends Error {
  constructor(code) {
    super(code);
    this.name = "TocSanitizationError";
    this.code = code;
  }
}

function fail(code) {
  throw new TocSanitizationError(code);
}

function required(value, code) {
  const normalized = value?.trim();
  if (!normalized) fail(code);
  return normalized;
}

function validatePinnedPreflight(report) {
  try {
    validateFrozenPreflightReport(report);
  } catch {
    fail("toc_preflight_unverified");
  }
  const matches = report.source.security_definers.filter(
    (definition) => definition.name === "rls_auto_enable",
  );
  if (
    matches.length !== 1 ||
    matches[0].arguments !== "" ||
    matches[0].owner !== "postgres" ||
    matches[0].language !== "plpgsql" ||
    matches[0].result !== "event_trigger" ||
    matches[0].source_sha256 !== PINNED_RLS_AUTO_ENABLE_SHA256 ||
    matches[0].settings.length !== 1 ||
    matches[0].settings[0] !== "search_path=pg_catalog" ||
    matches[0].public_execute !== false ||
    matches[0].anon_execute !== false ||
    matches[0].authenticated_execute !== false ||
    matches[0].service_execute !== true
  ) {
    fail("toc_rls_auto_enable_fingerprint_mismatch");
  }
}

function parseTocEntry(line, seenDumpIds) {
  const match = /^(\d+); (\d+) (\d+) (.+)$/u.exec(line);
  if (!match) fail("toc_entry_invalid");
  if (seenDumpIds.has(match[1])) fail("toc_dump_id_duplicate");
  seenDumpIds.add(match[1]);
  return match[4];
}

export function sanitizePgRestoreToc(toc, preflight) {
  if (typeof toc !== "string" || !toc.endsWith("\n")) fail("toc_input_invalid");
  if (/\r|\u0000/u.test(toc) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(toc)) {
    fail("toc_input_control_character");
  }
  validatePinnedPreflight(preflight);

  let customFormat = false;
  let postgres17 = false;
  let selectedEntriesHeader = false;
  let publicSchemaEntries = 0;
  let rlsAutoEnableEntries = 0;
  let tocEntries = 0;
  const seenDumpIds = new Set();
  const output = [];

  for (const line of toc.slice(0, -1).split("\n")) {
    if (line.startsWith(";")) {
      if (/^;\s*\d+;/u.test(line)) fail("toc_contains_precommented_entry");
      if (/^;\s+Format: CUSTOM$/u.test(line)) customFormat = true;
      if (/^;\s+Dumped by pg_dump version: 17(?:\.|$)/u.test(line)) postgres17 = true;
      if (/^;\s+Selected TOC Entries:$/u.test(line)) selectedEntriesHeader = true;
      output.push(line);
      continue;
    }
    if (!line) fail("toc_entry_invalid");
    const body = parseTocEntry(line, seenDumpIds);
    tocEntries += 1;

    if (FORBIDDEN_DESCRIPTOR_PATTERN.test(body)) fail("toc_forbidden_privileged_entry");
    if (
      PLATFORM_ROLE_PATTERN.test(body) ||
      PLATFORM_OBJECT_PATTERN.test(body) ||
      !EXPECTED_OWNER_PATTERN.test(body)
    ) {
      fail("toc_unknown_supabase_platform_entry");
    }

    if (PUBLIC_SCHEMA_ENTRY_PATTERN.test(body)) {
      publicSchemaEntries += 1;
      output.push(`; ANBUD-SANITIZED: ${line}`);
      continue;
    }
    if (body.includes("rls_auto_enable")) {
      if (body !== RLS_AUTO_ENABLE_ENTRY) fail("toc_unknown_rls_auto_enable_entry");
      rlsAutoEnableEntries += 1;
      output.push(`; ANBUD-SANITIZED: ${line}`);
      continue;
    }
    output.push(line);
  }

  if (!customFormat || !postgres17 || !selectedEntriesHeader || tocEntries === 0) {
    fail("toc_archive_header_invalid");
  }
  if (publicSchemaEntries !== 1) fail("toc_public_schema_entry_count_invalid");
  if (rlsAutoEnableEntries !== 1) fail("toc_rls_auto_enable_entry_count_invalid");

  return `${output.join("\n")}\n`;
}

async function readStableFile(file, maximumBytes, errorCode) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch {
    fail(errorCode);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) fail(errorCode);
    const chunks = [];
    let size = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maximumBytes) fail(errorCode);
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, size);
    const after = await handle.stat();
    if (
      size !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      fail(`${errorCode}_changed_during_read`);
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function decodeUtf8(bytes, errorCode) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(errorCode);
  }
}

async function writeAtomicNoClobber(file, contents) {
  const temporary = resolve(
    dirname(file),
    `.${basename(file)}.${randomBytes(10).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, file);
    await unlink(temporary);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    fail("toc_output_write_failed");
  }
}

export async function sanitizePgRestoreTocFiles({ inputFile, preflightFile, outputFile }) {
  const input = resolve(required(inputFile, "toc_input_file_missing"));
  const preflight = resolve(required(preflightFile, "toc_preflight_file_missing"));
  const output = resolve(required(outputFile, "toc_output_file_missing"));
  if (new Set([input, preflight, output]).size !== 3) fail("toc_file_path_reused");

  const [tocBytes, preflightBytes] = await Promise.all([
    readStableFile(input, MAX_TOC_BYTES, "toc_input_read_failed"),
    readStableFile(preflight, MAX_PREFLIGHT_BYTES, "toc_preflight_read_failed"),
  ]);
  let report;
  try {
    report = JSON.parse(decodeUtf8(preflightBytes, "toc_preflight_utf8_invalid"));
  } catch (error) {
    if (error instanceof TocSanitizationError) throw error;
    fail("toc_preflight_json_invalid");
  }
  const sanitized = sanitizePgRestoreToc(
    decodeUtf8(tocBytes, "toc_input_utf8_invalid"),
    report,
  );
  await writeAtomicNoClobber(output, sanitized);
  return {
    status: "sanitized",
    commentedEntries: 2,
    outputBytes: Buffer.byteLength(sanitized, "utf8"),
  };
}

export async function runCli({ environment = process.env, argv = process.argv.slice(2) } = {}) {
  try {
    if (argv.length !== 0) fail("toc_cli_arguments_forbidden");
    const result = await sanitizePgRestoreTocFiles({
      inputFile: environment.AZURE_TOC_INPUT_FILE,
      preflightFile: environment.AZURE_TOC_PREFLIGHT_FILE,
      outputFile: environment.AZURE_TOC_OUTPUT_FILE,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        status: "stop",
        code: error?.code || "toc_sanitization_failed",
      })}\n`,
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
