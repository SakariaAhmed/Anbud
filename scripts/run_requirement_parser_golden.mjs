#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import jitiModule from "../apps/frontend/node_modules/jiti/lib/jiti.cjs";

const frontendRoot = fileURLToPath(new URL("../apps/frontend/", import.meta.url));
const fixturePath = fileURLToPath(
  new URL(
    "../test-data/requirement-parser-golden/norwegian-pdf-requirement-regressions.json",
    import.meta.url,
  ),
);

const { createJiti } = jitiModule;
const jiti = createJiti(
  fileURLToPath(import.meta.url),
  {
    moduleCache: false,
    interopDefault: true,
    alias: {
      "@": frontendRoot,
      "server-only": "/dev/null",
    },
  },
);

const {
  normalizePdfReferenceTypography,
} = jiti(
  fileURLToPath(
    new URL("../apps/frontend/lib/server/requirements/pdf-normalization.ts", import.meta.url),
  ),
);
const {
  cleanTableRequirement,
  cleanTableService,
  repairTableRowTextArtifacts,
} = jiti(
  fileURLToPath(
    new URL("../apps/frontend/lib/server/requirements/pdf-table-repairs.ts", import.meta.url),
  ),
);
const {
  assertRequirementLedgerQualityForEvaluation,
} = jiti(
  fileURLToPath(
    new URL("../apps/frontend/lib/server/requirements/ledger-quality.ts", import.meta.url),
  ),
);
const {
  extractRequirementLedgerForDocument,
} = jiti(
  fileURLToPath(new URL("../apps/frontend/lib/server/ai.ts", import.meta.url)),
);
const {
  requirementDisplayRef,
  requirementSubtitle,
} = jiti(
  fileURLToPath(
    new URL("../apps/frontend/lib/server/requirements/presentation.ts", import.meta.url),
  ),
);

function ledgerEntry(entry) {
  return {
    id: entry.id,
    text: entry.text,
    pages: [1],
    heading: entry.heading ?? "",
    tableId: entry.tableId ?? "",
    service: entry.service ?? "",
  };
}

function normalizeWith(functionName, input) {
  switch (functionName) {
    case "normalizePdfReferenceTypography":
      return normalizePdfReferenceTypography(input);
    case "cleanTableService":
      return cleanTableService(input);
    case "cleanTableRequirement":
      return cleanTableRequirement(input);
    default:
      throw new Error(`Ukjent normaliseringsfunksjon i golden fixture: ${functionName}`);
  }
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

for (const testCase of fixture.normalization ?? []) {
  assert.equal(
    normalizeWith(testCase.function, testCase.input),
    testCase.expected,
    testCase.name,
  );
}

for (const testCase of fixture.tableRepairs ?? []) {
  const repaired = repairTableRowTextArtifacts({
    service: testCase.service,
    text: testCase.text,
  });
  assert.deepEqual(
    repaired,
    {
      service: testCase.expectedService,
      text: testCase.expectedText,
    },
    testCase.name,
  );
}

for (const testCase of fixture.qualityGate?.pass ?? []) {
  assert.doesNotThrow(
    () =>
      assertRequirementLedgerQualityForEvaluation([ledgerEntry(testCase.entry)], {
        stage: "golden-pass",
        documentTitle: testCase.name,
      }),
    testCase.name,
  );
}

for (const testCase of fixture.qualityGate?.fail ?? []) {
  let message = "";
  assert.throws(
    () =>
      assertRequirementLedgerQualityForEvaluation([ledgerEntry(testCase.entry)], {
        stage: "golden-fail",
        documentTitle: testCase.name,
      }),
    (error) => {
      message = error instanceof Error ? error.message : String(error);
      return /Kravledgeren inneholder kjente PDF-ekstraksjonsfeil/.test(message);
    },
    testCase.name,
  );
  assert.ok(message.includes(testCase.expectedCode), testCase.name);
}

for (const testCase of fixture.ledgerExtraction ?? []) {
  const document = {
    id: `golden-${testCase.name}`,
    title: testCase.documentTitle ?? testCase.name,
    file_name: `${testCase.name}.pdf`,
    file_format: "pdf",
    file_size: Buffer.byteLength(testCase.rawText, "utf8"),
    file_path: "",
    raw_text: testCase.rawText,
    chunks: [],
    structure_map: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const ledger = await extractRequirementLedgerForDocument(document);
  const displays = ledger.map((entry) =>
    requirementDisplayRef(entry, requirementSubtitle(entry) || ""),
  );

  for (const expected of testCase.expectedEntries ?? []) {
    const entry = ledger.find((item) => item.id === expected.id);
    assert.ok(entry, `${testCase.name}: missing ${expected.id}`);

    const display = requirementDisplayRef(entry, requirementSubtitle(entry) || "");
    if (expected.display) {
      assert.equal(display, expected.display, `${testCase.name}: ${expected.id} display`);
    }

    for (const text of expected.textIncludes ?? []) {
      assert.ok(
        entry.text.includes(text),
        `${testCase.name}: ${expected.id} text should include ${text}`,
      );
    }

    for (const text of expected.displayExcludes ?? []) {
      assert.ok(
        !display.includes(text),
        `${testCase.name}: ${expected.id} display should not include ${text}`,
      );
    }
  }

  for (const forbidden of testCase.forbiddenDisplays ?? []) {
    assert.ok(
      displays.every((display) => !display.includes(forbidden)),
      `${testCase.name}: forbidden display fragment ${forbidden}`,
    );
  }
}

console.log(
  JSON.stringify(
    {
      normalization: fixture.normalization?.length ?? 0,
      tableRepairs: fixture.tableRepairs?.length ?? 0,
      qualityPass: fixture.qualityGate?.pass?.length ?? 0,
      qualityFail: fixture.qualityGate?.fail?.length ?? 0,
      ledgerExtraction: fixture.ledgerExtraction?.length ?? 0,
    },
    null,
    2,
  ),
);
