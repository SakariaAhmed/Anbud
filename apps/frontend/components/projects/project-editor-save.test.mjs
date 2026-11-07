import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const frontend = new URL("../../", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, { alias: { "@": frontend } });

// Execute the production parent component and its handlers. Child widgets are
// inert elements; this harness does not claim native DOM or focus verification.
function editorHarness(file, exportName) {
  const cells = [];
  let index = 0;
  const react = {
    ...require("react"),
    useState(initial) {
      const slot = index++;
      if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial;
      return [cells[slot], value => { cells[slot] = typeof value === "function" ? value(cells[slot]) : value; }];
    },
    useRef(initial) { const slot = index++; return cells[slot] ??= { current: initial }; },
    useMemo: factory => factory(),
    useEffect() {},
  };
  const widget = new Proxy({}, { get: (_, name) => {
    if (name === "VALUE_LABELS") return ["Høyere produktivitet", "Lavere kostnader", "Redusert risiko", "Bedre brukeropplevelse"];
    if (name === "canEditGeneratedArtifact") return () => true;
    if (name === "formatDate") return () => "1. januar 2026";
    if (name === "documentDropzoneClass") return () => "";
    return name;
  } });
  const loadedModule = { exports: {} };
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function("require", "module", "exports", compiled)(id => {
    if (id === "react") return react;
    if (id.startsWith("@/components/")) return widget;
    return id.startsWith("@/") ? jiti(id) : require(id);
  }, loadedModule, loadedModule.exports);
  return props => { index = 0; return loadedModule.exports[exportName](props); };
}
function elements(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return node.props ? [node, ...elements(node.props.children)] : [];
}
function text(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return node?.props ? text(node.props.children) : "";
}
function click(tree, label) {
  const button = elements(tree).find(node => node.props.onClick && text(node).trim() === label);
  assert.ok(button, `Button ${label} exists`);
  assert.ok(!button.props.disabled);
  return button.props.onClick();
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const artifact = { id: "answer", title: "Svar", content_markdown: "Før lagring", artifact_type: "forbedret_kravsvar", artifact_version: 1, created_at: "2026-01-01T12:00:00Z", generation_metadata: {} };

for (const succeeds of [true, false]) {
  test(`requirement editor freezes its submitted fields and ${succeeds ? "closes on success" : "keeps input after failure"}`, async () => {
    const render = editorHarness("./project-requirement-response-tab.tsx", "ProjectRequirementResponseTab");
    const save = deferred(); let submitted;
    const props = { projectId: "project", documents: [], artifacts: [artifact], uploadBusy: false, generateBusy: false, busyMessage: "", busyProgress: 0,
      onUpdateArtifact: async (_, value) => { submitted = value; await save.promise; }, onDeleteArtifact: async () => {}, onRegenerateRequirements: async () => {}, onUpload: async () => null, onSubmit() {} };
    click(render(props), "Rediger");
    let tree = render(props);
    elements(tree).find(node => node.props.id === "requirement-content-answer").props.onChange({ target: { value: "Mitt utkast" } });
    tree = render(props);
    const form = elements(tree).find(node => node.type === "form" && elements(node).some(child => child.props.id === "requirement-content-answer"));
    form.props.onSubmit({ preventDefault() {} });
    tree = render(props);
    const fieldset = elements(tree).find(node => node.type === "fieldset");
    assert.equal(fieldset?.props.disabled, true, "Native fieldset must prevent edits to the pending snapshot");
    assert.ok(elements(fieldset).some(node => node.props.id === "requirement-content-answer"));
    assert.equal(submitted.content_markdown, "Mitt utkast");
    if (succeeds) save.resolve(); else save.reject(new Error("Avvist"));
    await new Promise(resolve => setImmediate(resolve));
    tree = render(props);
    const content = elements(tree).find(node => node.props.id === "requirement-content-answer");
    if (succeeds) assert.equal(content, undefined);
    else { assert.equal(content.props.value, "Mitt utkast"); assert.equal(elements(tree).find(node => node.type === "fieldset").props.disabled, false); }
  });
}

const analysis = { revision: "revision", customer_profile_summary: "Profil", customer_goals_summary: "Mål", executive_summary: "Strategi", value_opportunities: [], implicit_requirements: [], prioritized_requirements: [], signal_words: [], signal_word_counts: {}, recommended_services: [], positioning_recommendations: [], ambiguities: [], risks: [], risks_for_us: [], risks_for_customer: [] };
for (const succeeds of [true, false]) {
  test(`analysis editor freezes nested controls and ${succeeds ? "closes" : "retains its draft"} after save`, async () => {
    const render = editorHarness("./project-analysis-tab.tsx", "ProjectAnalysisTab");
    const save = deferred(); let submitted;
    const props = { projectId: "project", documents: [], customerAnalysis: analysis, busy: false, saveBusy: false, sectionBusy: null, busyMessage: "", busyProgress: 0,
      onSaveAnalysis: async (_, value) => { props.saveBusy = true; submitted = value; return save.promise; } };
    click(render(props), "Rediger");
    let tree = render(props);
    elements(tree).find(node => node.props.id === "edit-customer-profile-summary").props.onChange({ target: { value: "Mitt profilutkast" } });
    click(render(props), "Lagre");
    tree = render(props);
    const fieldset = elements(tree).find(node => node.type === "fieldset");
    assert.equal(fieldset?.props.disabled, true);
    assert.ok(elements(fieldset).some(node => node.props.id === "edit-customer-profile-summary"));
    assert.equal(submitted.customer_profile_summary, "Mitt profilutkast");
    if (succeeds) save.resolve(true); else save.reject(new Error("Revisjonskonflikt"));
    await new Promise(resolve => setImmediate(resolve)); props.saveBusy = false;
    tree = render(props);
    const content = elements(tree).find(node => node.props.id === "edit-customer-profile-summary");
    if (succeeds) assert.equal(content, undefined);
    else { assert.equal(content.props.value, "Mitt profilutkast"); assert.equal(elements(tree).find(node => node.type === "fieldset").props.disabled, false); }
  });
}
