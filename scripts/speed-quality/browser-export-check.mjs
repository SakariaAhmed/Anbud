import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createExportFixture } from "./export-fixture.mjs";

const require = createRequire(import.meta.url);
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(modulePath);
const { expect } = require(`${modulePath}/test`);
const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "paced";
const samples = Number(process.argv.find((arg) => arg.startsWith("--samples="))?.slice(10) ?? 30);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 30);
assert.match(label, /^[a-z0-9-]+$/);
const output = path.join(dir, `verification/browser-exports-${label}`);
assert.equal(existsSync(output), false); mkdirSync(output);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const budgetHash = () => sha(readFileSync(path.join(dir, "api-budget.json")));
const initialBudget = budgetHash();
let fixture;
const browser = await chromium.launch({ headless: true });
const report = { at: new Date().toISOString(), completed: false, scope: "30 alternating warm authenticated local browser exports per format on the same existing small synthetic artifact, baseline 3779e6f2/candidate production builds. Includes browser automation and completed local download; not Azure or native Word verification. Diagram exports are separate single functional checks on the existing development analysis.", betweenDownloadPauseMs: 1100, pauseIncludedInTiming: false, errors: [], rows: [] };
const persist = () => writeFileSync(path.join(output, "checks.json"), `${JSON.stringify(report, null, 2)}\n`);
try {
  fixture = await createExportFixture(root);
  const projectId = fixture.id;
  report.scope = `${samples} alternating warm authenticated exports of the same correctly seeded structured plaintext artifact in separate local baseline/candidate DBs. Includes automation and download completion; excludes setup/pacing. Word is HTML .doc, not native Word verification. Diagram exports are separate single functional checks on an existing development analysis.`;
  report.samples = samples;
  report.fixture = { projectId, artifactId: fixture.artifactId, contentSha256: sha(fixture.content), contentChars: fixture.content.length };
  writeFileSync(path.join(output, "source.md"), fixture.content);
  const clients = {};
  for (const [version, port] of [["before", 4317], ["after", 4318]]) {
    const base = `http://localhost:${port}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    assert.equal((await context.request.post(`${base}/api/auth/login`, { data: { password: "speed-quality-local-test-password" } })).status(), 200);
    const response = await context.request.get(`${base}/api/projects/${projectId}/generate`); assert.equal(response.status(), 200);
    const artifact = (await response.json()).artifacts.find((a) => a.artifact_type === "gjennomforing_og_risiko"); assert.ok(artifact);
    assert.equal(artifact.content_markdown, fixture.content, "HTTP artifact content must equal the known plaintext fixture.");
    assert.ok(!artifact.content_markdown.startsWith("enc:v1:"));
    const page = await context.newPage(); page.on("pageerror", (error) => report.errors.push({ version, error: error.message }));
    await page.goto(`${base}/projects/${projectId}?tab=delivery`);
    await expect(page.getByRole("button", { name: "Markdown", exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    clients[version] = { base, context, page, artifact };
  }
  assert.equal(clients.before.artifact.content_markdown, clients.after.artifact.content_markdown);
  for (const [format, extension] of [["Markdown", "md"], ["Word", "doc"], ["PDF", "pdf"]]) {
    const row = { format, before: [], after: [] };
    report.rows.push(row);
    for (let sample = -2; sample < samples; sample++) {
      const contents = {};
      for (const version of sample % 2 ? ["before", "after"] : ["after", "before"]) {
        const { page, artifact } = clients[version];
        report.current = { format, sample, version }; persist();
        // Deliberately pace repeated downloads outside the measured operation.
        // Preserve the earlier unpaced timeout; this does not diagnose its cause.
        await new Promise((resolve) => setTimeout(resolve, report.betweenDownloadPauseMs));
        const started = performance.now();
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: format, exact: true }).click()]);
        const file = await download.path(); assert.equal(await download.failure(), null);
        const elapsedMs = performance.now() - started;
        const bytes = readFileSync(file); contents[version] = bytes;
        if (format === "Markdown") assert.equal(bytes.toString(), artifact.content_markdown);
        if (format === "Word") { assert.match(bytes.toString(), /^<!doctype html>/); assert.ok(bytes.toString().includes(artifact.title)); assert.match(bytes.toString(), /<table[\s>]/); }
        if (format === "PDF") assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
        if (sample === 0) writeFileSync(path.join(output, `${version}.${extension}`), bytes);
        if (sample >= 0) row[version].push({ ms: elapsedMs, bytes: bytes.length, sha256: sha(bytes) });
        persist();
      }
      if (format !== "PDF") assert.deepEqual(contents.before, contents.after);
    }
    for (const version of ["before", "after"]) {
      const sorted = row[version].map((r) => r.ms).sort((a, b) => a - b);
      row[`${version}Summary`] = { sampleCount: samples, p50Ms: sorted[Math.ceil(samples * 0.5) - 1], ...(samples >= 30 ? { p95Ms: sorted[Math.ceil(samples * 0.95) - 1] } : {}) };
    }
    row.contentCheck = format === "PDF" ? "Valid PDF header; first files retained for render inspection. PDF IDs/timestamps prevent byte equality." : "Exact before/after bytes; Markdown also equals persisted source.";
    row.completed = true; persist();
    console.log(JSON.stringify({ format, before: row.beforeSummary, after: row.afterSummary }));
  }
  const page = clients.after.page;
  await page.goto(`${clients.after.base}/projects/eeb0b621-85a3-450c-b8bf-dc082eb8ee63?tab=analysis`);
  await expect(page.getByRole("tab", { name: "Design", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Design", exact: true }).click();
  await page.locator(".mermaid-diagram svg").waitFor();
  const renderedLabels = await page.locator(".mermaid-diagram svg").textContent();
  report.diagram = { scope: "One current existing development diagram; no baseline timing claim.", labels: renderedLabels, exports: [] };
  for (const extension of ["svg", "png"]) {
    report.current = { format: extension, version: "after", sample: 0 }; persist();
    await new Promise((resolve) => setTimeout(resolve, report.betweenDownloadPauseMs));
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: `Last ned ${extension.toUpperCase()}`, exact: true }).click()]);
    const bytes = readFileSync(await download.path()); assert.equal(await download.failure(), null);
    if (extension === "svg") assert.match(bytes.toString(), /<svg[\s>]/);
    else assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    writeFileSync(path.join(output, `diagram.${extension}`), bytes);
    report.diagram.exports.push({ extension, bytes: bytes.length, sha256: sha(bytes) });
  }
  assert.deepEqual(report.errors, []); assert.equal(budgetHash(), initialBudget);
  report.ledgerUnchanged = true;
  report.completed = true;
  delete report.current;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: path.join(output, `failure-${new URL(page.url()).port}.png`), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  persist();
  await browser.close();
  if (fixture) { await fixture.cleanup(); report.fixtureRemoved = true; persist(); }
}
console.log(JSON.stringify({ rows: report.rows.map((r) => ({ format: r.format, before: r.beforeSummary, after: r.afterSummary })), diagram: report.diagram, ledgerUnchanged: report.ledgerUnchanged }, null, 2));
