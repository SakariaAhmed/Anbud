import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PDFDocument, StandardFonts } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "pdf-parser-test.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { parsePdf } = jiti(path.join(frontendRoot, "lib/server/pdf-parser.ts"));

async function fixture(text) {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 200]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 24, y: 100, size: 12, font });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function textFromPdf(buffer) {
  return (await parsePdf(buffer)).text;
}

test("the compatibility parser isolates legacy state and keeps a hardened modern fallback", async () => {
  const source = await readFile(
    fileURLToPath(new URL("./pdf-parser.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /new Worker\(LEGACY_WORKER_SOURCE/);
  assert.match(source, /resourceLimits/);
  assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.mjs/);
  assert.match(source, /isEvalSupported: false/);
});

test("multiple PDFs parse sequentially in one process", async () => {
  const first = await fixture("K-08 first attachment");
  const second = await fixture("L-08 second attachment");

  assert.match(await textFromPdf(first), /K-08/);
  assert.match(await textFromPdf(second), /L-08/);
  assert.match(await textFromPdf(first), /K-08/);
});
