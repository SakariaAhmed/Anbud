import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(import.meta.dirname, "../..");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "initial";
if (!/^[a-z0-9_-]+$/.test(label)) throw new Error("Invalid browser report label.");
const dir = path.join(root, "output/speed-quality-2026-09-08/browser-final", label);
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { at: new Date().toISOString(), boundary: "Separate headless Chromium, authenticated local production build with fictional fixture; not the foreground browser, Entra, or Azure storage.", checks: [], errors: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const login = await context.request.post("http://localhost:4318/api/auth/login", { data: { password: "speed-quality-local-test-password" } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  for (const size of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    for (const tab of ["analysis", "requirements"]) {
      await page.goto(`http://localhost:4318/projects/eeb0b621-85a3-450c-b8bf-dc082eb8ee63?tab=${tab}`);
      if (tab === "analysis") await page.getByRole("heading", { name: "Oppsummering av kunden", exact: true }).waitFor();
      else await page.getByText("Manuell gjennomgang påkrevd før innlevering", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(dimensions.scrollWidth <= dimensions.viewport, `${size.name}/${tab} page overflow`);
      const check = { size: size.name, tab, dimensions, screenshot: `${size.name}-${tab}-verified.png` };
      if (tab === "requirements") {
        check.requirementRows = await page.locator("table tbody tr").count();
        assert.equal(check.requirementRows, 8);
        check.manualReviewVisible = await page.getByText("Manuell gjennomgang påkrevd før innlevering", { exact: true }).isVisible();
        if (size.name === "mobile") {
          const title = await page.locator("details[open] summary h4").first().boundingBox();
          const action = await page.getByRole("button", { name: "Last ned PDF", exact: true }).boundingBox();
          assert.ok(title && title.width >= 200, "Mobile artifact title must retain readable width.");
          assert.ok(action && action.y >= title.y + title.height, "Mobile actions must follow the title on their own row.");
          check.mobileHeader = { titleWidth: title.width, titleBottom: title.y + title.height, actionsTop: action.y };
        }
        if (size.name === "desktop") {
          const started = performance.now();
          const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Last ned PDF", exact: true }).click()]);
          const pdf = path.join(dir, "kravsvar-export.pdf");
          await download.saveAs(pdf);
          assert.equal(await download.failure(), null);
          const bytes = readFileSync(pdf);
          assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
          check.export = { ms: performance.now() - started, bytes: bytes.length, file: path.basename(pdf), boundary: "One export; no baseline or p95 claim." };
        }
      }
      await page.screenshot({ path: path.join(dir, check.screenshot), fullPage: true });
      report.checks.push(check);
    }
  }
  assert.deepEqual(report.errors, []);
} finally {
  writeFileSync(path.join(dir, "checks.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
