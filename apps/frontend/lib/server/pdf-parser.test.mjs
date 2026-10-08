import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import os from "node:os";
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

function legacyFixture(text) {
  const stream = `BT /F1 12 Tf 24 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = `%PDF-1.4\n%${"padding".repeat(1200)}\n`;
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function textFromPdf(buffer) {
  return (await parsePdf(buffer)).text;
}

test("multiple PDFs parse sequentially in one process", async () => {
  const first = await fixture("K-08 first attachment");
  const second = await fixture("L-08 second attachment");

  assert.match(await textFromPdf(first), /K-08/);
  assert.match(await textFromPdf(second), /L-08/);
  assert.match(await textFromPdf(first), /K-08/);
});


test("object-stream PDFs exercise the modern fallback and retain extractable text", async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([300, 200]).drawText("K-05 modern PDF", {x:24,y:100,size:12,font});
  assert.match(await textFromPdf(Buffer.from(await document.save())), /K-05 modern PDF/);
});

test("invalid PDF gets an actionable domain error", async () => {
  await assert.rejects(parsePdf(Buffer.from("This is not a PDF")), /INVALID_PDF_DOCUMENT/);
});

// Inject bounded worker faults and small extraction budgets into the production
// worker boundary; shorten only the deadline for the hung-worker regression.
async function workerHarness(t, settings = {}) {
  const directory = await mkdtemp(path.join(frontendRoot, ".pdf-worker-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stubPath = path.join(directory, "worker.cjs");
  await writeFile(stubPath, `
    const { Worker: RealWorker } = require("node:worker_threads");
    const state = { calls: [], messages: [], terminated: 0, settings: ${JSON.stringify(settings)} };
    class Worker extends RealWorker {
      constructor(source, options) {
        const { settings } = state;
        state.calls.push(options);
        options.workerData.limits = { ...options.workerData.limits, ...settings.limits };
        const engine = options.workerData.engine;
        if (settings[engine] === "compatibility") {
          source = 'require("node:worker_threads").parentPort.postMessage({ok:false,name:"InvalidPDFException",message:"compatibility failure"})';
        } else if (settings[engine] === "oom") {
          source = 'throw Object.assign(new Error("heap limit"), {code:"ERR_WORKER_OUT_OF_MEMORY"})';
        } else if (settings[engine] === "hang") {
          source = 'setInterval(() => {}, 1000)';
        } else if (settings[engine] === "exit") {
          source = '';
        }
        super(source, options);
        this.on("message", (message) => state.messages.push(message));
      }
      terminate() { state.terminated++; return super.terminate(); }
    }
    module.exports = { Worker, state };
  `);
  let source = await readFile(new URL("./pdf-parser.ts", import.meta.url), "utf8");
  source = source.replace('from "node:worker_threads"', `from ${JSON.stringify(stubPath)}`);
  if (settings.timeout) source = source.replace("120_000", String(settings.timeout));
  const modulePath = path.join(directory, "parser.ts");
  await writeFile(modulePath, source);
  const load = createJiti(modulePath, { alias: { "server-only": "/dev/null" }, moduleCache: false });
  const parser = load(modulePath);
  return { ...parser, state: require(stubPath).state };
}

test("modern compatibility parsing uses the same worker limits and preserves layout callbacks", async (t) => {
  const harness = await workerHarness(t, { legacy: "compatibility" });
  const seen = [];
  const result = await harness.parsePdf(await fixture("Modern isolated text"), (page, items) => {
    seen.push({ page, items });
    return items.map((item) => item.str).join(" ");
  });
  assert.match(result.text, /Modern isolated text/);
  assert.equal(seen[0].page, 1);
  assert.equal(seen[0].items[0].transform.length, 6);
  assert.deepEqual(harness.state.calls.map((call) => call.workerData.engine), ["legacy", "modern"]);
  assert.deepEqual(harness.state.calls[0].resourceLimits, harness.state.calls[1].resourceLimits);
  assert.equal(harness.state.terminated, 2);
});

for (const failure of ["oom", "hang", "exit"]) {
  test(`legacy ${failure} is terminal and never starts a fallback`, async (t) => {
    const harness = await workerHarness(t, { legacy: failure, timeout: failure === "hang" ? 50 : undefined });
    await assert.rejects(harness.parsePdf(await fixture("Rejected workload")),
      failure === "hang" ? /PDF_PARSE_TIMEOUT/ : failure === "oom" ? /heap limit/ : /exited before returning/);
    assert.equal(harness.state.calls.length, 1);
    assert.equal(harness.state.terminated, 1);
  });
}

for (const engine of ["legacy", "modern"]) {
  for (const [budget, maximum] of [["pages", 0], ["items", 0], ["textCharacters", 3]]) {
    test(`${engine} rejects cumulative ${budget} limits before returning extracted items`, async (t) => {
      const harness = await workerHarness(t, {
        ...(engine === "modern" ? { legacy: "compatibility" } : {}),
        limits: { [budget]: maximum },
      });
      let rendered = false;
      await assert.rejects(harness.parsePdf(legacyFixture("Budget rejection"), () => { rendered = true; return ""; }), /PDF_RESOURCE_LIMIT/);
      assert.equal(rendered, false);
      assert.equal(harness.state.calls.length, engine === "modern" ? 2 : 1, JSON.stringify(harness.state.messages));
      assert.equal(harness.state.terminated, harness.state.calls.length);
    });
  }
}

test("oversized PDF input is rejected before allocating a worker copy", async (t) => {
  const harness = await workerHarness(t);
  await assert.rejects(harness.parsePdf(Buffer.alloc(25 * 1024 * 1024 + 1)), /PDF_RESOURCE_LIMIT/);
  assert.equal(harness.state.calls.length, 0);
});

test("ordinary legacy PDF succeeds without compatibility retry", async (t) => {
  const harness = await workerHarness(t);
  assert.match((await harness.parsePdf(legacyFixture("Legacy supported text"))).text, /Legacy supported text/);
  assert.deepEqual(harness.state.calls.map((call) => call.workerData.engine), ["legacy"]);
  assert.equal(harness.state.terminated, 1);
});

test("modern compatibility worker timeout terminates both attempted workers", async (t) => {
  const harness = await workerHarness(t, { legacy: "compatibility", modern: "hang", timeout: 1000 });
  await assert.rejects(harness.parsePdf(legacyFixture("Timeout")), /PDF_PARSE_TIMEOUT/);
  assert.equal(harness.state.calls.length, 2);
  assert.equal(harness.state.terminated, 2);
});

for (const engine of ["legacy", "modern"]) {
  for (const limits of [{ pages: 1 }, { items: 1 }, { textCharacters: 15 }]) {
    test(`${engine} budgets accumulate across individually acceptable pages: ${JSON.stringify(limits)}`, async (t) => {
      const document = await PDFDocument.create();
      document.setTitle("padding".repeat(1200)); // Avoid the legacy engine's tiny pooled-buffer incompatibility.
      const font = await document.embedFont(StandardFonts.Helvetica);
      for (let index = 0; index < 2; index++) {
        document.addPage([300, 200]).drawText("Ten letters", { x: 24, y: 100, size: 12, font });
      }
      const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
      const harness = await workerHarness(t, { ...(engine === "modern" ? { legacy: "compatibility" } : {}), limits });
      await assert.rejects(harness.parsePdf(bytes), /PDF_RESOURCE_LIMIT/);
      assert.equal(harness.state.calls.length, engine === "modern" ? 2 : 1, JSON.stringify(harness.state.messages));
    });
  }
}

for (const cwd of [path.resolve(frontendRoot, "../.."), os.tmpdir()]) {
  test(`PDF parser dependencies resolve for source imports from ${cwd === os.tmpdir() ? "another directory" : "repository root"}`, () => {
    const script = `
      const { createJiti } = require(${JSON.stringify(path.join(frontendRoot, "node_modules/jiti"))});
      const load = createJiti(${JSON.stringify(path.join(frontendRoot, "pdf-cwd-test.cjs"))}, {alias:{"server-only":"/dev/null"}});
      const { parsePdf } = load(${JSON.stringify(path.join(frontendRoot, "lib/server/pdf-parser.ts"))});
      parsePdf(Buffer.from(${JSON.stringify(legacyFixture("Source import text").toString("base64"))}, "base64"))
        .then((result) => process.stdout.write(result.text))
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const output = execFileSync(process.execPath, ["-e", script], { cwd, encoding: "utf8", timeout: 10_000 });
    assert.match(output, /Source import text/);
  });
}
