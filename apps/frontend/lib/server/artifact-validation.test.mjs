import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

const jiti = createJiti(path.join(frontendRoot, "artifact-validation-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  buildImmutableRequirementRowManifest,
  buildValidatedManualArtifactInputSnapshot,
  validateGeneratedArtifact,
} = jiti(
  path.join(frontendRoot, "lib/server/artifact-validation.ts"),
);

const baseInput = {
  artifactType: "forbedret_kravsvar",
  title: "Kravbesvarelse",
  expectedRequirementCount: 1,
  expectedRequirementRefs: ["K-001"],
  unresolvedFallbackAnswers: 0,
};

function manualEditParentSnapshot() {
  const immutableRowManifest = buildImmutableRequirementRowManifest([
    {
      ref: "K-001",
      requirementText: "Leverandøren skal dokumentere logging.",
      sourceLocator: "Bilag 2, side 4, K-001",
      sourceDocumentId: "requirements-a",
    },
    {
      ref: "K-002",
      requirementText: "Leverandøren skal dokumentere backup.",
      sourceLocator: "Bilag 2, side 5, K-002",
      sourceDocumentId: "requirements-a",
    },
  ]);
  return {
    generation_metadata: {
      requirement_response: {
        total_requirements: 2,
        requirement_refs: ["K-001", "K-002"],
        deterministic_fallback_answers_after_handoff: 0,
        coverage_enforced: true,
        source_evidence_enforced: true,
        immutable_row_manifest: immutableRowManifest,
      },
    },
    artifact_quality_report: {
      status: "pass",
      issues: ["Denne gamle rapporten skal erstattes."],
    },
  };
}

function addManualReviewMetadata(parentInputSnapshot, {
  templateRows = [],
  controlRows = [],
  proposalRows = [],
} = {}) {
  const requirementResponse =
    parentInputSnapshot.generation_metadata.requirement_response;
  Object.assign(requirementResponse, {
    deterministic_template_repair_answers: templateRows.length,
    deterministic_template_repair_refs: templateRows.map((row) => row.ref),
    deterministic_template_repair_rows: templateRows,
    deterministic_control_repair_answers: controlRows.length,
    deterministic_control_repair_refs: controlRows.map((row) => row.ref),
    deterministic_control_repair_rows: controlRows,
    proposal_input_required_count: proposalRows.length,
    proposal_input_required_refs: proposalRows.map((row) => row.ref),
    proposal_input_required_rows: proposalRows,
    manual_review_required:
      templateRows.length + controlRows.length + proposalRows.length > 0,
    manual_review_note:
      "Deterministiske reparasjoner og tilbudsavhengige gap krever manuell gjennomgang.",
  });
  return parentInputSnapshot;
}

const templateReviewRow = {
  ref: "K-001",
  order_index: 0,
  source_document_id: "requirements-a",
  source_locator: "Bilag 2, side 4, K-001",
};
const controlReviewRow = {
  ref: "K-002",
  order_index: 1,
  pattern: "backup",
  repair_stage: "pre_handoff",
  source_document_id: "requirements-a",
  source_locator: "Bilag 2, side 5, K-002",
};
const proposalReviewRow = {
  ref: "K-001",
  order_index: 0,
  reasons: ["Mangler navngitt tilbudsbevis."],
  source_document_id: "requirements-a",
  source_locator: "Bilag 2, side 4, K-001",
};

function manualEditMarkdown(rows) {
  return [
    "## Validert kravbesvarelse",
    "",
    "Kravene er besvart med konkrete, etterprøvbare kontroller, tydelig ansvar, målepunkter og dokumentert kildegrunnlag for leveransen.",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

const manualRowOne =
  "| K-001 | Leverandøren skal dokumentere logging. | Atea dokumenterer logging med ansvar, kontrollpunkter, målinger og revisjonsspor. | Svaret beskriver ansvar, kontroll og etterprøvbar logging. | Bilag 2, side 4, K-001 |";
const manualRowTwo =
  "| K-002 | Leverandøren skal dokumentere backup. | Atea dokumenterer backup med gjenopprettingstest, målepunkt og avvikshåndtering. | Svaret beskriver test, måling og håndtering av avvik. | Bilag 2, side 5, K-002 |";

test("kravsvar validation accepts five-column table with answer evidence", () => {
  const report = validateGeneratedArtifact({
    ...baseInput,
    contentMarkdown: [
      "## Status",
      "",
      "Ett krav er identifisert og besvart i kravtabellen.",
      "",
      "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
      "|---|---|---|---|---|",
      "| K-001 | Leverandøren skal dokumentere logging. | Atea dokumenterer logging med ansvar, kontroll og revisjonsspor. | Kravet ber om dokumentert logging. | Bilag 2, side 4, K-001 |",
    ].join("\n"),
  });

  assert.equal(report.metrics.missingAnswerEvidence, 0);
  assert.equal(report.metrics.missingSources, 0);
  assert.equal(report.status, "pass");
});

test("kravsvar validation fails closed on unresolved deterministic answers", () => {
  const report = validateGeneratedArtifact({
    ...baseInput,
    unresolvedFallbackAnswers: 1,
    contentMarkdown: [
      "## Status",
      "",
      "Ett krav er identifisert og besvart i kravtabellen.",
      "",
      "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
      "|---|---|---|---|---|",
      "| K-001 | Leverandøren skal dokumentere logging. | Atea dokumenterer logging med ansvar, kontroll og revisjonsspor. | Kravet ber om dokumentert logging. | Bilag 2, side 4, K-001 |",
    ].join("\n"),
  });

  assert.equal(report.metrics.unresolvedFallbackAnswers, 1);
  assert.equal(report.status, "fail");
  assert.ok(
    report.issues.includes(
      "1 kravsvar er fortsatt deterministisk fallback etter reparasjon og kan ikke lagres som ferdig.",
    ),
  );
});

test("kravsvar validation fails when answer evidence column is missing", () => {
  const report = validateGeneratedArtifact({
    ...baseInput,
    contentMarkdown: [
      "## Status",
      "",
      "Ett krav er identifisert og besvart i kravtabellen.",
      "",
      "| Kravref. | Krav | Svar | Kildegrunnlag |",
      "|---|---|---|---|",
      "| K-001 | Leverandøren skal dokumentere logging. | Atea dokumenterer logging med ansvar, kontroll og revisjonsspor. | Bilag 2, side 4, K-001 |",
    ].join("\n"),
  });

  assert.equal(report.metrics.missingAnswerEvidence, 1);
  assert.equal(report.metrics.missingSources, 0);
  assert.equal(report.status, "fail");
  assert.ok(report.issues.includes("Minst én kravrad mangler svargrunnlag."));
});

test("kravsvar validation requires expected refs in the Kravref column", () => {
  const report = validateGeneratedArtifact({
    ...baseInput,
    contentMarkdown: [
      "## Status",
      "",
      "Ett krav er identifisert og besvart i kravtabellen.",
      "",
      "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
      "|---|---|---|---|---|",
      "| K-999 | Leverandøren skal dokumentere logging. | Atea dokumenterer logging med ansvar, kontroll og revisjonsspor. | Gjelder K-001. | Bilag 2, side 4, K-001 |",
    ].join("\n"),
  });

  assert.equal(report.metrics.missingExpectedRequirements, 1);
  assert.equal(report.status, "fail");
  assert.ok(
    report.issues.includes(
      "1 kravreferanser fra kravledgeren mangler i kravbesvarelsen.",
    ),
  );
});

test("kravsvar validation rejects extra rendered requirement rows", () => {
  const report = validateGeneratedArtifact({
    ...baseInput,
    contentMarkdown: [
      "## Status",
      "",
      "Ett krav er identifisert og besvart i kravtabellen.",
      "",
      "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
      "|---|---|---|---|---|",
      "| K-001 | Leverandøren skal dokumentere logging. | Atea dokumenterer logging med ansvar, kontroll og revisjonsspor. | Kravet ber om dokumentert logging. | Bilag 2, side 4, K-001 |",
      "| K-002 | Leverandøren skal dokumentere backup. | Atea dokumenterer backup med kontroll og test. | Kravet ber om dokumentert backup. | Bilag 2, side 5, K-002 |",
    ].join("\n"),
  });

  assert.equal(report.metrics.extraRequirementRows, 1);
  assert.equal(report.status, "fail");
  assert.ok(
    report.issues.includes(
      "Kravbesvarelsen har 2 kravrader, men kravledgeren forventer nøyaktig 1.",
    ),
  );
});

test("kravsvar validation rejects requirement row reordering", () => {
  const report = validateGeneratedArtifact({
    ...baseInput,
    expectedRequirementCount: 2,
    expectedRequirementRefs: ["K-001", "K-002"],
    contentMarkdown: [
      "## Status",
      "",
      "To krav er identifisert og besvart i kravtabellen.",
      "",
      "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
      "|---|---|---|---|---|",
      "| K-002 | Leverandøren skal dokumentere backup. | Atea dokumenterer backup med kontroll og test. | Kravet ber om dokumentert backup. | Bilag 2, side 5, K-002 |",
      "| K-001 | Leverandøren skal dokumentere logging. | Atea dokumenterer logging med ansvar, kontroll og revisjonsspor. | Kravet ber om dokumentert logging. | Bilag 2, side 4, K-001 |",
    ].join("\n"),
  });

  assert.equal(report.metrics.missingExpectedRequirements, 0);
  assert.equal(report.metrics.outOfOrderExpectedRequirements, 2);
  assert.equal(report.status, "fail");
  assert.ok(
    report.issues.includes(
      "2 kravrader står ikke i samme rekkefølge som kravledgeren.",
    ),
  );
});

test("kravsvar validation does not let a longer reference impersonate its prefix", () => {
  const report = validateGeneratedArtifact({
    ...baseInput,
    expectedRequirementCount: 2,
    expectedRequirementRefs: ["K-1", "K-1.1"],
    contentMarkdown: manualEditMarkdown([
      manualRowOne.replaceAll("K-001", "K-1.1"),
      manualRowTwo.replaceAll("K-002", "K-1.1"),
    ]),
  });

  assert.equal(report.status, "fail");
  assert.equal(report.metrics.missingExpectedRequirements, 1);
  assert.ok(report.metrics.outOfOrderExpectedRequirements > 0);
});

test("manual kravsvar edit is revalidated and replaces the inherited quality report", () => {
  const snapshot = buildValidatedManualArtifactInputSnapshot({
    artifactType: "forbedret_kravsvar",
    title: "Manuelt forbedret kravbesvarelse",
    contentMarkdown: manualEditMarkdown([manualRowOne, manualRowTwo]),
    parentInputSnapshot: manualEditParentSnapshot(),
    parentArtifactId: "artifact-v1",
    editedAt: "2026-07-11T10:00:00.000Z",
  });

  assert.equal(snapshot.edited_manually, true);
  assert.equal(snapshot.parent_artifact_id, "artifact-v1");
  assert.equal(snapshot.artifact_quality_report.status, "pass");
  assert.deepEqual(snapshot.artifact_quality_report.issues, []);
  assert.equal(snapshot.manual_edit_validation.expected_requirement_count, 2);
  assert.deepEqual(snapshot.manual_edit_validation.expected_requirement_refs, [
    "K-001",
    "K-002",
  ]);
  assert.equal(
    snapshot.manual_edit_validation.immutable_row_manifest_sha256,
    snapshot.generation_metadata.requirement_response.immutable_row_manifest
      .manifest_sha256,
  );
});

test("manual kravsvar edit permits answer and answer-evidence edits only", () => {
  const editedAnswerRows = [
    manualRowOne
      .replace(
        "Atea dokumenterer logging med ansvar, kontrollpunkter, målinger og revisjonsspor.",
        "Atea leverer logging med navngitt eier, daglig kontroll og månedlig revisjonsrapport.",
      )
      .replace(
        "Svaret beskriver ansvar, kontroll og etterprøvbar logging.",
        "Svaret binder leveransen til eier, frekvens og revisjonsrapport.",
      ),
    manualRowTwo,
  ];

  assert.doesNotThrow(() =>
    buildValidatedManualArtifactInputSnapshot({
      artifactType: "forbedret_kravsvar",
      title: "Manuelt forbedret kravbesvarelse",
      contentMarkdown: manualEditMarkdown(editedAnswerRows),
      parentInputSnapshot: manualEditParentSnapshot(),
      parentArtifactId: "artifact-v1",
      editedAt: "2026-07-11T10:00:00.000Z",
    }),
  );
});

test("manual review flags survive unrelated edits and edits without acknowledgement", () => {
  const parentContentMarkdown = manualEditMarkdown([
    manualRowOne,
    manualRowTwo,
  ]);
  const changedFlaggedRow = manualRowOne.replace(
    "Atea dokumenterer logging med ansvar, kontrollpunkter, målinger og revisjonsspor.",
    "Atea leverer logging med navngitt eier, daglig kontroll og månedlig revisjonsrapport.",
  );
  const changedUnrelatedRow = manualRowTwo.replace(
    "Atea dokumenterer backup med gjenopprettingstest, målepunkt og avvikshåndtering.",
    "Atea leverer backup med ukentlig gjenopprettingstest, navngitt eier og avvikslogg.",
  );

  const withoutAcknowledgement = buildValidatedManualArtifactInputSnapshot({
    artifactType: "forbedret_kravsvar",
    title: "Manuelt forbedret kravbesvarelse",
    parentContentMarkdown,
    contentMarkdown: manualEditMarkdown([changedFlaggedRow, manualRowTwo]),
    parentInputSnapshot: addManualReviewMetadata(manualEditParentSnapshot(), {
      templateRows: [templateReviewRow],
    }),
    parentArtifactId: "artifact-v1",
    editedAt: "2026-07-11T10:00:00.000Z",
    acknowledgeDeterministicRepairs: false,
  });
  const unrelatedEdit = buildValidatedManualArtifactInputSnapshot({
    artifactType: "forbedret_kravsvar",
    title: "Manuelt forbedret kravbesvarelse",
    parentContentMarkdown,
    contentMarkdown: manualEditMarkdown([manualRowOne, changedUnrelatedRow]),
    parentInputSnapshot: addManualReviewMetadata(manualEditParentSnapshot(), {
      templateRows: [templateReviewRow],
    }),
    parentArtifactId: "artifact-v1",
    editedAt: "2026-07-11T10:01:00.000Z",
    acknowledgeDeterministicRepairs: true,
  });

  for (const snapshot of [withoutAcknowledgement, unrelatedEdit]) {
    const metadata = snapshot.generation_metadata.requirement_response;
    assert.equal(metadata.deterministic_template_repair_answers, 1);
    assert.deepEqual(metadata.deterministic_template_repair_refs, ["K-001"]);
    assert.deepEqual(metadata.deterministic_template_repair_rows, [
      templateReviewRow,
    ]);
    assert.equal(metadata.manual_review_required, true);
    assert.deepEqual(
      snapshot.manual_edit_validation.remediated_repair_rows,
      [],
    );
  }
});

test("acknowledged answer edit clears only its deterministic repair flag", () => {
  const changedFlaggedRow = manualRowOne.replace(
    "Atea dokumenterer logging med ansvar, kontrollpunkter, målinger og revisjonsspor.",
    "Atea leverer logging med navngitt eier, daglig kontroll og månedlig revisjonsrapport.",
  );
  const snapshot = buildValidatedManualArtifactInputSnapshot({
    artifactType: "forbedret_kravsvar",
    title: "Manuelt forbedret kravbesvarelse",
    parentContentMarkdown: manualEditMarkdown([manualRowOne, manualRowTwo]),
    contentMarkdown: manualEditMarkdown([changedFlaggedRow, manualRowTwo]),
    parentInputSnapshot: addManualReviewMetadata(manualEditParentSnapshot(), {
      templateRows: [templateReviewRow],
      controlRows: [controlReviewRow],
    }),
    parentArtifactId: "artifact-v1",
    editedAt: "2026-07-11T10:02:00.000Z",
    acknowledgeDeterministicRepairs: true,
  });
  const metadata = snapshot.generation_metadata.requirement_response;

  assert.equal(metadata.deterministic_template_repair_answers, 0);
  assert.deepEqual(metadata.deterministic_template_repair_refs, []);
  assert.deepEqual(metadata.deterministic_template_repair_rows, []);
  assert.equal(metadata.deterministic_control_repair_answers, 1);
  assert.deepEqual(metadata.deterministic_control_repair_refs, ["K-002"]);
  assert.deepEqual(metadata.deterministic_control_repair_rows, [
    controlReviewRow,
  ]);
  assert.equal(metadata.manual_review_required, true);
  assert.deepEqual(snapshot.manual_edit_validation.remediated_repair_rows, [
    { kind: "template", order_index: 0, ref: "K-001" },
  ]);
});

test("acknowledgement cannot clear a repair with mismatched row provenance", () => {
  const changedSecondRow = manualRowTwo.replace(
    "Atea dokumenterer backup med gjenopprettingstest, målepunkt og avvikshåndtering.",
    "Atea leverer backup med ukentlig gjenopprettingstest, navngitt eier og avvikslogg.",
  );
  const mismatchedReviewRow = {
    ...templateReviewRow,
    order_index: 1,
    source_locator: "Bilag 2, side 5, K-002",
  };
  const snapshot = buildValidatedManualArtifactInputSnapshot({
    artifactType: "forbedret_kravsvar",
    title: "Manuelt forbedret kravbesvarelse",
    parentContentMarkdown: manualEditMarkdown([manualRowOne, manualRowTwo]),
    contentMarkdown: manualEditMarkdown([manualRowOne, changedSecondRow]),
    parentInputSnapshot: addManualReviewMetadata(manualEditParentSnapshot(), {
      templateRows: [mismatchedReviewRow],
    }),
    parentArtifactId: "artifact-v1",
    editedAt: "2026-07-11T10:02:30.000Z",
    acknowledgeDeterministicRepairs: true,
  });
  const metadata = snapshot.generation_metadata.requirement_response;

  assert.equal(metadata.deterministic_template_repair_answers, 1);
  assert.deepEqual(metadata.deterministic_template_repair_refs, ["K-001"]);
  assert.deepEqual(metadata.deterministic_template_repair_rows, [
    mismatchedReviewRow,
  ]);
  assert.equal(metadata.manual_review_required, true);
  assert.deepEqual(snapshot.manual_edit_validation.remediated_repair_rows, []);
});

test("acknowledging a deterministic repair never clears proposal input gaps", () => {
  const changedFlaggedRow = manualRowOne.replace(
    "Atea dokumenterer logging med ansvar, kontrollpunkter, målinger og revisjonsspor.",
    "Atea leverer logging med navngitt eier, daglig kontroll og månedlig revisjonsrapport.",
  );
  const snapshot = buildValidatedManualArtifactInputSnapshot({
    artifactType: "forbedret_kravsvar",
    title: "Manuelt forbedret kravbesvarelse",
    parentContentMarkdown: manualEditMarkdown([manualRowOne, manualRowTwo]),
    contentMarkdown: manualEditMarkdown([changedFlaggedRow, manualRowTwo]),
    parentInputSnapshot: addManualReviewMetadata(manualEditParentSnapshot(), {
      templateRows: [templateReviewRow],
      proposalRows: [proposalReviewRow],
    }),
    parentArtifactId: "artifact-v1",
    editedAt: "2026-07-11T10:03:00.000Z",
    acknowledgeDeterministicRepairs: true,
  });
  const metadata = snapshot.generation_metadata.requirement_response;

  assert.equal(metadata.deterministic_template_repair_answers, 0);
  assert.equal(metadata.proposal_input_required_count, 1);
  assert.deepEqual(metadata.proposal_input_required_refs, ["K-001"]);
  assert.deepEqual(metadata.proposal_input_required_rows, [proposalReviewRow]);
  assert.equal(metadata.manual_review_required, true);
  assert.match(metadata.manual_review_note, /tilbudsavhengige gap/u);
  assert.deepEqual(snapshot.manual_edit_validation.remediated_repair_rows, [
    { kind: "template", order_index: 0, ref: "K-001" },
  ]);
});

test("manual kravsvar edit rejects changed requirement text, source, identity, or order", () => {
  const invalidBodies = [
    manualEditMarkdown([
      manualRowOne.replace(
        "Leverandøren skal dokumentere logging.",
        "Leverandøren skal dokumentere logging og backup.",
      ),
      manualRowTwo,
    ]),
    manualEditMarkdown([
      manualRowOne.replace(
        "Bilag 2, side 4, K-001",
        "Oppfunnet kilde, side 99",
      ),
      manualRowTwo,
    ]),
    manualEditMarkdown([
      manualRowOne.replaceAll("K-001", "K-999"),
      manualRowTwo,
    ]),
    manualEditMarkdown([manualRowTwo, manualRowOne]),
  ];

  for (const contentMarkdown of invalidBodies) {
    assert.throws(
      () =>
        buildValidatedManualArtifactInputSnapshot({
          artifactType: "forbedret_kravsvar",
          title: "Manuelt forbedret kravbesvarelse",
          contentMarkdown,
          parentInputSnapshot: manualEditParentSnapshot(),
          parentArtifactId: "artifact-v1",
          editedAt: "2026-07-11T10:00:00.000Z",
        }),
      /ikke lagres som autoritativ kravbesvarelse/u,
    );
  }
});

test("manual kravsvar edit can remediate historical fallback answers", () => {
  const parentInputSnapshot = manualEditParentSnapshot();
  parentInputSnapshot.generation_metadata.requirement_response.deterministic_fallback_answers_after_handoff =
    1;
  parentInputSnapshot.generation_metadata.requirement_response.unresolved_fallback_answers =
    [{ nr: 2, ref: "K-002", reason: "Historisk fallback" }];

  const snapshot = buildValidatedManualArtifactInputSnapshot({
    artifactType: "forbedret_kravsvar",
    title: "Manuelt forbedret kravbesvarelse",
    contentMarkdown: manualEditMarkdown([manualRowOne, manualRowTwo]),
    parentInputSnapshot,
    parentArtifactId: "artifact-v1",
    editedAt: "2026-07-11T10:00:00.000Z",
  });

  assert.equal(snapshot.artifact_quality_report.status, "pass");
  assert.equal(snapshot.artifact_quality_report.metrics.unresolvedFallbackAnswers, 0);
  assert.equal(
    snapshot.generation_metadata.requirement_response
      .deterministic_fallback_answers_after_handoff,
    1,
  );
});

test("manual kravsvar edit rejects missing, reordered, or evidence-free rows", () => {
  const invalidBodies = [
    manualEditMarkdown([manualRowOne]),
    manualEditMarkdown([manualRowTwo, manualRowOne]),
    manualEditMarkdown([
      manualRowOne,
      "| K-002 | Leverandøren skal dokumentere backup. | Atea dokumenterer backup med test og avvikshåndtering. |  | Bilag 2, side 5, K-002 |",
    ]),
    manualEditMarkdown([
      manualRowOne,
      "| K-002 | Leverandøren skal dokumentere backup. | Atea dokumenterer backup med test og avvikshåndtering. | Svaret beskriver test og avvikshåndtering. |  |",
    ]),
  ];

  for (const contentMarkdown of invalidBodies) {
    assert.throws(
      () =>
        buildValidatedManualArtifactInputSnapshot({
          artifactType: "forbedret_kravsvar",
          title: "Manuelt forbedret kravbesvarelse",
          contentMarkdown,
          parentInputSnapshot: manualEditParentSnapshot(),
          parentArtifactId: "artifact-v1",
          editedAt: "2026-07-11T10:00:00.000Z",
        }),
      /(?:ikke lenger består kvalitetskontrollen|ikke lagres som autoritativ kravbesvarelse)/u,
    );
  }
});

test("manual kravsvar edit fails closed on malformed immutable ledger metadata", () => {
  const invalidParentSnapshots = [
    {
      generation_metadata: {
        requirement_response: { total_requirements: 2 },
      },
    },
    {
      generation_metadata: {
        requirement_response: {
          ...manualEditParentSnapshot().generation_metadata.requirement_response,
          total_requirements: 2.4,
        },
      },
    },
    {
      generation_metadata: {
        requirement_response: {
          ...manualEditParentSnapshot().generation_metadata.requirement_response,
          requirement_refs: ["K-001", 7],
        },
      },
    },
    {
      generation_metadata: {
        requirement_response: {
          ...manualEditParentSnapshot().generation_metadata.requirement_response,
          immutable_row_manifest: {
            ...manualEditParentSnapshot().generation_metadata.requirement_response
              .immutable_row_manifest,
            manifest_sha256: "tampered",
          },
        },
      },
    },
  ];

  for (const parentInputSnapshot of invalidParentSnapshots) {
    assert.throws(
      () =>
        buildValidatedManualArtifactInputSnapshot({
          artifactType: "forbedret_kravsvar",
          title: "Manuelt forbedret kravbesvarelse",
          contentMarkdown: manualEditMarkdown([manualRowOne, manualRowTwo]),
          parentInputSnapshot,
          parentArtifactId: "artifact-v1",
          editedAt: "2026-07-11T10:00:00.000Z",
        }),
      /uforanderlig kravgrunnlag/u,
    );
  }
});
