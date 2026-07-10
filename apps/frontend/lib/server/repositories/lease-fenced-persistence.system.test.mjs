import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "lease-fencing-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  runLeaseFencedProjectMutation,
} = jiti(
  path.join(
    frontendRoot,
    "lib/server/repositories/lease-fenced-persistence.ts",
  ),
);
const { insertFollowUpProjectJob } = jiti(
  path.join(frontendRoot, "lib/server/repositories/jobs.ts"),
);
const { runWithProjectWorkflowContext } = jiti(
  path.join(frontendRoot, "lib/server/project-workflow-cancellation.ts"),
);

const projectId = "00000000-0000-4000-8000-000000000001";
const parentJobId = "00000000-0000-4000-8000-000000000010";
const oldLease = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const currentLease = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function leaseContext(leaseToken) {
  return {
    signal: new AbortController().signal,
    lease: {
      jobId: parentJobId,
      leaseToken,
      projectId,
    },
  };
}

function queuedRecord(id) {
  return {
    id,
    project_id: projectId,
    kind: "document_docling_enhancement",
    status: "queued",
    message: "Køer Docling-forbedring ...",
    error: null,
    result: null,
    created_at: "2026-07-10T12:00:00.000Z",
    updated_at: "2026-07-10T12:00:00.000Z",
  };
}

function authoritativeDatabase() {
  const jobs = new Map([
    [
      parentJobId,
      {
        ...queuedRecord(parentJobId),
        kind: "document_ingestion",
        status: "running",
        lease_token: oldLease,
        input_json: { kind: "document_ingestion", projectId },
        result_json: null,
        locked_at: "2026-07-10T12:00:00.000Z",
        started_at: "2026-07-10T12:00:00.000Z",
        completed_at: null,
        parent_job_id: null,
        idempotency_key: null,
      },
    ],
  ]);
  const business = {
    documents: [],
    document_chunks: [],
    customer_analyses: [],
    solution_evaluations: [],
    executive_summaries: [],
    generated_artifacts: [],
    projects: [],
  };

  function ownsLease(jobId, leaseToken, scopedProjectId) {
    const row = jobs.get(jobId);
    return (
      row?.status === "running" &&
      row.lease_token === leaseToken &&
      row.project_id === scopedProjectId
    );
  }

  return {
    jobs,
    business,
    takeover() {
      const row = jobs.get(parentJobId);
      row.lease_token = currentLease;
      row.locked_at = "2026-07-10T12:02:00.000Z";
    },
    async rpc(name, args) {
      if (name === "lease_fenced_project_write") {
        if (!ownsLease(args.p_job_id, args.p_lease_token, args.p_project_id)) {
          return {
            data: null,
            error: {
              message:
                "PROJECT_JOB_LEASE_LOST: parent project job lease is no longer authoritative",
            },
          };
        }
        const tableByOperation = {
          document_ingestion_result: "documents",
          document_processing_state: "documents",
          replace_document_chunks: "document_chunks",
          customer_analysis: "customer_analyses",
          solution_evaluation: "solution_evaluations",
          executive_summary: "executive_summaries",
          generated_artifact: "generated_artifacts",
          project_metadata: "projects",
          project_context_keywords: "projects",
        };
        const table = tableByOperation[args.p_operation];
        assert.ok(table, `unexpected operation ${args.p_operation}`);
        business[table].push({
          project_id: args.p_project_id,
          operation: args.p_operation,
          payload: structuredClone(args.p_payload),
        });
        return { data: business[table].at(-1), error: null };
      }

      assert.equal(name, "lease_fenced_enqueue_project_job");
      if (
        !ownsLease(
          args.p_parent_job_id,
          args.p_parent_lease_token,
          args.p_project_id,
        )
      ) {
        return {
          data: null,
          error: {
            message:
              "PROJECT_JOB_LEASE_LOST: parent project job lease is no longer authoritative",
          },
        };
      }

      const existing = [...jobs.values()].find(
        (row) =>
          row.parent_job_id === args.p_parent_job_id &&
          row.idempotency_key === args.p_idempotency_key,
      );
      if (existing) {
        return { data: existing, error: null };
      }

      const row = {
        id: args.p_job.id,
        project_id: args.p_project_id,
        kind: args.p_job.kind,
        status: "queued",
        message: args.p_job.message,
        error: null,
        input_json: args.p_job.input_json,
        result_json: null,
        created_at: args.p_job.created_at,
        updated_at: args.p_job.updated_at,
        locked_at: null,
        lease_token: null,
        started_at: null,
        completed_at: null,
        parent_job_id: args.p_parent_job_id,
        idempotency_key: args.p_idempotency_key,
      };
      jobs.set(row.id, row);
      return { data: row, error: null };
    },
  };
}

test("takeover fences stale business writes without pre-aborting the old worker", async () => {
  const database = authoritativeDatabase();
  const staleContext = leaseContext(oldLease);
  assert.equal(staleContext.signal.aborted, false);

  database.takeover();

  const operations = [
    "document_ingestion_result",
    "document_processing_state",
    "replace_document_chunks",
    "customer_analysis",
    "solution_evaluation",
    "executive_summary",
    "generated_artifact",
    "project_metadata",
    "project_context_keywords",
  ];
  for (const operation of operations) {
    await assert.rejects(
      runWithProjectWorkflowContext(staleContext, () =>
        runLeaseFencedProjectMutation(
          projectId,
          operation,
          { marker: operation },
          { client: database },
        ),
      ),
      { name: "ProjectJobLeaseLostError" },
    );
  }

  assert.equal(staleContext.signal.aborted, false);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(database.business).map(([table, rows]) => [
        table,
        rows.length,
      ]),
    ),
    {
      documents: 0,
      document_chunks: 0,
      customer_analyses: 0,
      solution_evaluations: 0,
      executive_summaries: 0,
      generated_artifacts: 0,
      projects: 0,
    },
  );

  for (const operation of operations) {
    await runWithProjectWorkflowContext(leaseContext(currentLease), () =>
      runLeaseFencedProjectMutation(
        projectId,
        operation,
        { marker: operation },
        { client: database },
      ),
    );
  }
  assert.equal(
    Object.values(database.business).reduce((total, rows) => total + rows.length, 0),
    operations.length,
  );
});

test("takeover fences stale follow-ups and current retries enqueue exactly once", async () => {
  const database = authoritativeDatabase();
  database.takeover();
  const jobCountAfterTakeover = database.jobs.size;

  await assert.rejects(
    insertFollowUpProjectJob(
      queuedRecord("00000000-0000-4000-8000-000000000020"),
      { kind: "document_docling_enhancement", projectId },
      leaseContext(oldLease).lease,
      "document_docling_enhancement:document-1",
      { client: database },
    ),
    { name: "ProjectJobLeaseLostError" },
  );
  assert.equal(database.jobs.size, jobCountAfterTakeover);

  const first = await insertFollowUpProjectJob(
    queuedRecord("00000000-0000-4000-8000-000000000021"),
    { kind: "document_docling_enhancement", projectId },
    leaseContext(currentLease).lease,
    "document_docling_enhancement:document-1",
    { client: database },
  );
  const retry = await insertFollowUpProjectJob(
    queuedRecord("00000000-0000-4000-8000-000000000022"),
    { kind: "document_docling_enhancement", projectId },
    leaseContext(currentLease).lease,
    "document_docling_enhancement:document-1",
    { client: database },
  );

  assert.equal(first.id, retry.id);
  assert.equal(database.jobs.size, jobCountAfterTakeover + 1);
  assert.equal(
    [...database.jobs.values()].filter(
      (row) => row.parent_job_id === parentJobId,
    ).length,
    1,
  );
});
