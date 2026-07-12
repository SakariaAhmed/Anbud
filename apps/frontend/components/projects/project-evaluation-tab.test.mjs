import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const jiti = createJiti(path.join(frontendRoot, "evaluation-ui-tests.cjs"), {
  alias: { "@": frontendRoot },
  interopDefault: true,
});
const { summarizeRequirementCoverageCounters } = await jiti.import(
  path.join(frontendRoot, "lib/requirement-coverage-summary.ts"),
);
const { isSolutionEvaluationCandidate } = await jiti.import(
  path.join(frontendRoot, "lib/document-processing.ts"),
);
const { selectSolutionEvaluationDocumentCandidates } = await jiti.import(
  path.join(
    frontendRoot,
    "components/projects/project-evaluation-documents.ts",
  ),
);

test("solution evaluation defaults only to a ready approved solution document", () => {
  const base = {
    processing_status: "enhanced_ready",
    supporting_subtype: null,
    title: "Dokument",
    file_name: "document.pdf",
  };
  const requirementDocument = {
    ...base,
    id: "requirements",
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: "Kravspesifikasjon",
  };
  const solutionDocument = {
    ...base,
    id: "solution",
    role: "primary_solution_document",
    title: "Arkitektløsning",
    file_name: "solution.pdf",
  };

  const candidates = [requirementDocument, solutionDocument].filter(
    isSolutionEvaluationCandidate,
  );
  assert.deepEqual(candidates.map((document) => document.id), ["solution"]);
});

test("approved pending and failed primary solutions remain visible but are not runnable", () => {
  const base = {
    role: "primary_solution_document",
    supporting_subtype: null,
    title: "Arkitektløsning",
    file_name: "solution.pdf",
  };
  const documents = [
    {
      ...base,
      id: "queued-solution",
      processing_status: "queued",
      processing_message: "Venter på indeksering.",
    },
    {
      ...base,
      id: "processing-solution",
      processing_status: "processing",
      processing_message: "Indekserer dokumentet.",
    },
    {
      ...base,
      id: "failed-solution",
      processing_status: "failed",
      processing_error: "PDF-en kunne ikke leses.",
    },
    {
      ...base,
      id: "ready-solution",
      processing_status: "enhanced_ready",
    },
    {
      ...base,
      id: "requirements",
      role: "supporting_document",
      supporting_subtype: "kravdokument",
      title: "Kravspesifikasjon",
      processing_status: "failed",
    },
  ];

  const visible = selectSolutionEvaluationDocumentCandidates(documents);

  assert.deepEqual(
    visible.map((document) => document.id),
    [
      "queued-solution",
      "processing-solution",
      "failed-solution",
      "ready-solution",
    ],
  );
  assert.deepEqual(
    visible.filter(isSolutionEvaluationCandidate).map((document) => document.id),
    ["ready-solution"],
  );
  assert.equal(
    visible.find((document) => document.id === "failed-solution")
      ?.processing_error,
    "PDF-en kunne ikke leses.",
  );
});

function coverage(overrides = {}) {
  const items = Array.from({ length: 10 }, (_, index) => ({
    reference: `K-${index + 1}`,
  }));
  return {
    total_requirements: 10,
    assessed_requirements: 10,
    good: 10,
    weak: 0,
    missing: 0,
    unclear: 0,
    items,
    ...overrides,
  };
}

test("zero assessed requirements stay at zero and render as incomplete", () => {
  const summary = summarizeRequirementCoverageCounters(
    coverage({ assessed_requirements: 0 }),
  );

  assert.equal(summary.assessed, 0);
  assert.equal(summary.assessedPercent, 0);
  assert.equal(summary.status, "incomplete");
});

test("missing rows make nonzero coverage counters explicitly inconsistent", () => {
  const summary = summarizeRequirementCoverageCounters(
    coverage({
      assessed_requirements: 0,
      good: 0,
      items: [],
    }),
  );

  assert.equal(summary.status, "inconsistent");
  assert.ok(summary.issues.some((issue) => /inneholder 0 kravrader/u.test(issue)));
});

test("category totals that disagree with rows are explicitly inconsistent", () => {
  const summary = summarizeRequirementCoverageCounters(
    coverage({ good: 9, unclear: 0 }),
  );

  assert.equal(summary.status, "inconsistent");
  assert.ok(summary.issues.some((issue) => /summerer til 9/u.test(issue)));
});

test("consistent complete counters remain complete", () => {
  const summary = summarizeRequirementCoverageCounters(coverage());

  assert.deepEqual(
    {
      total: summary.total,
      assessed: summary.assessed,
      assessedPercent: summary.assessedPercent,
      status: summary.status,
      issues: summary.issues,
    },
    {
      total: 10,
      assessed: 10,
      assessedPercent: 100,
      status: "complete",
      issues: [],
    },
  );
});
