import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(
  path.join(frontendRoot, "executive-summary-readiness-tests.cjs"),
  {
    interopDefault: true,
    alias: {
      "@": frontendRoot,
      "server-only": "/dev/null",
    },
  },
);

const {
  assertExecutiveSummaryEvaluationReady,
  executiveSummaryReadiness,
} = jiti(
  path.join(frontendRoot, "lib/server/executive-summary-readiness.ts"),
);

function coverage(overrides = {}) {
  const items = Array.from({ length: 10 }, (_, index) => ({
    order_index: index,
    reference: `K-${index + 1}`,
    source_document_id: "requirements-document",
    assessment: "Godt",
    rationale: "Svarteksten dekker kravet med en konkret og etterprøvbar kontroll.",
    evidence: "Løsningen dokumenterer ansvar, kontrollpunkt og akseptanse.",
    recommendation: "Bevar den konkrete kontrollen i endelig tilbud.",
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

function executiveSummaryEvaluation(coverageOverrides = {}) {
  return {
    executive_summary: "Løsningen gir et tydelig beslutningsgrunnlag.",
    fit_to_customer_needs: "Løsningen dekker kundens dokumenterte hovedbehov.",
    likely_score_assessment: {
      quality: "God kvalitet med sporbare svar.",
      delivery_confidence: "Gjennomførbar leveranse med tydelig ansvar.",
      risk: "Håndterbar risiko med åpne tiltak.",
      competitiveness: "Konkurransedyktig når dokumenterte gap lukkes.",
    },
    requirement_coverage: coverage(coverageOverrides),
  };
}

test("executive summary is unavailable when evaluation coverage is missing", () => {
  const evaluation = executiveSummaryEvaluation();
  delete evaluation.requirement_coverage;

  const readiness = executiveSummaryReadiness(evaluation);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "missing_coverage");
  assert.match(readiness.message, /mangler kravdekning/u);
});

test("executive summary is unavailable when evaluation coverage is incomplete", () => {
  const evaluation = executiveSummaryEvaluation({ assessed_requirements: 7 });
  const readiness = executiveSummaryReadiness(evaluation);

  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "incomplete");
  assert.match(readiness.message, /bare 7 av 10 krav er vurdert/u);
  assert.throws(
    () => assertExecutiveSummaryEvaluationReady(evaluation),
    /Lederoppsummeringen er utilgjengelig/u,
  );
});

test("executive summary is unavailable when evaluation counters are inconsistent", () => {
  const readiness = executiveSummaryReadiness(
    executiveSummaryEvaluation({ good: 9 }),
  );

  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "inconsistent");
  assert.match(readiness.message, /summerer til 9/u);
});

test("executive summary is unavailable for duplicate or malformed coverage rows", () => {
  const duplicate = executiveSummaryEvaluation();
  duplicate.requirement_coverage.items[1] = {
    ...duplicate.requirement_coverage.items[1],
    reference: "K-1",
  };
  const duplicateReadiness = executiveSummaryReadiness(duplicate);
  assert.equal(duplicateReadiness.ready, false);
  assert.equal(duplicateReadiness.reason, "inconsistent");
  assert.match(duplicateReadiness.message, /forekommer flere ganger/u);

  const invalidAssessment = executiveSummaryEvaluation();
  invalidAssessment.requirement_coverage.items[0] = {
    ...invalidAssessment.requirement_coverage.items[0],
    assessment: "OK",
  };
  const invalidReadiness = executiveSummaryReadiness(invalidAssessment);
  assert.equal(invalidReadiness.ready, false);
  assert.equal(invalidReadiness.reason, "inconsistent");
  assert.match(invalidReadiness.message, /ugyldig assessment=OK/u);
});

test("executive summary accepts a complete and substantive evaluation", () => {
  const evaluation = executiveSummaryEvaluation();

  assert.deepEqual(executiveSummaryReadiness(evaluation), {
    ready: true,
    reason: "ready",
    message: "",
  });
  assert.doesNotThrow(() => assertExecutiveSummaryEvaluationReady(evaluation));
});
