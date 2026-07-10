import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

const jiti = createJiti(path.join(frontendRoot, "evaluation-coverage-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const { analyzeRequirementCoverageIntegrity } = jiti(
  path.join(
    frontendRoot,
    "lib/server/requirements/evaluation-coverage-integrity.ts",
  ),
);

function sourceLedger() {
  return [
    {
      id: "K-1",
      tableId: "Tabell ID 1-1",
      service: "Logging",
      text: "Leverandøren skal levere sentral logging med revisjonsspor.",
      pages: [1],
      heading: "Sikkerhet",
    },
    {
      id: "K-2",
      tableId: "Tabell ID 1-2",
      service: "Backup",
      text: "Leverandøren skal dokumentere backup og gjenoppretting.",
      pages: [2],
      heading: "Drift",
    },
  ];
}

function coverageItem(index, overrides = {}) {
  const ledger = sourceLedger();
  const entry = ledger[index];
  return {
    order_index: index,
    reference: entry.tableId,
    full_reference: `Bilag 2, ${entry.heading}, ${entry.tableId}, ${entry.id}`,
    source_reference: `Bilag 2, ${entry.tableId}, ${entry.id}`,
    table_id: entry.tableId,
    requirement: entry.text,
    assessment: index === 0 ? "Godt" : "Mangler",
    rationale: "Konkret vurdering.",
    evidence: "Konkret bevis.",
    recommendation: "Konkret anbefaling.",
    answer_document_id: index === 0 ? "answer-doc" : null,
    answer_document_title: index === 0 ? "Svar" : null,
    ...overrides,
  };
}

function validCoverage(overrides = {}) {
  return {
    total_requirements: 2,
    assessed_requirements: 2,
    good: 1,
    weak: 0,
    missing: 1,
    unclear: 0,
    items: [coverageItem(0), coverageItem(1)],
    ...overrides,
  };
}

test("complete coverage passes integrity checks", () => {
  const report = analyzeRequirementCoverageIntegrity({
    sourceLedger: sourceLedger(),
    coverage: validCoverage(),
  });

  assert.equal(report.ok, true);
  assert.equal(report.issueCount, 0);
});

test("truncated long requirement with ascii ellipsis still matches source", () => {
  const longText = [
    "Leverandøren skal sikre at ekstern tilgang, fjernadministrasjon og administrative tilganger er teknisk og organisatorisk sikret.",
    "Løsningen skal dokumentere nettverkssegmentering, autentiseringsmekanismer, logging og periodisk revisjon av rettigheter.",
    "Kundens data skal ikke eksponeres for uautorisert innsyn eller behandling.",
  ].join(" ");
  const ledger = [
    {
      id: "K-1",
      tableId: "Tabell ID 2-30",
      service: "Sikker tilgang",
      text: longText,
      pages: [41],
      heading: "Informasjons- og IT sikkerhet",
    },
  ];
  const report = analyzeRequirementCoverageIntegrity({
    sourceLedger: ledger,
    coverage: {
      total_requirements: 1,
      assessed_requirements: 1,
      good: 1,
      weak: 0,
      missing: 0,
      unclear: 0,
      items: [
        {
          order_index: 0,
          reference: "Tabell ID 2-30",
          full_reference: "Bilag 2, Informasjons- og IT sikkerhet, Tabell ID 2-30, K-1",
          source_reference: "Bilag 2, Tabell ID 2-30, K-1",
          table_id: "Tabell ID 2-30",
          requirement: `${longText.slice(0, 96)}...`,
          assessment: "Godt",
          rationale: "Konkret vurdering.",
          evidence: "Konkret bevis.",
          recommendation: "Konkret anbefaling.",
          answer_document_id: "answer-doc",
          answer_document_title: "Svar",
        },
      ],
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.issueCount, 0);
});

test("missing and extra coverage rows fail count checks", () => {
  const report = analyzeRequirementCoverageIntegrity({
    sourceLedger: sourceLedger(),
    coverage: validCoverage({
      total_requirements: 1,
      assessed_requirements: 1,
      items: [coverageItem(0)],
    }),
  });

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.issues.map((issue) => issue.code).filter((code) => code.endsWith("mismatch")),
    [
      "total_mismatch",
      "assessed_mismatch",
      "item_count_mismatch",
      "assessment_count_mismatch",
    ],
  );
});

test("invented references and requirement text are detected", () => {
  const report = analyzeRequirementCoverageIntegrity({
    sourceLedger: sourceLedger(),
    coverage: validCoverage({
      items: [
        coverageItem(0),
        coverageItem(1, {
          reference: "X-999",
          full_reference: "Oppfunnet krav",
          source_reference: "Oppfunnet krav",
          table_id: "X-999",
          requirement: "Leverandøren skal levere noe helt annet.",
        }),
      ],
    }),
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === "invented_reference"));
  assert.ok(
    report.issues.some((issue) => issue.code === "requirement_text_mismatch"),
  );
});

test("duplicate and shuffled order indexes fail", () => {
  const report = analyzeRequirementCoverageIntegrity({
    sourceLedger: sourceLedger(),
    coverage: validCoverage({
      items: [coverageItem(0, { order_index: 1 }), coverageItem(1, { order_index: 1 })],
    }),
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === "order_index_mismatch"));
  assert.ok(report.issues.some((issue) => issue.code === "duplicate_order_index"));
});

test("matched answers cannot remain Mangler", () => {
  const report = analyzeRequirementCoverageIntegrity({
    sourceLedger: sourceLedger(),
    coverage: validCoverage({
      good: 0,
      missing: 2,
      items: [coverageItem(0, { assessment: "Mangler" }), coverageItem(1)],
    }),
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.issues.some((issue) => issue.code === "missing_with_matched_answer"),
  );
});
