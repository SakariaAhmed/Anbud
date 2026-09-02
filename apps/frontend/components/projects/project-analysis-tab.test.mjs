import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "project-analysis-tab-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot },
});
const { isDocumentReadyForEvaluation } = jiti(
  path.join(frontendRoot, "lib/document-processing.ts"),
);

const source = await readFile(
  new URL("./project-analysis-tab.tsx", import.meta.url),
  "utf8",
);

test("customer analysis navigation excludes the keyword tab", () => {
  const tabsBlock = source.match(
    /const SECTION_TABS = \[([\s\S]*?)\] as const;/u,
  )?.[1];
  assert.ok(tabsBlock, "SECTION_TABS registry must remain discoverable");

  const tabs = [...tabsBlock.matchAll(
    /\{ value: "([^"]+)", label: "([^"]+)" \}/gu,
  )].map((match) => ({
    value: match[1],
    label: match[2],
  }));

  assert.deepEqual(tabs, [
    { value: "summary", label: "Oppsummering" },
    { value: "strategy", label: "Strategi" },
    { value: "clarifications", label: "Avklaringer" },
    { value: "design", label: "Design" },
    { value: "risks", label: "Risiko" },
    { value: "needs", label: "Behov" },
    { value: "services", label: "Anbefalt tjeneste" },
    { value: "value", label: "Verdi" },
  ]);
  assert.doesNotMatch(tabsBlock, /Nøkkelord|value: "keywords"/u);
});

test("customer analysis stays unavailable until document preparation publishes readiness", () => {
  const document = { processing_status: "processing" };

  assert.equal(isDocumentReadyForEvaluation(document), false);

  document.processing_status = "basic_ready";
  assert.equal(isDocumentReadyForEvaluation(document), true);
});

test("analysis CTA checks readiness instead of document count only", () => {
  assert.match(source, /analysisDocuments\.every\(isDocumentReadyForEvaluation\)/u);
  assert.match(source, /disabled=\{busy \|\| Boolean\(sectionBusy\) \|\| !documentsReady\}/u);
  assert.doesNotMatch(
    source,
    /disabled=\{busy \|\| Boolean\(sectionBusy\) \|\| !hasDocuments\}/u,
  );
});
