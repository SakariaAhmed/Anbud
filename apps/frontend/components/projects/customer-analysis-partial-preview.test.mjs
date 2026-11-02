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
  } finally { delete globalThis.__previewPolling; rmSync(directory, { recursive: true, force: true }); }
});

test("preview fetches successive partial fields while busy and stops timers and in-flight reads on cleanup", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-preview-poll-"));
  const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const state = { effect: null, writes: [] }; globalThis.__previewHooks = state;
  try {
    const hooks = path.join(directory, "hooks.cjs");
    writeFileSync(hooks, `exports.useState = value => [value, next => globalThis.__previewHooks.writes.push(next)]; exports.useEffect = effect => { globalThis.__previewHooks.effect = effect; };`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, jsx: { runtime: "automatic" }, alias: { "@": frontend, "react/jsx-runtime": require.resolve("react/jsx-runtime"), react: hooks } });
    const { CustomerAnalysisPartialPreview } = load("./customer-analysis-partial-preview.tsx");
    let timer, reads = 0, signal, cleared = 0;
    globalThis.setTimeout = callback => { timer = callback; return 1; };
    globalThis.clearTimeout = () => { cleared++; timer = null; };
    globalThis.fetch = async (_url, options) => { signal = options.signal; reads++; return Response.json({ partial: { fields: { executive_summary: `Felt ${reads}` } } }); };
    CustomerAnalysisPartialPreview({ projectId: "project", busy: true });
    const cleanup = state.effect(); await new Promise(setImmediate);
    assert.equal(reads, 1); assert.ok(timer);
    await timer(); assert.equal(reads, 2);
    assert.ok(state.writes.some(value => value?.fields?.executive_summary === "Felt 2"));
    cleanup(); assert.equal(signal.aborted, true); assert.equal(cleared, 1);
    CustomerAnalysisPartialPreview({ projectId: "project", busy: false });
    const terminalCleanup = state.effect(); await new Promise(setImmediate);
    assert.equal(reads, 3); assert.equal(timer, null, "A terminal transition reads the final persisted snapshot without another poll.");
    terminalCleanup();
  } finally {
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear;
    delete globalThis.__previewHooks; rmSync(directory, { recursive: true, force: true });
  }
});
