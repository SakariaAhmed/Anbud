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

const { validateGeneratedArtifact } = jiti(
  path.join(frontendRoot, "lib/server/artifact-validation.ts"),
);

const baseInput = {
  artifactType: "forbedret_kravsvar",
  title: "Kravbesvarelse",
  expectedRequirementCount: 1,
  expectedRequirementRefs: ["K-001"],
  unresolvedFallbackAnswers: 0,
};

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
