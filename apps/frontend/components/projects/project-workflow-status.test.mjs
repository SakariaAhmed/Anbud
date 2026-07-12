import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const jiti = createJiti(path.join(frontendRoot, "project-workflow-status-tests.cjs"), {
  alias: { "@": frontendRoot },
  interopDefault: true,
});
const {
  applyProjectSnapshot,
  canEditGeneratedArtifact,
  createLatestArtifactAuthorityRequestGate,
  hasAuthoritativeCurrentArtifact,
  loadedArtifactTypesMissingAuthorityVersion,
  mergeGeneratedArtifactsForType,
  prependGeneratedArtifactVersion,
  reconcileGeneratedArtifactAuthority,
  solutionProposalWorkflowStatus,
} = await jiti.import(
  path.join(
    frontendRoot,
    "components/projects/project-workflow-status.ts",
  ),
);

function projectDetail(overrides = {}) {
  return {
    id: "project-1",
    name: "Prosjekt",
    customer_name: "Kunde",
    description: null,
    industry: null,
    status: "Klar for sparring",
    customer_document_uploaded: true,
    customer_analysis_generated: true,
    solution_document_uploaded: true,
    solution_evaluation_generated: true,
    last_activity_at: "2026-07-11T10:00:00.000Z",
    created_at: "2026-07-11T09:00:00.000Z",
    updated_at: "2026-07-11T10:00:00.000Z",
    document_count: 2,
    supporting_document_count: 0,
    artifact_count: 0,
    has_executive_summary: true,
    has_chat: false,
    documents: [],
    customer_analysis: { customer_profile_summary: "Gammel analyse" },
    solution_evaluation: { fit_to_customer_needs: "Gammel vurdering" },
    executive_summary: { executive_summary: "Gammel oppsummering" },
    generated_artifacts: [],
    chat_messages: [],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    name: "Prosjekt",
    customer_name: "Kunde",
    description: null,
    industry: null,
    status: "Dokument lastet opp",
    customer_document_uploaded: true,
    customer_analysis_generated: false,
    solution_document_uploaded: true,
    solution_evaluation_generated: false,
    last_activity_at: "2026-07-11T11:00:00.000Z",
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    id: "artifact-1",
    project_id: "project-1",
    artifact_type: "forbedret_kravsvar",
    title: "Kravsvar",
    content_markdown: "Svar",
    input_snapshot: {},
    created_at: "2026-07-11T10:00:00.000Z",
    artifact_version: 1,
    is_current: true,
    source_is_current: true,
    ...overrides,
  };
}

function artifactAuthority(overrides = {}) {
  return {
    forbedret_kravsvar: {
      id: "artifact-1",
      artifact_version: 1,
      source_is_current: true,
      ...overrides,
    },
  };
}

test("project snapshots clear stale derived objects when generated flags are false", () => {
  const merged = applyProjectSnapshot(projectDetail(), snapshot());
  assert.equal(merged.customer_analysis, null);
  assert.equal(merged.solution_evaluation, null);
  assert.equal(merged.executive_summary, null);
  assert.equal(merged.has_executive_summary, false);
});

test("project snapshots preserve loaded derived objects while their flags remain true", () => {
  const previous = projectDetail();
  const merged = applyProjectSnapshot(
    previous,
    snapshot({
      customer_analysis_generated: true,
      solution_evaluation_generated: true,
    }),
  );
  assert.equal(merged.customer_analysis, previous.customer_analysis);
  assert.equal(merged.solution_evaluation, previous.solution_evaluation);
  assert.equal(merged.executive_summary, previous.executive_summary);
  assert.equal(merged.has_executive_summary, true);
});

test("document upload snapshots preserve evaluation but clear the independently invalidated summary", () => {
  const previous = projectDetail();
  const merged = applyProjectSnapshot(
    previous,
    snapshot({
      customer_analysis_generated: true,
      solution_evaluation_generated: true,
    }),
    { invalidateExecutiveSummary: true },
  );
  assert.equal(merged.solution_evaluation, previous.solution_evaluation);
  assert.equal(merged.executive_summary, null);
  assert.equal(merged.has_executive_summary, false);
});

test("sidebar artifact status is authoritative before and after lazy tab loading", () => {
  const unloaded = projectDetail({
    current_artifact_types: ["forbedret_kravsvar"],
    artifact_authority: artifactAuthority(),
    generated_artifacts: [],
  });
  assert.equal(
    hasAuthoritativeCurrentArtifact(unloaded, "forbedret_kravsvar"),
    true,
  );

  const afterTabVisit = projectDetail({
    current_artifact_types: ["forbedret_kravsvar"],
    artifact_authority: artifactAuthority(),
    generated_artifacts: [artifact()],
  });
  assert.equal(
    hasAuthoritativeCurrentArtifact(afterTabVisit, "forbedret_kravsvar"),
    true,
  );

  const staleOrHistoryOnly = projectDetail({
    current_artifact_types: [],
    artifact_authority: artifactAuthority({ source_is_current: false }),
    generated_artifacts: [
      artifact({ source_is_current: false }),
      artifact({ id: "artifact-history", artifact_version: 0, is_current: false }),
    ],
  });
  assert.equal(
    hasAuthoritativeCurrentArtifact(staleOrHistoryOnly, "forbedret_kravsvar"),
    false,
  );
});

test("prepending a generated or manually edited version demotes its predecessor", () => {
  const previous = artifact({ id: "artifact-v1", artifact_version: 1 });
  const next = artifact({ id: "artifact-v2", artifact_version: 2 });
  const merged = prependGeneratedArtifactVersion([previous], next);
  assert.equal(merged[0].is_current, true);
  assert.equal(merged[1].is_current, false);
});

test("deleting current version promotes the highest remaining loaded version", () => {
  const remaining = artifact({ id: "artifact-v1", artifact_version: 1, is_current: false });
  const reconciled = reconcileGeneratedArtifactAuthority(
    [remaining],
    artifactAuthority({ id: "artifact-v1" }),
  );
  assert.equal(reconciled[0].is_current, true);
  assert.equal(reconciled[0].source_is_current, true);
});

test("an unseen newer cross-session version never promotes an older loaded card", () => {
  const loadedOldVersion = artifact({
    id: "artifact-v1",
    artifact_version: 1,
    is_current: true,
  });
  const reconciled = reconcileGeneratedArtifactAuthority(
    [loadedOldVersion],
    artifactAuthority({ id: "artifact-v2", artifact_version: 2 }),
  );
  assert.equal(reconciled[0].is_current, false);
});

test("focus authority transition fetches v2 and keeps loaded v1 as history", () => {
  const v1 = artifact({ id: "artifact-v1", artifact_version: 1 });
  const v2Authority = artifactAuthority({
    id: "artifact-v2",
    artifact_version: 2,
  });
  const missingTypes = loadedArtifactTypesMissingAuthorityVersion(
    [v1],
    v2Authority,
    ["forbedret_kravsvar"],
  );
  assert.deepEqual(missingTypes, ["forbedret_kravsvar"]);

  const fetched = [
    artifact({ id: "artifact-v2", artifact_version: 2 }),
    artifact({ id: "artifact-v1", artifact_version: 1, is_current: false }),
  ];
  const reconciled = reconcileGeneratedArtifactAuthority(
    mergeGeneratedArtifactsForType(
      [v1],
      fetched,
      "forbedret_kravsvar",
    ),
    v2Authority,
  );

  assert.equal(reconciled.find((item) => item.id === "artifact-v2").is_current, true);
  assert.equal(reconciled.find((item) => item.id === "artifact-v1").is_current, false);
  assert.deepEqual(
    loadedArtifactTypesMissingAuthorityVersion(
      reconciled,
      v2Authority,
      ["forbedret_kravsvar"],
    ),
    [],
  );
});

test("overlapping authority refreshes ignore an older response that resolves last", async () => {
  const gate = createLatestArtifactAuthorityRequestGate();
  const applied = [];
  let resolveFirst;
  let resolveSecond;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const second = new Promise((resolve) => {
    resolveSecond = resolve;
  });
  async function refresh(resultPromise) {
    const sequence = gate.start();
    const result = await resultPromise;
    if (gate.isLatest(sequence)) applied.push(result);
  }
  const firstRefresh = refresh(first);
  const secondRefresh = refresh(second);
  resolveSecond("new-authority");
  await secondRefresh;
  resolveFirst("old-authority");
  await firstRefresh;
  assert.deepEqual(applied, ["new-authority"]);
});

test("source mutation snapshots stale loaded current artifacts and disable editing", () => {
  const merged = applyProjectSnapshot(
    projectDetail({ generated_artifacts: [artifact()] }),
    snapshot({
      customer_analysis_generated: true,
      solution_evaluation_generated: true,
      current_artifact_types: [],
      artifact_authority: artifactAuthority({ source_is_current: false }),
    }),
  );
  assert.equal(merged.generated_artifacts[0].is_current, true);
  assert.equal(merged.generated_artifacts[0].source_is_current, false);
  assert.equal(canEditGeneratedArtifact(merged.generated_artifacts[0]), false);
  assert.equal(
    canEditGeneratedArtifact(artifact({ is_current: false })),
    false,
  );
  assert.equal(canEditGeneratedArtifact(artifact()), true);
});

test("solution proposal is Generert only when a solution description artifact exists", () => {
  assert.equal(
    solutionProposalWorkflowStatus({
      hasGeneratedSolutionDescription: true,
      hasReadyEvaluationBasis: false,
      hasCustomerAnalysis: false,
    }),
    "Generert",
  );

  assert.equal(
    solutionProposalWorkflowStatus({
      hasGeneratedSolutionDescription: false,
      hasReadyEvaluationBasis: true,
      hasCustomerAnalysis: false,
    }),
    "Klar",
  );
});

test("analysis readiness does not claim that a solution description was generated", () => {
  assert.equal(
    solutionProposalWorkflowStatus({
      hasGeneratedSolutionDescription: false,
      hasReadyEvaluationBasis: false,
      hasCustomerAnalysis: true,
    }),
    "Klar",
  );
  assert.equal(
    solutionProposalWorkflowStatus({
      hasGeneratedSolutionDescription: false,
      hasReadyEvaluationBasis: false,
      hasCustomerAnalysis: false,
    }),
    "Venter",
  );
});
