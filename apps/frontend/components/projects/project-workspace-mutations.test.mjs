import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const frontend = new URL("../../", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, { alias: { "@": frontend } });
const { mergeProjectRefresh, isProjectSnapshotOlder, mergeGeneratedArtifactsForType } = jiti("./project-workflow-status.ts");
const source = ts.createSourceFile("workspace.tsx", readFileSync(new URL("./project-workspace-page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name, dependencies) {
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration, `Production ${name} exists`);
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}; return ${name};`)(...Object.values(dependencies));
}
function deferred() { let reject; const promise = new Promise((_, no) => { reject = no; }); return { promise, reject }; }
const artifact = { id: "artifact", title: "Lagret", content_markdown: "Lagret svar", artifact_type: "forbedret_kravsvar", artifact_version: 1, created_at: "2026-01-01T12:00:00Z", source_revision: 1 };
function project(revision) {
  return { id: "project", snapshot_revision: revision, status: "Klar", document_count: 1, artifact_count: 1,
    customer_analysis_generated: true, solution_evaluation_generated: false, customer_analysis: { revision: `analysis-${revision}` },
    solution_evaluation: null, executive_summary: null, documents: [{ id: "document", processing_status: revision > 1 ? "enhanced_ready" : "processing" }],
    generated_artifacts: [{ ...artifact }], current_artifact_types: ["forbedret_kravsvar"], artifact_authority: {} };
}

for (const mutation of ["onUpdateRequirementArtifact", "onDeleteArtifact", "onDeleteDocument"]) {
  for (const reconciliation of ["newer", "older", "unavailable"]) {
    test(`${mutation}: rejected request preserves a newer poll when reconciliation is ${reconciliation}`, async () => {
      const request = deferred();
      const initial = project(1);
      let state = initial, reads = 0;
      const setProject = update => { state = typeof update === "function" ? update(state) : update; };
      const reconcileFailedProjectMutation = handler("reconcileFailedProjectMutation", {
        project: initial, setProject, mergeProjectRefresh, isProjectSnapshotOlder, mergeGeneratedArtifactsForType,
        fetchProjectState: async () => { reads++; if (reconciliation === "unavailable") throw new Error("offline"); return { ...project(reconciliation === "newer" ? 3 : 1), generated_artifacts: [] }; },
        fetchGeneratedArtifacts: async () => [{ ...artifact }],
      });
      const run = handler(mutation, { project: initial, setProject, reconcileFailedProjectMutation,
        updateGeneratedArtifact: () => request.promise, deleteGeneratedArtifact: () => request.promise, deleteProjectDocument: () => request.promise,
        setError() {}, setNotice() {}, setBusy() {}, runAction: async (_, action) => action(),
      });
      const pending = mutation === "onUpdateRequirementArtifact" ? run(artifact, { title: "Utkast", content_markdown: "Ny tekst" }) : run(mutation === "onDeleteDocument" ? initial.documents[0] : artifact);
      assert.equal(state, initial, "Pending requests leave confirmed data visible");
      state = project(2);
      request.reject(new Error("Lost response"));
      await assert.rejects(pending, /Lost response/);
      assert.equal(reads, 1, "A failed response is reconciled without replaying the write");
      assert.equal(state.snapshot_revision, reconciliation === "newer" ? 3 : 2);
      assert.equal(state.documents[0].processing_status, "enhanced_ready");
      assert.equal(state.generated_artifacts[0].content_markdown, "Lagret svar");
    });
  }
}

test("a committed deletion with a lost response is recovered from persisted state", async () => {
  const initial = project(1); let state = initial;
  const saved = { ...project(2), documents: [], document_count: 0 };
  const setProject = update => { state = update(state); };
  const reconcileFailedProjectMutation = handler("reconcileFailedProjectMutation", {
    project: initial, setProject, mergeProjectRefresh, isProjectSnapshotOlder, mergeGeneratedArtifactsForType, fetchProjectState: async () => saved,
  });
  const run = handler("onDeleteDocument", {
    project: initial, setProject, reconcileFailedProjectMutation, runAction: async (_, action) => action(),
    deleteProjectDocument: async () => { throw new Error("Response lost after commit"); },
  });
  await assert.rejects(run(initial.documents[0]), /Response lost/);
  assert.equal(state.snapshot_revision, 2);
  assert.deepEqual(state.documents, []);
});

for (const action of ["update", "delete"]) {
  test(`committed artifact ${action} with a lost response refreshes saved bodies without retry`, async () => {
    const initial = project(1); let state = initial, writes = 0;
    const saved = { ...project(2), generated_artifacts: action === "delete" ? [] : [{ ...artifact, content_markdown: "Lagret på serveren" }] };
    const setProject = update => { state = update(state); };
    const reconcileFailedProjectMutation = handler("reconcileFailedProjectMutation", {
      project: initial, setProject, mergeProjectRefresh, isProjectSnapshotOlder, mergeGeneratedArtifactsForType,
      fetchProjectState: async () => ({ ...saved, generated_artifacts: [] }),
      fetchGeneratedArtifacts: async () => saved.generated_artifacts,
    });
    const failedWrite = async () => { writes++; throw new Error("Response lost after commit"); };
    const run = handler(action === "delete" ? "onDeleteArtifact" : "onUpdateRequirementArtifact", {
      project: initial, setProject, reconcileFailedProjectMutation,
      updateGeneratedArtifact: failedWrite, deleteGeneratedArtifact: failedWrite,
      setError() {}, setNotice() {}, setBusy() {},
    });
    await assert.rejects(run(artifact, { title: "Ny", content_markdown: "Lagret på serveren" }), /Response lost/);
    assert.equal(writes, 1);
    assert.deepEqual(state.generated_artifacts.map(row => [row.id, row.content_markdown]), saved.generated_artifacts.map(row => [row.id, row.content_markdown]));
  });
}

test("failed artifact reconciliation retains a draft when only the project shell can refresh", async () => {
  const initial = project(1); let state = initial;
  const reconcile = handler("reconcileFailedProjectMutation", {
    project: initial, setProject: update => { state = update(state); },
    mergeProjectRefresh, isProjectSnapshotOlder, mergeGeneratedArtifactsForType,
    fetchProjectState: async () => ({ ...project(2), generated_artifacts: [] }),
    fetchGeneratedArtifacts: async () => { throw new Error("artifact read unavailable"); },
  });
  await reconcile("forbedret_kravsvar");
  assert.equal(state.snapshot_revision, 2);
  assert.equal(state.generated_artifacts[0].content_markdown, "Lagret svar");
});
