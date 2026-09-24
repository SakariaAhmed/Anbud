import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export async function checkServiceBrowser({ root, origin, projectId, services, label }) {
  const require = createRequire(import.meta.url);
  const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
  const { chromium } = require(modulePath);
  const { expect } = require(`${modulePath}/test`);
  const directory = path.join(root, `output/speed-quality-2026-09-08/verification/service-browser-${label}`);
  mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = { at: new Date().toISOString(), scope: "Actual authenticated browser with isolated synthetic populated catalog. Desktop/mobile selection, cache on SPA tab revisit, persisted hard reload, and one explicitly simulated 503 rollback. No AI calls or generation-quality/latency claim.", checks: [], errors: [], blockedUnexpectedWrites: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { password: "speed-quality-local-test-password" } })).status(), 200);
    const url = `${origin}/api/projects/${projectId}/service-descriptions`;
    await context.route("**/api/**", async (route) => {
      if (["GET", "HEAD"].includes(route.request().method()) || route.request().url() === url && route.request().method() === "PATCH" || route.request().url() === `${origin}/api/projects/${projectId}/page-view` && route.request().method() === "POST") return route.continue();
      report.blockedUnexpectedWrites.push({ method: route.request().method(), url: route.request().url() });
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    let serviceReads = 0;
    page.on("request", (request) => { if (request.method() === "GET" && request.url() === url) serviceReads++; });
    const serviceButton = () => page.getByRole("button").filter({ hasText: services[0].name }).filter({ hasText: "1 dokument" });
    async function saved(selected) {
      await expect(serviceButton()).toHaveAttribute("aria-pressed", String(selected));
      await expect(serviceButton()).toHaveAttribute("aria-busy", "false");
      const response = await context.request.get(url); assert.equal(response.status(), 200);
      assert.equal((await response.json()).services.find((s) => s.id === services[0].id).selected, selected);
    }
    for (const size of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.goto(`${origin}/projects/${projectId}?tab=service-description`);
      await expect(page.getByRole("heading", { name: "Velg tjenester", exact: true })).toBeVisible();
      await saved(false);
      await serviceButton().focus();
      const [save] = await Promise.all([page.waitForResponse((r) => r.url() === url && r.request().method() === "PATCH"), page.keyboard.press("Space")]);
      assert.equal(save.status(), 200); await saved(true);
      const row = { viewport: size.name, keyboardTogglePersisted: true };
      if (size.name === "desktop") {
        const readsBefore = serviceReads;
        await page.getByRole("button", { name: /^1\s+Dokumenter/ }).click();
        await expect(page.getByText("Azure backup", { exact: true })).toHaveCount(2);
        await expect(page.getByText("Azure backup", { exact: true }).last()).toBeVisible();
        await page.getByRole("button", { name: /^2\s+Tjenester/ }).click();
        await expect(serviceButton()).toHaveAttribute("aria-pressed", "true");
        assert.equal(serviceReads, readsBefore);
        row.spaRevisitUsedUpdatedClientCache = true;
        row.selectedDocumentVisibleOnDocumentsTab = true;
      }
      await page.reload(); await saved(true); row.hardReloadPreservedSelection = true;
      // A controlled transport response tests optimistic rollback. It does not
      // represent a real database incident or a successful write.
      await page.route(url, (route) => route.request().method() === "PATCH" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Kontrollert lagringsfeil." }) }) : route.continue());
      await serviceButton().click();
      await expect(page.getByRole("alert").filter({ hasText: "Kontrollert lagringsfeil." })).toHaveText("Kontrollert lagringsfeil.");
      await saved(true); row.simulatedFailureRolledBack = true;
      await page.unroute(url);
      await page.evaluate(() => document.fonts.ready);
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(dimensions.scrollWidth <= dimensions.width); row.dimensions = dimensions;
      row.screenshot = `${size.name}.png`;
      await page.screenshot({ path: path.join(directory, row.screenshot), fullPage: true });
      const [clear] = await Promise.all([page.waitForResponse((r) => r.url() === url && r.request().method() === "PATCH"), serviceButton().click()]);
      assert.equal(clear.status(), 200); await saved(false);
      row.clearedSelectionPersisted = true;
      report.checks.push(row);
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.blockedUnexpectedWrites, []);
  } finally {
    writeFileSync(path.join(directory, "checks.json"), `${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
  }
  return report;
}
