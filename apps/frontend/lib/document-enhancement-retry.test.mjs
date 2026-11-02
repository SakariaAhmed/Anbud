import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const load = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname } });
const { canRetryDocumentEnhancement, documentEnhancementRetryDecision, DOCUMENT_ENHANCEMENT_FAILURE_ERROR } = load("./document-processing.ts");
const failed = { processing_status: "basic_ready", parser_used: "pdf-parse", processing_error: DOCUMENT_ENHANCEMENT_FAILURE_ERROR, chunk_source_revision: 4 };

test("only a usable basic version with a recorded enhancement failure can be retried", () => {
  assert.equal(canRetryDocumentEnhancement(failed), true);
  for (const document of [
    { ...failed, processing_error: null }, { ...failed, processing_error: "  " },
    { ...failed, parser_used: "docling" }, { ...failed, processing_status: "enhanced_ready" },
    { ...failed, processing_status: "failed" }, { ...failed, processing_status: "processing" },
  ]) assert.equal(canRetryDocumentEnhancement(document), false);
});

test("a retry states the revision it saw and cannot act on a newer version", () => {
  assert.equal(documentEnhancementRetryDecision(failed, 4), "allowed");
  for (const revision of [3, 5, "4", null, undefined, 4.5]) assert.equal(documentEnhancementRetryDecision(failed, revision), "stale");
  assert.equal(documentEnhancementRetryDecision({ ...failed, processing_error: null }, 4), "not_eligible");
});
