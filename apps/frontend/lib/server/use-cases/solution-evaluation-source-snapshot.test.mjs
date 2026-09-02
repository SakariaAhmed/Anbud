import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const jiti = createJiti(
  path.join(frontendRoot, "solution-evaluation-source-snapshot-tests.cjs"),
  { alias: { "@": frontendRoot }, interopDefault: true },
);
const {
  isProjectSourceRevisionChangedError,
  readStableProjectSourceSnapshot,
  readStableSolutionEvaluationSourceSnapshot,
  runWithProjectSourceRevisionRetry,
} = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/use-cases/solution-evaluation-source-snapshot.ts",
  ),
);

test("customer analysis retries against the latest snapshot when ingestion metadata changes", async () => {
  let sourceRevision = 11;
  let attempts = 0;
  const retriedRevisions = [];

  const result = await runWithProjectSourceRevisionRetry({
    onRetry: () => retriedRevisions.push(sourceRevision),
    run: async () => {
      attempts += 1;
      const capturedRevision = sourceRevision;

      if (attempts === 1) {
        sourceRevision += 1;
      }

      if (capturedRevision !== sourceRevision) {
        throw new Error(
          "PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the analysis was running",
        );
      }

      return { savedRevision: capturedRevision };
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(retriedRevisions, [12]);
  assert.deepEqual(result, { savedRevision: 12 });
});

test("source revision retry only handles the known optimistic-concurrency conflict", async () => {
  assert.equal(
    isProjectSourceRevisionChangedError(
      new Error(
        "PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the analysis was running",
      ),
    ),
    true,
  );
  await assert.rejects(
    runWithProjectSourceRevisionRetry({
      run: async () => {
        throw new Error("OpenAI is unavailable");
      },
    }),
    /OpenAI is unavailable/u,
  );
});

test("service candidates are retried inside the same source-revision snapshot", async () => {
  let revision = 4;
  let mutateDuringFirstServiceRead = true;

  const snapshot = await readStableProjectSourceSnapshot({
    readSourceRevision: async () => revision,
    readValue: async () => {
      const documents = [`documents-r${revision}`];
      const serviceCandidates = [`services-r${revision}`];
      if (mutateDuringFirstServiceRead) {
        mutateDuringFirstServiceRead = false;
        revision += 1;
      }
      return { documents, serviceCandidates };
    },
  });

  assert.equal(snapshot.sourceRevision, 5);
  assert.deepEqual(snapshot.value, {
    documents: ["documents-r5"],
    serviceCandidates: ["services-r5"],
  });
});

test("a source change between parallel reads retries and returns one stable revision", async () => {
  let revision = 7;
  let mutateDuringFirstRead = true;

  const snapshot = await readStableSolutionEvaluationSourceSnapshot({
    readSourceRevision: async () => revision,
    readDocuments: async () => {
      const documents = [`documents-r${revision}`];
      if (mutateDuringFirstRead) {
        mutateDuringFirstRead = false;
        revision += 1;
      }
      return documents;
    },
    readCustomerAnalysis: async () => `analysis-r${revision}`,
  });

  assert.equal(snapshot.sourceRevision, 8);
  assert.deepEqual(snapshot.documents, ["documents-r8"]);
  assert.equal(snapshot.customerAnalysis, "analysis-r8");
});

test("continuously changing inputs fail closed instead of returning a mixed snapshot", async () => {
  let revision = 1;

  await assert.rejects(
    readStableSolutionEvaluationSourceSnapshot({
      readSourceRevision: async () => revision,
      readDocuments: async () => {
        revision += 1;
        return [];
      },
      readCustomerAnalysis: async () => null,
      maxAttempts: 2,
    }),
    /endret under innlesing/u,
  );
});
