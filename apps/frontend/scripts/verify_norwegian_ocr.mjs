#!/usr/bin/env node
// Opt-in local OCR evaluation: no cloud services, credentials or paid model calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const image = process.argv[2];
assert.ok(image, "Usage: node scripts/verify_norwegian_ocr.mjs <runner-docling-image>");
const frontend = path.resolve(import.meta.dirname, "..");
const fixtures = path.resolve(frontend, "../../test-data/ocr");
const jiti = createJiti(import.meta.url, {
  alias: { "@": frontend, "server-only": "/dev/null" },
});
const { extractTextFromBuffer } = await jiti.import(path.join(frontend, "lib/server/documents.ts"));
const normalizeSpacing = (value) => value.replace(/\s+/gu, " ").trim();
const directory = await mkdtemp(path.join(tmpdir(), "anbud-ocr-evaluation-"));
const command = path.join(directory, "docling.mjs");
const imageId = execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();

try {
  // The application constructs the real CLI arguments. Only translate host paths
  // into container mounts; preserve its OCR policy and run offline as non-root.
  await writeFile(command, `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output") + 1;
const input = args.at(-1);
const output = args[outputIndex];
chmodSync(output, 0o777);
args[outputIndex] = "/output";
args[args.length - 1] = "/input/source.pdf";
const name = "anbud-ocr-evaluation-" + process.pid;
try {
const result = spawnSync("docker", ["run", "--rm", "--name", name, "--network", "none", "--user", "1001:1001",
  "--mount", "type=bind,source=" + input + ",target=/input/source.pdf,readonly",
  "--mount", "type=bind,source=" + output + ",target=/output",
  "--entrypoint", "/opt/docling/bin/docling", ${JSON.stringify(imageId)}, ...args],
  { stdio: "inherit", timeout: 210000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
} finally {
  spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", timeout: 10000 });
}
`, { mode: 0o700 });
  Object.assign(process.env, {
    DOCLING_INGESTION: "on", DOCLING_FORMATS: "pdf", DOCLING_PDF_CHUNKING: "off",
    DOCLING_OCR: "auto", DOCLING_ARTIFACTS_PATH: "/opt/docling-models",
    DOCLING_TIMEOUT_MS: "240000", DOCLING_NUM_THREADS: "2",
    DOCLING_TABLE_MODE: "accurate", DOCLING_CLI_COMMAND: command,
  });
  const cases = JSON.parse(await readFile(path.join(fixtures, "expected.json"), "utf8"));
  for (const fixture of cases) {
    const buffer = await readFile(path.join(fixtures, fixture.file));
    assert.equal(createHash("sha256").update(buffer).digest("hex"), fixture.sha256);
    const start = Date.now();
    const parsed = await extractTextFromBuffer({
      buffer, fileName: fixture.file, useDocling: true, useDoclingOcr: true,
    });
    assert.equal(parsed.parserUsed, "docling", "Must exercise OCR, not a parser fallback");
    assert.equal(parsed.fileBase64, buffer.toString("base64"), "Original PDF must remain unchanged");
    assert.deepEqual([...new Set(parsed.sourceMap.map((entry) => entry.page))], fixture.pages.map((_, i) => i + 1));
    for (const [index, lines] of fixture.pages.entries()) {
      const source = parsed.sourceMap.filter((entry) => entry.page === index + 1);
      assert.ok(source.every((entry) => entry.docling_ref && entry.reference));
      assert.equal(normalizeSpacing(source.map((entry) => entry.text).join(" ")), lines.join(" "), `${fixture.file}, page ${index + 1}`);
      for (const line of lines) assert.ok(normalizeSpacing(parsed.rawText).includes(line), `Missing original text: ${line}`);
    }
    console.info(JSON.stringify({ file: fixture.file, sha256: fixture.sha256, imageId, pages: fixture.pages.length, exactText: true, elapsedMs: Date.now() - start }));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
