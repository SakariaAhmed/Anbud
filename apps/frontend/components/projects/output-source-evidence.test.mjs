import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";
const frontend = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(frontend, "package.json"));
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { OutputSourceEvidence } = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, alias: { "@": frontend } })("./output-source-evidence.tsx");
const source = index => ({ evidence_id: `e-${index}`, source_type: "project_document", source_id: `doc-${index}`, document_title: `Dokument ${index}`, reference: `Side ${index + 1}`, source_revision: 1, source_fingerprint: "hash", original_quote: "Et opprinnelig kildeutdrag.", heading_path: [], page_start: index + 1, page_end: index + 1, classification: "documented" });
test("a large source catalogue renders one collapsed control rather than hundreds of source buttons", () => {
  const value = { version: 1, references: Array.from({ length: 300 }, (_, index) => ({ path: `result.requirement_coverage.items.${index}.evidence`, source: source(index) })) };
  const html = renderToStaticMarkup(createElement(OutputSourceEvidence, { value, projectId: "project" }));
  assert.match(html, /Vis 300 kildeutdrag/u);
  assert.equal((html.match(/<button\b/gu) ?? []).length, 0);
  assert.doesNotMatch(html, /opprinnelig kildeutdrag/u);
});
test("a claim's sources and warnings stay scoped to its exact path", () => {
  const value = { version: 1, references: [{ path: "rows.1.evidence", source: source(1) }, { path: "rows.10.evidence", source: source(10) }], issues: [{ path: "rows.10.answer", code: "unknown_requirement", message: "Må avklares" }] };
  const html = renderToStaticMarkup(createElement(OutputSourceEvidence, { value, projectId: "project", path: "rows.1" }));
  assert.match(html, /Dokument 1\s/u);
  assert.doesNotMatch(html, /Dokument 10|ble holdt tilbake/u);
  assert.equal((html.match(/<button\b/gu) ?? []).length, 1);
});
