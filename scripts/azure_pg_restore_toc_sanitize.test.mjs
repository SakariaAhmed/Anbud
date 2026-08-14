import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validPreflightReport } from "./azure_cutover_evidence_test_fixtures.mjs";
import {
  TocSanitizationError,
  runCli,
  sanitizePgRestoreToc,
  sanitizePgRestoreTocFiles,
} from "./azure_pg_restore_toc_sanitize.mjs";

const VALID_TOC = `;
; Archive created at 2026-08-14 12:00:00 UTC
;     TOC Entries: 5
;     Compression: zstd
;     Dump Version: 1.16-0
;     Format: CUSTOM
;     Dumped from database version: 17.6
;     Dumped by pg_dump version: 17.6
;
; Selected TOC Entries:
;
5; 2615 2200 SCHEMA - public pg_database_owner
201; 1259 16400 TABLE public projects postgres
202; 0 16400 TABLE DATA public projects postgres
203; 1255 16401 FUNCTION public rls_auto_enable() postgres
204; 2606 16402 CONSTRAINT public projects projects_pkey postgres
`;

test("sanitizer deterministically comments only public schema and pinned platform function", () => {
  const report = validPreflightReport();
  const first = sanitizePgRestoreToc(VALID_TOC, report);
  const second = sanitizePgRestoreToc(VALID_TOC, report);
  assert.equal(first, second);
  assert.match(first, /^; ANBUD-SANITIZED: 5; 2615 2200 SCHEMA - public pg_database_owner$/mu);
  assert.match(
    first,
    /^; ANBUD-SANITIZED: 203; 1255 16401 FUNCTION public rls_auto_enable\(\) postgres$/mu,
  );
  assert.match(first, /^202; 0 16400 TABLE DATA public projects postgres$/mu);
  assert.equal((first.match(/ANBUD-SANITIZED/gu) || []).length, 2);
});

test("sanitizer requires exactly one schema and one exact platform function entry", () => {
  const report = validPreflightReport();
  const cases = [
    VALID_TOC.replace("5; 2615 2200 SCHEMA - public pg_database_owner\n", ""),
    VALID_TOC.replace(
      "5; 2615 2200 SCHEMA - public pg_database_owner\n",
      "5; 2615 2200 SCHEMA - public pg_database_owner\n6; 2615 2200 SCHEMA - public postgres\n",
    ),
    VALID_TOC.replace("203; 1255 16401 FUNCTION public rls_auto_enable() postgres\n", ""),
    VALID_TOC.replace(
      "203; 1255 16401 FUNCTION public rls_auto_enable() postgres",
      "203; 1255 16401 FUNCTION public rls_auto_enable(integer) postgres",
    ),
    VALID_TOC.replace(
      "203; 1255 16401 FUNCTION public rls_auto_enable() postgres",
      "203; 1255 16401 FUNCTION public rls_auto_enable() supabase_admin",
    ),
  ];
  for (const toc of cases) {
    assert.throws(() => sanitizePgRestoreToc(toc, report), TocSanitizationError);
  }
});

test("sanitizer binds removal to the frozen preflight fingerprint", () => {
  const wrongHash = validPreflightReport();
  wrongHash.source.security_definers.find(
    ({ name }) => name === "rls_auto_enable",
  ).source_sha256 = "f".repeat(64);
  assert.throws(
    () => sanitizePgRestoreToc(VALID_TOC, wrongHash),
    /toc_preflight_unverified|toc_rls_auto_enable_fingerprint_mismatch/u,
  );
});

test("sanitizer rejects privileges, event triggers, platform roles, and pre-commented entries", () => {
  const report = validPreflightReport();
  const forbidden = [
    "205; 0 0 ACL public TABLE projects postgres\n",
    "205; 0 0 DEFAULT ACL public DEFAULT PRIVILEGES FOR FUNCTIONS postgres\n",
    "205; 3466 16403 EVENT TRIGGER - issue_pg_cron_access postgres\n",
    "205; 1255 16403 FUNCTION public grant_pg_net_access() supabase_admin\n",
    "205; 1255 16403 FUNCTION public grant_pg_net_access() postgres\n",
    "205; 1255 16403 FUNCTION public app_function() unknown_owner\n",
    "; 205; 1255 16403 FUNCTION public hidden() postgres\n",
  ];
  for (const entry of forbidden) {
    const toc = VALID_TOC.replace(
      "; Selected TOC Entries:\n;\n",
      `; Selected TOC Entries:\n;\n${entry}`,
    );
    assert.throws(() => sanitizePgRestoreToc(toc, report), TocSanitizationError);
  }
});

test("sanitizer rejects non-custom or non-PostgreSQL-17 list files", () => {
  const report = validPreflightReport();
  assert.throws(
    () => sanitizePgRestoreToc(VALID_TOC.replace("Format: CUSTOM", "Format: TAR"), report),
    /toc_archive_header_invalid/u,
  );
  assert.throws(
    () =>
      sanitizePgRestoreToc(
        VALID_TOC.replace("Dumped by pg_dump version: 17.6", "Dumped by pg_dump version: 16.9"),
        report,
      ),
    /toc_archive_header_invalid/u,
  );
});

test("bootstrap owns restored schemas and verification enforces that owner", async () => {
  const bootstrap = await readFile(
    new URL("../infra/azure/postgres/bootstrap.sql", import.meta.url),
    "utf8",
  );
  const verification = await readFile(
    new URL("../infra/azure/postgres/verify.sql", import.meta.url),
    "utf8",
  );
  assert.match(bootstrap, /ALTER SCHEMA public OWNER TO anbud_owner;/u);
  assert.match(bootstrap, /ALTER SCHEMA extensions OWNER TO anbud_owner;/u);
  assert.match(
    verification,
    /namespace_state\.nspname IN \('public', 'extensions'\)[\s\S]*pg_get_userbyid\(namespace_state\.nspowner\) <> 'anbud_owner'/u,
  );
});

test("file sanitizer creates a mode-0600 output once and never clobbers it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbud-toc-sanitize-test-"));
  try {
    const inputFile = join(directory, "original.list");
    const preflightFile = join(directory, "preflight.json");
    const outputFile = join(directory, "sanitized.list");
    await writeFile(inputFile, VALID_TOC, { mode: 0o600 });
    await writeFile(preflightFile, `${JSON.stringify(validPreflightReport())}\n`, { mode: 0o600 });
    const result = await sanitizePgRestoreTocFiles({ inputFile, preflightFile, outputFile });
    assert.equal(result.status, "sanitized");
    assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
    const originalOutput = await readFile(outputFile, "utf8");
    await assert.rejects(
      sanitizePgRestoreTocFiles({ inputFile, preflightFile, outputFile }),
      /toc_output_write_failed/u,
    );
    assert.equal(await readFile(outputFile, "utf8"), originalOutput);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file sanitizer bounds input before parsing or writing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbud-toc-size-test-"));
  try {
    const inputFile = join(directory, "oversized.list");
    const preflightFile = join(directory, "preflight.json");
    const outputFile = join(directory, "sanitized.list");
    await writeFile(inputFile, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });
    await writeFile(preflightFile, `${JSON.stringify(validPreflightReport())}\n`, { mode: 0o600 });
    await assert.rejects(
      sanitizePgRestoreTocFiles({ inputFile, preflightFile, outputFile }),
      /toc_input_read_failed/u,
    );
    await assert.rejects(stat(outputFile), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI accepts paths only through environment variables and reports no contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbud-toc-cli-test-"));
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const output = [];
  process.stdout.write = (value) => {
    output.push(String(value));
    return true;
  };
  process.stderr.write = (value) => {
    output.push(String(value));
    return true;
  };
  try {
    const inputFile = join(directory, "original.list");
    const preflightFile = join(directory, "preflight.json");
    const outputFile = join(directory, "sanitized.list");
    await writeFile(inputFile, VALID_TOC, { mode: 0o600 });
    await writeFile(preflightFile, `${JSON.stringify(validPreflightReport())}\n`, { mode: 0o600 });
    assert.equal(
      await runCli({
        environment: {
          AZURE_TOC_INPUT_FILE: inputFile,
          AZURE_TOC_PREFLIGHT_FILE: preflightFile,
          AZURE_TOC_OUTPUT_FILE: outputFile,
        },
        argv: [],
      }),
      0,
    );
    assert.equal(await runCli({ environment: {}, argv: ["secret"] }), 2);
    assert.doesNotMatch(output.join(""), /projects|rls_auto_enable|original\.list/u);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    await rm(directory, { recursive: true, force: true });
  }
});
