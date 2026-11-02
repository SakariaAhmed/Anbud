import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const frontend = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(frontend, "package.json"));

test("empty successful register reads warm the key without timing later ingestion as a render", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-register-metric-"));
  const previous = Object.fromEntries(["fetch", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "document", "performance"].map(key => [key, globalThis[key]]));
  const state = { effect: null, refs: [], refIndex: 0 }; globalThis.__registerMetricHooks = state;
  const frames = new Map(), metrics = []; let frameId = 0, timer, payload, respond, now = 100;
  try {
    const hooks = path.join(directory, "hooks.cjs"), ui = path.join(directory, "ui.cjs");
    writeFileSync(hooks, `exports.useRef = value => { const s = globalThis.__registerMetricHooks; return s.refs[s.refIndex++] ??= { current: value }; }; exports.useState = value => [value, () => {}]; exports.useMemo = fn => fn(); exports.useEffect = effect => { globalThis.__registerMetricHooks.effect = effect; };`);
    writeFileSync(ui, "exports.Input = exports.Button = () => null;");
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, jsx: { runtime: "automatic" }, alias: { "@": frontend, "react/jsx-runtime": require.resolve("react/jsx-runtime"), react: hooks, "@/components/projects/primitives": ui, "@/components/ui/button": ui } });
    const { ProjectRequirementRegisterPreview } = load("./project-requirement-register.tsx");
    globalThis.performance = { now: () => now };
    globalThis.setTimeout = callback => { timer = callback; return 1; };
    globalThis.clearTimeout = () => { timer = undefined; };
    globalThis.document = { visibilityState: "visible" };
    globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
    globalThis.fetch = async (url, options) => {
      if (url.endsWith("/performance")) { metrics.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); }
      return respond ? respond() : Response.json(payload);
    };
    const row = { id: "K-42", text: "Fire kurs.", heading: "Kurs", pages: [1], id_origin: "source" };
    const register = (id, revision, rows) => ({ source_revision: revision, documents: [{ id, title: "Krav", source_revision: revision, document_ready: true, register_available: true, rows }] });
    const flushPaint = () => { for (let i = 0; i < 2; i++) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); } };
    const render = async (props = {}) => {
      state.refIndex = 0;
      ProjectRequirementRegisterPreview({ projectId: "project", refreshKey: "revision", processing: true, ...props });
      const cleanup = state.effect(); await new Promise(setImmediate); return cleanup;
    };
    const mount = async (props) => { state.refs = []; return render(props); };
    payload = register("empty-then-ready", 1, []);
    let cleanup = await mount(); flushPaint(); assert.equal(metrics.length, 0);
    payload = register("empty-then-ready", 1, [row]);
    timer(); await new Promise(setImmediate); flushPaint(); assert.equal(metrics.length, 0, "Polling must not fold ingestion wait into a first-read render sample.");
    cleanup(); cleanup = await mount(); flushPaint();
    assert.equal(metrics.at(-1).cacheState, "warm"); cleanup();

    // Even without a subsequent populated poll, the successful empty read counts.
    payload = register("empty-only", 1, []); cleanup = await mount(); cleanup();
    payload = register("empty-only", 1, [row]); cleanup = await mount(); flushPaint();
    assert.equal(metrics.at(-1).documentId, "empty-only"); assert.equal(metrics.at(-1).cacheState, "warm"); cleanup();
    payload = register("empty-only", 2, [row]); cleanup = await mount(); flushPaint();
    assert.equal(metrics.at(-1).cacheState, "cold"); cleanup();

    payload = register("failed-read", 1, [row]); respond = () => new Response(null, { status: 503 });
    cleanup = await mount(); cleanup(); respond = undefined;
    cleanup = await mount(); flushPaint(); assert.equal(metrics.at(-1).documentId, "failed-read"); assert.equal(metrics.at(-1).cacheState, "cold"); cleanup();

    let resolve; payload = register("aborted-read", 1, [row]);
    respond = () => new Promise(done => { resolve = done; });
    cleanup = await mount(); cleanup(); resolve(Response.json(payload)); await new Promise(setImmediate); respond = undefined;
    cleanup = await mount(); flushPaint(); assert.equal(metrics.at(-1).documentId, "aborted-read"); assert.equal(metrics.at(-1).cacheState, "cold"); cleanup();

    // Job completion and data refresh do not open a new register view.
    payload = register("processing-update", 1, []); cleanup = await mount();
    const beforeUpdate = metrics.length;
    cleanup(); payload = register("processing-update", 1, [row]);
    cleanup = await render({ processing: false }); flushPaint();
    assert.equal(metrics.length, beforeUpdate, "Processing completion must not turn ingestion wait into a render sample.");
    cleanup(); cleanup = await render({ processing: false, refreshKey: "new-revision" }); flushPaint();
    assert.equal(metrics.length, beforeUpdate, "Refresh must retain the consumed first read.");
    cleanup(); cleanup = await mount(); flushPaint();
    assert.equal(metrics.length, beforeUpdate + 1); assert.equal(metrics.at(-1).documentId, "processing-update");
    assert.equal(metrics.at(-1).cacheState, "warm");
    cleanup(); cleanup = await render({ processing: false }); flushPaint();
    assert.equal(metrics.length, beforeUpdate + 1, "A populated first read must not be sampled twice.");

    // A project navigation is a new episode even if the component stays mounted.
    cleanup(); payload = register("new-project", 1, [row]);
    cleanup = await render({ projectId: "other-project" }); flushPaint();
    assert.equal(metrics.length, beforeUpdate + 2); assert.equal(metrics.at(-1).documentId, "new-project"); cleanup();

    // An interrupted first read keeps the original view-open timestamp on refresh.
    now = 100; payload = register("interrupted-first", 1, [row]);
    respond = () => new Promise(done => { resolve = done; });
    cleanup = await mount(); cleanup(); now = 200; respond = undefined;
    cleanup = await render({ processing: false });
    resolve(Response.json(register("stale-response", 1, [row]))); await new Promise(setImmediate);
    now = 350; flushPaint();
    assert.equal(metrics.at(-1).documentId, "interrupted-first");
    assert.equal(metrics.at(-1).durationMs, 250, "Refresh cannot reset the view-open timestamp."); cleanup();

    // A completed failure consumes the first read; retry/refresh is not a new view.
    payload = register("failed-in-view", 1, [row]); respond = () => new Response(null, { status: 503 });
    cleanup = await mount(); cleanup(); respond = undefined;
    const beforeRecovery = metrics.length;
    cleanup = await render({ refreshKey: "recovery" }); flushPaint();
    assert.equal(metrics.length, beforeRecovery); cleanup();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    delete globalThis.__registerMetricHooks; rmSync(directory, { recursive: true, force: true });
  }
});
