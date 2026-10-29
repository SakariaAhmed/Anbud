import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": frontend, "server-only": "/dev/null" },
});
const { extractTextFromBuffer } = await jiti.import(path.join(frontend, "lib/server/documents.ts"));
const text = "Ærlig vurdering av Østfold og Ålesund. Leverandøren holder fire kurs før oppstart om 14 måneder.";

function conversion(t, { retry = false, configuredOcr = "auto", failure = "" } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-ocr-test-"));
  const command = path.join(directory, "docling-test.mjs");
  const callsPath = path.join(directory, "calls.json");
  writeFileSync(command, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const file = ${JSON.stringify(callsPath)};
const calls = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const args = process.argv.slice(2);
calls.push(args);
writeFileSync(file, JSON.stringify(calls));
if (${JSON.stringify(failure)} === "timeout") {
  process.stderr.write("No such option: --document-timeout");
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (${JSON.stringify(failure)} === "missing-model") {
  process.stderr.write("Error opening data file nor.traineddata");
  process.exit(1);
}
if (${retry} && calls.length === 1) {
  process.stderr.write("No such option: --document-timeout");
  process.exit(2);
}
writeFileSync(path.join(args[args.indexOf("--output") + 1], "source.md"), ${JSON.stringify(text)});
`, { mode: 0o700 });
  const settings = {
    DOCLING_INGESTION: "on", DOCLING_FORMATS: "pdf", DOCLING_PDF_CHUNKING: "off",
    DOCLING_OCR: configuredOcr, DOCLING_ARTIFACTS_PATH: "/test/bundled-models",
    DOCLING_CLI_COMMAND: command,
    DOCLING_TIMEOUT_MS: failure === "timeout" ? "1000" : "10000",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return () => existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, "utf8")) : [];
}

for (const retry of [false, true]) {
  test(`OCR uses Norwegian-capable recognition and preserves source characters${retry ? " through CLI compatibility retry" : ""}`, async (t) => {
    const calls = conversion(t, { retry, configuredOcr: "off" });
    const buffer = Buffer.from("%PDF-1.7\nsynthetic subprocess boundary");
    const parsed = await extractTextFromBuffer({ buffer, fileName: "scan.pdf", useDocling: true, useDoclingOcr: true });
    assert.equal(calls().length, retry ? 2 : 1);
    for (const args of calls()) {
      assert.equal(args[args.indexOf("--ocr-engine") + 1], "tesseract");
      assert.equal(args[args.indexOf("--ocr-lang") + 1], "nor,eng");
      assert.equal(args[args.indexOf("--artifacts-path") + 1], "/test/bundled-models");
      assert.ok(args.includes("--ocr"));
      assert.ok(!args.includes("--no-ocr"));
    }
    assert.equal(parsed.parserUsed, "docling");
    assert.equal(parsed.rawText, text);
    assert.ok(parsed.sourceMap.some((entry) => entry.text.includes("Østfold og Ålesund")));
    assert.equal(parsed.fileBase64, buffer.toString("base64"));
  });
}

test("explicit OCR-off survives compatibility retry for text-based PDFs", async (t) => {
  const calls = conversion(t, { retry: true, configuredOcr: "on" });
  await extractTextFromBuffer({ buffer: Buffer.from("%PDF-1.7\nsynthetic subprocess boundary"), fileName: "text.pdf", useDocling: true, useDoclingOcr: false });
  assert.equal(calls().length, 2);
  for (const args of calls()) {
    assert.ok(args.includes("--no-ocr"));
    assert.ok(!args.includes("--ocr"));
  }
});

test("automatic OCR selects Norwegian and English recognition", async (t) => {
  const calls = conversion(t);
  await extractTextFromBuffer({ buffer: Buffer.from("%PDF-1.7\nsynthetic subprocess boundary"), fileName: "scan.pdf", useDocling: true });
  assert.equal(calls().length, 1);
  assert.equal(calls()[0][calls()[0].indexOf("--ocr-engine") + 1], "tesseract");
  assert.equal(calls()[0][calls()[0].indexOf("--ocr-lang") + 1], "nor,eng");
});

for (const failure of ["timeout", "missing-model"]) {
  test(`OCR ${failure} does not retry with a different language or engine`, async (t) => {
    const calls = conversion(t, { failure });
    // Deliberately invalid PDF: the existing fast-parser fallback must also fail.
    await assert.rejects(extractTextFromBuffer({ buffer: Buffer.from("%PDF-1.7\nsynthetic subprocess boundary"), fileName: "scan.pdf", useDocling: true, useDoclingOcr: true }));
    assert.equal(calls().length, 1);
  });
}
