import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const require = createRequire(path.join(frontend, "package.json"));
const { chromium, expect } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright/test");
const dir = path.join(root, "output/speed-quality-2026-09-08/verification/chat-source-browser-v1");
if (existsSync(path.join(dir, "checks.json"))) throw new Error("Do not overwrite browser evidence.");
mkdirSync(dir, { recursive: true });
const env = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/local-environment.json")));
if (env.DATA_API_URL !== "http://127.0.0.1:55440" || env.OPENAI_API_KEY !== "local-evaluation-proxy-only") throw new Error("Fictional local environment required.");
Object.assign(process.env, env);
const temporary = mkdtempSync(path.join(tmpdir(), "anbud-chat-browser-"));
const cache = path.join(temporary, "cache.cjs");
writeFileSync(cache, "exports.revalidateProjectCaches = () => {};");
const load = require("jiti").createJiti(import.meta.url, { alias: { "@/lib/server/repositories/repository-cache": cache, "@": frontend, "server-only": "/dev/null" } });
const { appendChatMessage, listChatMessages } = load(path.join(frontend, "lib/server/repositories/chat.ts"));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const origin = "http://localhost:4318";
const report = { at: new Date().toISOString(), scope: "Actual local authenticated production build; own temporary fictional project, real encrypted chat repository persistence/reload and API read, expanded source UI at desktop/mobile. No generated answer, model call, Entra or Azure claim.", checks: [], errors: [] };
try {
  assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { password: "speed-quality-local-test-password" } })).status(), 200);
  const created = await context.request.post(`${origin}/api/projects`, { data: { name: "Fiktiv kontroll av alle chatkilder", customer_name: "Lokal regresjon" } });
  assert.equal(created.status(), 201);
  report.projectId = (await created.json()).id;
  const sources = Array.from({ length: 16 }, (_, index) => ({
    document_title: `Fiktivt dokument ${index + 1} med lang norsk beskrivelse`, reference: `Kravkontroll ${index + 1} – dokumentert akseptansekriterium`,
    heading_path: ["Kundekrav", "Kvalitet og sporbarhet"], source_id: `fictional-source-${index + 1}`,
    source_type: "project_document", page_start: index + 1, page_end: index + 1,
  }));
  const stored = await appendChatMessage(report.projectId, "assistant", "Fiktivt testsvar for kontroll av kildelisten.", { source_references: sources });
  assert.deepEqual(stored.source_references, sources);
  assert.deepEqual((await listChatMessages(report.projectId))[0].source_references, sources);
  const api = await context.request.get(`${origin}/api/projects/${report.projectId}/chat`);
  assert.equal(api.status(), 200);
  assert.deepEqual((await api.json()).messages[0].source_references, sources);
  report.persistedAndReloadedReferences = 16;
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  for (const size of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.goto(`${origin}/projects/${report.projectId}/chat`);
    const summary = page.locator("summary").filter({ hasText: "16 kilder" });
    await expect(summary).toBeVisible();
    await summary.focus();
    await page.keyboard.press("Enter");
    const details = summary.locator("..");
    await expect(details).toHaveAttribute("open", "");
    for (const source of sources) await expect(details.getByText(source.reference, { exact: false })).toBeVisible();
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scrollWidth <= dimensions.viewport);
    await page.evaluate(() => document.fonts.ready);
    await details.getByText(sources[15].reference, { exact: false }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(dir, `${size.name}.png`), fullPage: true });
    report.checks.push({ viewport: size.name, dimensions, allReferencesVisibleInExpandedList: true, keyboardExpansion: true, screenshot: `${size.name}.png` });
  }
  assert.deepEqual(report.errors, []);
} finally {
  if (report.projectId) {
    const removed = await context.request.delete(`${origin}/api/projects/${report.projectId}`);
    report.cleanupStatus = removed.status();
    report.cleanupVerified = (await context.request.get(`${origin}/api/projects/${report.projectId}`)).status() === 404;
    if (!report.cleanupVerified) {
      // No Azure credentials are loaded in this harness. Preserve the failed
      // HTTP outcome while removing only this own, document-free local fixture.
      const headers = { apikey: env.DATA_API_SERVICE_ROLE_KEY, authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}` };
      const read = table => fetch(`${env.DATA_API_URL}/${table}`, { headers }).then(response => response.json());
      const projects = await read(`projects?id=eq.${report.projectId}`);
      if (projects.length !== 1 || projects[0].title !== "Fiktiv kontroll av alle chatkilder" || (await read(`documents?project_id=eq.${report.projectId}`)).length) throw new Error("Unexpected cleanup scope.");
      const deleted = await fetch(`${env.DATA_API_URL}/projects?id=eq.${report.projectId}`, { method: "DELETE", headers });
      report.localDatabaseCleanupStatus = deleted.status;
      report.localDatabaseCleanupVerified = deleted.ok && !(await read(`projects?id=eq.${report.projectId}`)).length && !(await read(`chat_messages?project_id=eq.${report.projectId}`)).length;
    }
  }
  writeFileSync(path.join(dir, "checks.json"), JSON.stringify(report, null, 2));
  await browser.close();
  rmSync(temporary, { recursive: true, force: true });
}
assert.ok(report.cleanupVerified || report.localDatabaseCleanupVerified);
console.log(JSON.stringify(report));
