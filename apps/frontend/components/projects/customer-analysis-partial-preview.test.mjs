import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const frontend = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(frontend, "package.json"));
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

test("automatic queued/running jobs keep the preview polling without manual busy state", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-preview-props-"));
  try {
    const preview = path.join(directory, "preview.cjs");
    writeFileSync(preview, `exports.CustomerAnalysisPartialPreview = props => { globalThis.__previewPolling = props.busy; return null; };`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, jsx: { runtime: "automatic" }, alias: { "@": frontend, "./project-workspace.css": "/dev/null", [path.join(frontend, "components/projects/project-workspace.css")]: "/dev/null", "@/components/projects/customer-analysis-partial-preview": preview } });
    const { ProjectWorkspaceTabContent } = load("./project-workspace-shell.tsx");
    const { ProjectAnalysisTab } = load("./project-analysis-tab.tsx");
    const find = (node, name) => {
      if (!node || typeof node !== "object") return null;
      if (node.type?.name === name) return node;
      for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, name); if (found) return found; }
      return null;
    };
    for (const [kind, status, expected] of [["customer_analysis", "queued", true], ["customer_analysis", "running", true], ["customer_analysis", "completed", false], ["customer_analysis", "failed", false], ["document_ingestion", "running", false]]) {
      const tree = ProjectWorkspaceTabContent({ activeTab: "analysis", project: { id: "project", documents: [] }, projectJobs: [{ kind, status }], customerAnalysis: null, analysisLoaded: true, analysisLoading: false, busy: null, serviceDescriptions: [] });
      const result = find(tree, "ProjectAnalysisResult"); assert.ok(result);
      const tab = result.props.children(null);
      renderToStaticMarkup(createElement(ProjectAnalysisTab, tab.props));
      assert.equal(globalThis.__previewPolling, expected, `${kind}/${status}`);
    }
    for (const [status, expected] of [["pending", true], ["scheduled", true], ["completed", false], ["failed", false], ["cancelled", false]]) {
      const tree = ProjectWorkspaceTabContent({ activeTab: "analysis", project: { id: "project", documents: [] }, projectJobs: [], automaticAnalysis: { status }, customerAnalysis: null, analysisLoaded: true, analysisLoading: false, busy: null, serviceDescriptions: [] });
      const result = find(tree, "ProjectAnalysisResult"); assert.ok(result);
      renderToStaticMarkup(createElement(ProjectAnalysisTab, result.props.children(null).props));
      assert.equal(globalThis.__previewPolling, expected, `automatic request/${status}`);
    }
  } finally { delete globalThis.__previewPolling; rmSync(directory, { recursive: true, force: true }); }
});

test("preview fetches successive partial fields while busy and stops timers and in-flight reads on cleanup", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-preview-poll-"));
  const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document"), originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const page = new EventTarget(); page.visibilityState = "visible";
  Object.defineProperty(globalThis, "document", { value: page, configurable: true });
  Object.defineProperty(globalThis, "window", { value: new EventTarget(), configurable: true });
  const state = { effect: null, writes: [] }; globalThis.__previewHooks = state;
  try {
    const hooks = path.join(directory, "hooks.cjs");
    writeFileSync(hooks, `exports.useState = value => [value, next => globalThis.__previewHooks.writes.push(next)]; exports.useEffect = effect => { globalThis.__previewHooks.effect = effect; };`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, jsx: { runtime: "automatic" }, alias: { "@": frontend, "react/jsx-runtime": require.resolve("react/jsx-runtime"), react: hooks } });
    const { CustomerAnalysisPartialPreview } = load("./customer-analysis-partial-preview.tsx");
    let timer, delay, reads = 0, signal, cleared = 0;
    globalThis.setTimeout = (callback, ms) => { timer = callback; delay = ms; return 1; };
    globalThis.clearTimeout = () => { cleared++; timer = null; };
    const fireTimer = () => { const callback = timer; timer = null; callback(); };
    globalThis.fetch = async (_url, options) => { signal = options.signal; reads++; return Response.json({ partial: { fields: { executive_summary: `Felt ${reads}` } } }); };
    CustomerAnalysisPartialPreview({ projectId: "project", busy: true });
    const cleanup = state.effect(); await new Promise(setImmediate);
    assert.equal(reads, 1); assert.ok(timer);
    fireTimer(); await new Promise(setImmediate); assert.equal(reads, 2);
    assert.ok(state.writes.some(value => value?.fields?.executive_summary === "Felt 2"));
    cleanup(); assert.equal(signal.aborted, true); assert.ok(cleared >= 1); assert.equal(timer, null);
    let remotePartial = null;
    globalThis.fetch = async (_url, options) => { signal = options.signal; reads++; return Response.json({ partial: remotePartial }); };
    CustomerAnalysisPartialPreview({ projectId: "project", busy: false });
    const terminalCleanup = state.effect(); await new Promise(setImmediate);
    assert.equal(reads, 3); assert.ok(timer, "Idle preview discovery must not depend on a jobs refresh."); assert.equal(delay, 5_000);
    // Another user's job starts and finishes before the ordinary 60-second jobs read.
    remotePartial = { job_status: "running", fields: { executive_summary: "Ekstern analyse" } };
    fireTimer(); await new Promise(setImmediate);
    assert.equal(reads, 4); assert.equal(delay, 2_000);
    assert.ok(state.writes.some(value => value?.fields?.executive_summary === "Ekstern analyse"));
    remotePartial = null;
    fireTimer(); await new Promise(setImmediate);
    assert.equal(reads, 5); assert.equal(delay, 5_000); assert.equal(state.writes.at(-2), null);
    page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange"));
    assert.equal(timer, null, "Hidden tabs must not poll.");
    page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange"));
    assert.equal(delay, 500); fireTimer(); await new Promise(setImmediate); assert.equal(reads, 6);
    // Cleanup fences a read that settles after navigation and schedules no timer.
    let settle;
    globalThis.fetch = (_url, options) => { signal = options.signal; return new Promise(resolve => { settle = resolve; }); };
    fireTimer(); const writesBeforeCleanup = state.writes.length;
    terminalCleanup(); assert.equal(signal.aborted, true);
    settle(Response.json({ partial: { fields: { executive_summary: "Stale" } } }));
    await new Promise(setImmediate);
    assert.equal(state.writes.length, writesBeforeCleanup); assert.equal(timer, null);
    window.dispatchEvent(new Event("focus")); assert.equal(timer, null, "Cleanup removes wake listeners.");
  } finally {
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete globalThis.document;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete globalThis.window;
    delete globalThis.__previewHooks; rmSync(directory, { recursive: true, force: true });
  }
});
