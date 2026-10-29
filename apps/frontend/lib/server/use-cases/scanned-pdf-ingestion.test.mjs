import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");
const scannedPdf = readFileSync(path.join(frontend, "../../test-data/ocr/norwegian-regression.pdf"));
const recognizedText = "Leverandøren holder fire kurs før oppstart om 14 måneder. VERIFIKASJON-84";

for (const scenario of ["scan", "ocr-failure", "readable-text"]) {
  test(`asynchronous ingestion handles ${scenario} before publishing readiness`, async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "scanned-ingestion-"));
    const command = path.join(directory, "docling.mjs");
    const callsFile = path.join(directory, "calls.json");
    writeFileSync(command, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args));
if (${JSON.stringify(scenario)} === "ocr-failure") process.exit(1);
writeFileSync(path.join(args[args.indexOf("--output") + 1], "source.md"), ${JSON.stringify(recognizedText)});
`, { mode: 0o700 });
    const settings = {
      DOCUMENT_ANALYSIS_VERSION: "off", DOCLING_INGESTION: "on", DOCLING_FORMATS: "pdf",
      DOCLING_ENHANCEMENT_MODE: "async", DOCLING_ASYNC_AUTO_RUN: "off",
      DOCLING_CLI_COMMAND: command, DOCLING_PDF_CHUNKING: "off", DOCLING_OCR: "auto",
    };
    const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
    Object.assign(process.env, settings);
    const isText = scenario === "readable-text";
    const document = {
      id: "scan", project_id: "project", role: "supporting_document", supporting_subtype: "vedlegg",
      title: "Utgivelsestest", file_name: isText ? "source.txt" : "source.pdf",
      file_format: isText ? "txt" : "pdf", content_type: isText ? "text/plain" : "application/pdf",
      file_size_bytes: isText ? Buffer.byteLength(recognizedText) : scannedPdf.length,
      file_base64: (isText ? Buffer.from(recognizedText) : scannedPdf).toString("base64"),
    };
    const state = { document, saves: [], statuses: [] };
    globalThis.__scannedPdfIngestion = state;
    t.after(() => {
      delete globalThis.__scannedPdfIngestion;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    });
    writeFileSync(path.join(directory, "store.cjs"), `
exports.getDocumentDetail = async () => globalThis.__scannedPdfIngestion.document;
exports.getProjectSnapshotAfterCommit = async () => null;
exports.updateDocumentProcessingState = async (input) => { globalThis.__scannedPdfIngestion.statuses.push(input.status); };
exports.saveDocumentIngestionResult = async (input) => {
  globalThis.__scannedPdfIngestion.saves.push(input);
  if (!input.rawText.includes("VERIFIKASJON-84")) throw new Error("DOCUMENT_INDEX_NOT_READY");
  return { ...globalThis.__scannedPdfIngestion.document, processing_status: input.status, parser_used: input.parserUsed };
};`);
    const jiti = createJiti(path.join(directory, "test.cjs"), { moduleCache: false, alias: {
      "@/lib/server/repositories/data-store": path.join(directory, "store.cjs"),
      "@": frontend, "server-only": "/dev/null",
    } });
    const { runProjectWorkflow } = await jiti.import(path.join(frontend, "lib/server/use-cases/project-workflows.ts"));
    const run = () => runProjectWorkflow({ kind: "document_ingestion", projectId: "project", documentId: "scan" }, { setProgress() {} });
    if (scenario === "ocr-failure") {
      await assert.rejects(run(), /ingen lesbar tekst/);
      assert.equal(state.saves.length, 0, "never publish page markers as indexed content");
      assert.equal(state.statuses.at(-1), "failed");
    } else {
      const result = await run();
      assert.equal(result.status, "enhanced_ready");
      assert.equal(result.docling_enhancement_requested ?? false, false);
      assert.equal(state.saves.length, 1);
      assert.equal(state.saves[0].rawText, recognizedText);
      assert.equal(state.saves[0].parserUsed === "docling", !isText);
    }
    if (!isText) {
      const args = JSON.parse(readFileSync(callsFile, "utf8"));
      assert.ok(args.includes("--ocr"));
      assert.equal(args[args.indexOf("--ocr-lang") + 1], "nor,eng");
    }
  });
}
