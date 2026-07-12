import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  PETORO_GOLDEN_REQUIREMENT_IDS_V1,
  PETORO_GOLDEN_ORACLE_VERSION,
  PETORO_GOLDEN_TEXT_SHA256_V1,
  PETORO_GOLDEN_TEXT_ANCHORS_V1,
  buildRequirementCoverageLedgerFromDocuments,
  buildLocalPetoroCanonicalPreflight,
  compareLedgerWithRequirementOracle,
  normalizeRequirementMeaning,
} from "./run_vurdering_api_full_251.mjs";

const requirementPath =
  process.env.PETORO_REQUIREMENT_PATH ??
  "/Users/sakariaahmed/Downloads/Kravdokument - Bilag 2 - Petoro";
const customerPath =
  process.env.PETORO_CUSTOMER_PATH ??
  "/Users/sakariaahmed/Downloads/Bilag 1 - Petoro";
const missingInputs = [requirementPath, customerPath].filter(
  (filePath) => !existsSync(filePath),
);
const requireLocalInputs = process.env.PETORO_PREFLIGHT_REQUIRED === "1";

test(
  "actual Petoro inputs produce the exact 74-row canonical full-text oracle",
  {
    skip: missingInputs.length && !requireLocalInputs
      ? `Local Petoro preflight inputs are unavailable: ${missingInputs.join(", ")}`
      : false,
  },
  async () => {
    assert.deepEqual(
      missingInputs,
      [],
      `Required local Petoro preflight inputs are unavailable: ${missingInputs.join(", ")}`,
    );
    const result = await buildLocalPetoroCanonicalPreflight({
      requirementPath,
      customerPath,
    });
    const ledger = result.canonicalEvaluationSourceLedger;
    const solutionEvaluationFallbackLedger =
      await buildRequirementCoverageLedgerFromDocuments([
        result.customerDocument,
        result.requirementDocument,
      ]);
    const oracle = {
      version: PETORO_GOLDEN_ORACLE_VERSION,
      orderedIds: PETORO_GOLDEN_REQUIREMENT_IDS_V1,
      orderedTextSha256: PETORO_GOLDEN_TEXT_SHA256_V1,
      textAnchors: PETORO_GOLDEN_TEXT_ANCHORS_V1,
    };
    const comparison = compareLedgerWithRequirementOracle(ledger, oracle);
    const actualIds = ledger.map((entry) => entry.id);
    const actualTextHashes = ledger.map((entry) =>
      createHash("sha256")
        .update(normalizeRequirementMeaning(entry.text))
        .digest("hex"),
    );
    const expectedIdSet = new Set(PETORO_GOLDEN_REQUIREMENT_IDS_V1);
    const diagnostics = JSON.stringify(
      {
        comparison,
        rawLedgerCounts: {
          customer: result.customerSourceLedger.length,
          requirement: result.bilag2SourceLedger.length,
          canonical: ledger.length,
        },
        unexpectedRows: ledger
          .map((entry, index) => ({
            index,
            id: entry.id,
            document: entry.documentTitle,
            excerpt: entry.text.slice(0, 120),
          }))
          .filter((entry) => !expectedIdSet.has(entry.id)),
        firstOrderedMismatches: ledger
          .map((entry, index) => ({
            index,
            expected: PETORO_GOLDEN_REQUIREMENT_IDS_V1[index] ?? null,
            actual: entry.id,
          }))
          .filter((entry) => entry.expected !== entry.actual)
          .slice(0, 12),
      },
      null,
      2,
    );

    assert.equal(result.canonicalRequirementScope.sourceDocuments.length, 2);
    assert.deepEqual(
      result.canonicalRequirementScope.sourceDocuments.map((document) => ({
        id: document.id,
        role: document.role,
        subtype: document.supporting_subtype,
      })),
      [
        {
          id: result.customerDocument.id,
          role: "primary_customer_document",
          subtype: null,
        },
        {
          id: result.requirementDocument.id,
          role: "supporting_document",
          subtype: "kravdokument",
        },
      ],
    );
    assert.equal(ledger.length, 74, diagnostics);
    assert.deepEqual(
      actualIds,
      PETORO_GOLDEN_REQUIREMENT_IDS_V1,
      diagnostics,
    );
    assert.deepEqual(
      actualTextHashes,
      PETORO_GOLDEN_TEXT_SHA256_V1,
      diagnostics,
    );
    assert.deepEqual(
      solutionEvaluationFallbackLedger.map((entry) => entry.id),
      actualIds,
      "solution-evaluation fallback must use the exact canonical requirement identities",
    );
    assert.deepEqual(
      solutionEvaluationFallbackLedger.map((entry) => ({
        id: entry.id,
        text: entry.text,
        heading: entry.heading,
        pages: entry.pages,
        documentId: entry.documentId,
        tableId: entry.tableId ?? null,
        service: entry.service ?? null,
      })),
      ledger.map((entry) => ({
        id: entry.id,
        text: entry.text,
        heading: entry.heading,
        pages: entry.pages,
        documentId: entry.documentId,
        tableId: entry.tableId ?? null,
        service: entry.service ?? null,
      })),
      "solution-evaluation fallback must preserve exact text, headings, pages, and source bindings",
    );
    assert.deepEqual(
      solutionEvaluationFallbackLedger.map((entry) =>
        createHash("sha256")
          .update(normalizeRequirementMeaning(entry.text))
          .digest("hex"),
      ),
      actualTextHashes,
      "solution-evaluation fallback must use the exact canonical full-text ledger",
    );
    const byId = new Map(ledger.map((entry, index) => [entry.id, { entry, index }]));
    const id209 = byId.get("ID 2-09");
    const id214 = byId.get("ID 2-14");
    const id215 = byId.get("ID 2-15");
    const id222 = byId.get("ID 2-22");
    assert.deepEqual(id209?.entry.pages, [8, 9]);
    assert.equal(id214?.index, 26);
    assert.deepEqual(id214?.entry.pages, [15]);
    assert.equal(
      id214?.entry.heading,
      "Leveransekrav til stedlig og fjernbasert Helpdesk og TAM",
    );
    assert.match(id214?.entry.text ?? "", /kl\. 08\.00 og 16\.00/u);
    assert.match(id214?.entry.text ?? "", /Power Automate og Copilot/u);
    assert.match(id214?.entry.text ?? "", /tenant-nivå/u);
    assert.equal(id215?.index, 27);
    assert.deepEqual(id215?.entry.pages, [16]);
    assert.deepEqual(id222?.entry.pages, [19]);
    assert.equal(
      id222?.entry.heading,
      "Innkjøp og håndtering av maskinutstyr",
    );
    assert.doesNotMatch(
      `${id222?.entry.sourceExcerpt ?? ""} ${id222?.entry.answerExcerpt ?? ""}`,
      /Konsulentbistand|timepriser|reisetid|ID2-\s*23/iu,
    );
    assert.deepEqual(comparison, {
      version: PETORO_GOLDEN_ORACLE_VERSION,
      expectedCount: 74,
      actualCount: 74,
      orderedIdsMatch: true,
      orderedTextsMatch: true,
      changedTextRows: [],
      missingOrChangedAnchors: [],
      ok: true,
    });
  },
);
