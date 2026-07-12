import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "./supabase-store.persistence.system-cases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const repositoryRoot = path.resolve(frontendRoot, "../..");
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
  runLeaseFencedCustomerAnalysisMutation,
  runLeaseFencedGeneratedArtifactMutation,
  runLeaseFencedProjectMutation,
  runLeaseFencedSolutionEvaluationMutation,
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
const olderEvaluationJobId = "00000000-0000-4000-8000-000000000030";
const newerEvaluationJobId = "00000000-0000-4000-8000-000000000031";
const oldLease = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const currentLease = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const olderEvaluationLease = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const newerEvaluationLease = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const customerDocumentId = "00000000-0000-4000-8000-000000000040";
const solutionDocumentId = "00000000-0000-4000-8000-000000000041";
const artifactMigrationSql = readFileSync(
  path.join(
    repositoryRoot,
    "supabase/migrations/20260711130000_generated_artifact_source_revision_fence.sql",
  ),
  "utf8",
);
const canonicalSchemaSql = readFileSync(
  path.join(repositoryRoot, "supabase/schema.sql"),
  "utf8",
);
const durableExecutionSql = readFileSync(
  path.join(repositoryRoot, "supabase/project_jobs_durable_execution.sql"),
  "utf8",
);

function sqlFunctionDefinition(sql, name) {
  return [
    ...sql.matchAll(
      new RegExp(
        `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
        "gu",
      ),
    ),
  ].at(-1)?.[0];
}

function sqlFunctionBody(sql, name) {
  return sqlFunctionDefinition(sql, name)?.match(
    /as \$\$(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
}

const parentFirstLeaseFunctions = [
  "lease_fenced_save_customer_analysis",
  "lease_fenced_save_solution_evaluation",
  "lease_fenced_save_executive_summary",
  "lease_fenced_save_generated_artifact",
  "lease_fenced_enqueue_project_job",
];

test("every dedicated lease RPC locks the project parent before the job child", () => {
  for (const [label, sql] of [
    ["1300 migration", artifactMigrationSql],
    ["canonical schema", canonicalSchemaSql],
    ["durable execution", durableExecutionSql],
  ]) {
    for (const functionName of parentFirstLeaseFunctions) {
      const body = sqlFunctionBody(sql, functionName);
      assert.ok(body, `${label} mangler ${functionName}`);
      const projectLock = body.indexOf("from public.projects");
      const jobLock = body.indexOf("from public.project_jobs");
      assert.ok(projectLock >= 0, `${label}/${functionName} mangler project-lås`);
      assert.ok(jobLock >= 0, `${label}/${functionName} mangler job-lås`);
      assert.ok(
        projectLock < jobLock,
        `${label}/${functionName} låser child før parent`,
      );
      assert.match(
        body.slice(projectLock, jobLock),
        /for update/u,
        `${label}/${functionName} må holde parent gjennom job-valideringen`,
      );
    }
  }
});

function runPsql(databaseUrl, sql) {
  return spawnSync(
    "psql",
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    { encoding: "utf8" },
  );
}

function runPsqlAsync(databaseUrl, sql) {
  return new Promise((resolve) => {
    const child = spawn(
      "psql",
      [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function assertPsqlSucceeded(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed:\n${result.stderr || result.stdout}`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const lockOrderDatabaseUrl =
  process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL ??
  process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL ??
  process.env.DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL;

test(
  "postgres: all dedicated lease RPCs avoid project DELETE cascade deadlocks",
  { skip: !lockOrderDatabaseUrl, timeout: 30_000 },
  async () => {
    const databaseName = `anbud_lease_lock_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = new URL(lockOrderDatabaseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const quotedDatabaseName = `"${databaseName}"`;
    assertPsqlSucceeded(
      runPsql(lockOrderDatabaseUrl, `create database ${quotedDatabaseName}`),
      "create lease lock-order database",
    );

    try {
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            create schema extensions;
            create table public.projects (
              id uuid primary key,
              source_revision bigint not null default 0,
              artifact_source_revision bigint not null default 0,
              solution_evaluation_generated boolean not null default false,
              last_activity_at timestamptz not null default now()
            );
            create table public.project_jobs (
              id uuid primary key,
              project_id uuid not null references public.projects(id) on delete cascade,
              kind text not null,
              status text not null,
              message text not null default '',
              error text,
              input_json jsonb,
              result_json jsonb,
              locked_at timestamptz,
              lease_token uuid,
              started_at timestamptz,
              completed_at timestamptz,
              parent_job_id uuid references public.project_jobs(id) on delete cascade,
              idempotency_key text,
              submission_sequence bigint generated always as identity,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now(),
              unique (parent_job_id, idempotency_key)
            );
            create table public.solution_evaluations (id uuid);
            create table public.executive_summaries (id uuid);
            create table public.generated_artifacts (id uuid);
          `,
        ),
        "create lease lock-order fixture",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          parentFirstLeaseFunctions
            .map((name) => sqlFunctionDefinition(artifactMigrationSql, name))
            .join("\n"),
        ),
        "install dedicated lease RPC definitions",
      );

      const scenarios = parentFirstLeaseFunctions.map((functionName, index) => {
        const suffix = String(index + 1).padStart(2, "0");
        return {
          functionName,
          projectId: `00000000-0000-4000-8000-0000000001${suffix}`,
          jobId: `00000000-0000-4000-8000-0000000002${suffix}`,
          leaseToken: `${suffix.repeat(4)}-${suffix.repeat(2)}-4${suffix.slice(1).repeat(3)}-8${suffix.slice(1).repeat(3)}-${suffix.repeat(6)}`,
          childJobId: `00000000-0000-4000-8000-0000000003${suffix}`,
        };
      });
      for (const scenario of scenarios) {
        assertPsqlSucceeded(
          runPsql(
            databaseUrl.toString(),
            `insert into public.projects(id) values ('${scenario.projectId}');
             insert into public.project_jobs(id, project_id, kind, status, lease_token)
             values ('${scenario.jobId}', '${scenario.projectId}', 'invalid_kind', 'running', '${scenario.leaseToken}');`,
          ),
          `seed ${scenario.functionName}`,
        );

        const blocker = runPsqlAsync(
          databaseUrl.toString(),
          `begin;
           set local statement_timeout = '5s';
           select id from public.project_jobs where id = '${scenario.jobId}' for update;
           select pg_sleep(0.45);
           commit;`,
        );
        await delay(75);

        const call =
          scenario.functionName === "lease_fenced_enqueue_project_job"
            ? `select public.lease_fenced_enqueue_project_job(
                 '${scenario.jobId}', '${scenario.leaseToken}', '${scenario.projectId}',
                 '${JSON.stringify({
                   id: scenario.childJobId,
                   kind: "document_docling_enhancement",
                   message: "queued",
                   input_json: {},
                   created_at: "2026-07-11T08:00:00.000Z",
                   updated_at: "2026-07-11T08:00:00.000Z",
                 })}'::jsonb,
                 'lock-order-regression'
               );`
            : `do $body$
                 begin
                   perform public.${scenario.functionName}(
                     '${scenario.jobId}', '${scenario.leaseToken}',
                     '${scenario.projectId}', '{}'::jsonb
                   );
                   raise exception 'EXPECTED_LEASE_RPC_REJECTION_MISSING';
                 exception when others then
                   if sqlstate = '40P01' or sqlerrm ~* 'deadlock' then raise; end if;
                   if sqlerrm = 'EXPECTED_LEASE_RPC_REJECTION_MISSING' then raise; end if;
                 end
               $body$;`;
        const writer = runPsqlAsync(
          databaseUrl.toString(),
          `set deadlock_timeout = '100ms'; set statement_timeout = '5s'; ${call}`,
        );
        await delay(75);
        const deletingProject = runPsqlAsync(
          databaseUrl.toString(),
          `set deadlock_timeout = '100ms'; set statement_timeout = '5s';
           delete from public.projects where id = '${scenario.projectId}';`,
        );

        assertPsqlSucceeded(await blocker, `${scenario.functionName} job blocker`);
        assertPsqlSucceeded(await writer, `${scenario.functionName} writer`);
        assertPsqlSucceeded(
          await deletingProject,
          `${scenario.functionName} project DELETE`,
        );
      }

      const remaining = runPsql(
        databaseUrl.toString(),
        "select (select count(*) from public.projects) || ':' || (select count(*) from public.project_jobs);",
      );
      assertPsqlSucceeded(remaining, "read post-concurrency rows");
      assert.equal(remaining.stdout.trim(), "0:0");
    } finally {
      assertPsqlSucceeded(
        runPsql(
          lockOrderDatabaseUrl,
          `drop database if exists ${quotedDatabaseName} with (force)`,
        ),
        "drop lease lock-order database",
      );
    }
  },
);

function leaseContext(leaseToken, jobId = parentJobId) {
  return {
    signal: new AbortController().signal,
    lease: {
      jobId,
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

function evaluationPayload(marker) {
  return {
    customer_document_id: customerDocumentId,
    solution_document_id: solutionDocumentId,
    analysis_id: null,
    source_document_ids: [customerDocumentId, solutionDocumentId],
    expected_source_revision: 0,
    result_json: { marker },
    last_activity_at: "2026-07-10T12:03:00.000Z",
  };
}

function customerAnalysisPayload(marker, expectedSourceRevision = 0) {
  return {
    source_document_ids: [customerDocumentId],
    expected_source_revision: expectedSourceRevision,
    result_json: { marker },
    context_keywords: ["kunde", marker],
    last_activity_at: "2026-07-10T12:03:00.000Z",
  };
}

test("customer-analysis SQL writes atomically invalidate downstream outputs", () => {
  for (const relativePath of [
    "supabase/project_jobs_durable_execution.sql",
    "supabase/schema.sql",
  ]) {
    const sql = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    const customerAnalysisBranch = sql.match(
      /elsif p_operation = 'customer_analysis' then(?<branch>[\s\S]*?)elsif p_operation = 'solution_evaluation' then/u,
    )?.groups?.branch;
    assert.ok(customerAnalysisBranch, `${relativePath} mangler customer_analysis-gren`);
    assert.match(customerAnalysisBranch, /DEDICATED_FENCE_REQUIRED: customer_analysis/u);
    assert.doesNotMatch(customerAnalysisBranch, /insert into public\.customer_analyses/u);
  }

  const migration = readFileSync(
    path.join(
      repositoryRoot,
      "supabase/migrations/20260711121500_customer_analysis_invalidates_derived_outputs.sql",
    ),
    "utf8",
  );
  assert.match(
    migration,
    /after insert or update on public\.customer_analyses/u,
  );
  assert.match(migration, /delete from public\.solution_evaluations/u);
  assert.match(migration, /delete from public\.executive_summaries/u);

  const revisionMigration = readFileSync(
    path.join(
      repositoryRoot,
      "supabase/migrations/20260711123000_solution_evaluation_source_revision_fence.sql",
    ),
    "utf8",
  );
  assert.match(revisionMigration, /add column if not exists source_revision/u);
  assert.match(
    revisionMigration,
    /PROJECT_SOURCE_REVISION_CHANGED: project inputs changed/u,
  );
  assert.match(
    revisionMigration,
    /create or replace function public\.save_customer_analysis_if_source_revision/u,
  );
  assert.match(
    revisionMigration,
    /create or replace function public\.lease_fenced_save_customer_analysis/u,
  );
  assert.match(
    revisionMigration,
    /PROJECT_JOB_SUPERSEDED: a newer customer analysis job is authoritative/u,
  );
  assert.match(
    revisionMigration,
    /after update of role,[\s\S]*?structure_map on public\.documents/u,
  );
  const documentTriggerBody = revisionMigration.match(
    /create or replace function public\.bump_project_source_revision_from_document\(\)(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  assert.ok(documentTriggerBody, "document source-revision trigger mangler");
  assert.match(documentTriggerBody, /solution_evaluation_generated = false/u);
  assert.match(documentTriggerBody, /customer_analysis_generated = case/u);
  assert.match(documentTriggerBody, /delete from public\.customer_analyses/u);
  assert.match(documentTriggerBody, /delete from public\.solution_evaluations/u);
  assert.match(documentTriggerBody, /delete from public\.executive_summaries/u);
  assert.ok(
    documentTriggerBody.indexOf("update public.projects") <
      documentTriggerBody.indexOf("delete from public.solution_evaluations"),
    "project row must be locked before dependent rows are invalidated",
  );
  assert.doesNotMatch(
    revisionMigration.match(
      /create trigger documents_source_revision_update(?<trigger>[\s\S]*?)for each row/u,
    )?.groups?.trigger ?? "",
    /processing_status|processing_message|processing_error/u,
  );

  const artifactMigration = readFileSync(
    path.join(
      repositoryRoot,
      "supabase/migrations/20260711130000_generated_artifact_source_revision_fence.sql",
    ),
    "utf8",
  );
  const artifactDocumentTrigger = artifactMigration.match(
    /create or replace function public\.bump_project_source_revision_from_document\(\)(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  assert.ok(artifactDocumentTrigger, "artifact document trigger mangler");
  assert.match(artifactDocumentTrigger, /v_invalidates_analysis/u);
  assert.match(artifactDocumentTrigger, /customer_analysis_generated = case/u);
  assert.match(artifactDocumentTrigger, /delete from public\.customer_analyses/u);
  assert.match(artifactDocumentTrigger, /artifact_source_revision = artifact_source_revision \+ 1/u);
  assert.match(artifactMigration, /lease_fenced_save_generated_artifact/u);
  assert.match(artifactMigration, /ARTIFACT_KNOWLEDGE_CHANGED/u);
  assert.match(artifactMigration, /generation_job_id = p_job_id/u);
  assert.match(artifactMigration, /get_artifact_authority_summary/u);
  assert.match(artifactMigration, /'artifact_version', latest\.artifact_version/u);
  assert.match(artifactMigration, /'source_is_current', coalesce/u);
  const baseCandidatesBody = artifactMigration.match(
    /create or replace function public\.artifact_base_knowledge_candidates\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  assert.ok(baseCandidatesBody, "base artifact knowledge candidates body mangler");
  assert.match(baseCandidatesBody, /distinct on \(artifact\.artifact_type\)/u);
  assert.match(baseCandidatesBody, /latest\.input_artifact_source_revision = authority\.artifact_source_revision/u);
  assert.match(baseCandidatesBody, /latest\.input_service_library_revision = authority\.service_library_revision/u);
  assert.match(baseCandidatesBody, /latest\.artifact_type <> p_artifact_type/u);
  assert.doesNotMatch(
    baseCandidatesBody,
    /artifact_cross_type_knowledge_is_current/u,
    "base candidates must be one-hop and non-recursive",
  );
  const knowledgeManifestBody = artifactMigration.match(
    /create or replace function public\.artifact_knowledge_manifest\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  assert.ok(knowledgeManifestBody, "generation knowledge manifest body mangler");
  assert.match(knowledgeManifestBody, /artifact_base_knowledge_candidates/u);
  assert.match(knowledgeManifestBody, /artifact_cross_type_knowledge_is_current\(candidate_id\)/u);
  const crossCurrentnessBodies = [
    ...artifactMigration.matchAll(
      /create or replace function public\.artifact_cross_type_knowledge_is_current\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/gu,
    ),
  ];
  const crossCurrentnessBody = crossCurrentnessBodies.at(-1)?.groups?.body;
  assert.ok(crossCurrentnessBody, "cross-type knowledge currentness body mangler");
  assert.match(crossCurrentnessBody, /artifact\.knowledge_base_manifest/u);
  assert.match(crossCurrentnessBody, /public\.artifact_base_knowledge_manifest/u);
  assert.match(crossCurrentnessBody, /is distinct from artifact\.artifact_type/u);
  assert.match(crossCurrentnessBody, /\) = \(/u);
  const storeSource = readFileSync(
    path.join(frontendRoot, "lib/server/repositories/supabase-store.ts"),
    "utf8",
  );
  const knowledgeQueryBody = storeSource.match(
    /export async function listArtifactKnowledgeCandidatesFresh\((?<body>[\s\S]*?)export async function appendChatMessage/u,
  )?.groups?.body;
  assert.ok(knowledgeQueryBody, "fresh artifact knowledge query mangler");
  assert.match(knowledgeQueryBody, /"artifact_knowledge_manifest"/u);
  assert.match(knowledgeQueryBody, /\.in\("id", eligibleIds\)/u);
  assert.match(knowledgeQueryBody, /eligibleIds\.map/u);
  const generationSource = readFileSync(
    path.join(frontendRoot, "lib/server/use-cases/generate-artifact.ts"),
    "utf8",
  );
  assert.match(generationSource, /artifact_type: artifact\.artifact_type/u);
  assert.match(generationSource, /artifact_version: artifact\.artifact_version as number/u);
  const aiSource = readFileSync(
    path.join(frontendRoot, "lib/server/ai.ts"),
    "utf8",
  );
  const knowledgeSelectionBody = aiSource.match(
    /export function selectKnowledgeArtifactsForArtifact[\s\S]*?\{(?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body;
  assert.ok(knowledgeSelectionBody, "artifact knowledge selection body mangler");
  assert.match(knowledgeSelectionBody, /artifact\.artifact_type !== artifactType/u);
  const evaluationCurrentnessBody = artifactMigration.match(
    /create or replace function public\.solution_evaluation_is_current\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  assert.ok(evaluationCurrentnessBody, "solution evaluation currentness body mangler");
  assert.match(evaluationCurrentnessBody, /artifact_cross_type_knowledge_is_current\(artifact\.id\)/u);
  assert.match(artifactMigration, /knowledge_base_manifest, knowledge_artifact_manifest/u);
  assert.match(artifactMigration, /artifact_source_state enable row level security/u);
  assert.doesNotMatch(
    artifactMigration,
    /solution_evaluations_artifact_source_revision/u,
    "solution evaluation must not stale default forbedret_kravsvar",
  );
});

test("artifact RPC authority rejects malformed direct persistence payloads", () => {
  const artifactMigration = readFileSync(
    path.join(
      repositoryRoot,
      "supabase/migrations/20260711130000_generated_artifact_source_revision_fence.sql",
    ),
    "utf8",
  );
  const generatedBody = artifactMigration.match(
    /create or replace function public\.lease_fenced_save_generated_artifact\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  const manualBody = artifactMigration.match(
    /create or replace function public\.create_manual_artifact_version\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  assert.ok(generatedBody, "generated artifact RPC body mangler");
  assert.ok(manualBody, "manual artifact RPC body mangler");
  for (const body of [generatedBody, manualBody]) {
    assert.match(body, /ARTIFACT_CONTENT_REQUIRED/u);
    assert.match(body, /ARTIFACT_PROVENANCE_REQUIRED/u);
    assert.match(body, /expected_artifact_source_revision[\s\S]*?\^\(0\|\[1-9\]\[0-9\]\*\)\$/u);
    assert.ok(
      body.indexOf("ARTIFACT_CONTENT_REQUIRED") <
        body.indexOf("insert into public.generated_artifacts"),
      "content validation must precede persistence",
    );
  }
  assert.match(generatedBody, /ARTIFACT_TYPE_INVALID/u);
  const deleteBody = artifactMigration.match(
    /create or replace function public\.delete_artifact_version_serialized\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  assert.ok(deleteBody, "serialized artifact delete RPC body mangler");
  assert.match(deleteBody, /parent_artifact_id = p_artifact_id/u);
  assert.match(deleteBody, /ARTIFACT_HAS_CHILD_VERSION/u);
  assert.ok(
    deleteBody.indexOf("ARTIFACT_HAS_CHILD_VERSION") <
      deleteBody.indexOf("delete from public.generated_artifacts"),
    "child provenance must be protected before deletion",
  );
  const analysisFenceBody = artifactMigration.match(
    /create or replace function public\.lease_fenced_save_customer_analysis\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  assert.ok(analysisFenceBody, "customer analysis fence override mangler");
  assert.ok(
    analysisFenceBody.indexOf("from public.projects") <
      analysisFenceBody.indexOf("from public.project_jobs newer_job"),
    "project row must be locked before checking for a newer analysis job",
  );
});

test("manual artifact persistence validates acknowledgement against the parent version", () => {
  const storeSource = readFileSync(
    path.join(frontendRoot, "lib/server/repositories/supabase-store.ts"),
    "utf8",
  );
  const updateBody = storeSource.match(
    /export async function updateGeneratedArtifact\([\s\S]*?\{(?<body>[\s\S]*?)export async function deleteGeneratedArtifact/u,
  )?.groups?.body;
  assert.ok(updateBody, "updateGeneratedArtifact body mangler");
  assert.match(updateBody, /parentContentMarkdown:\s*parent\.content_markdown/u);
  assert.match(
    updateBody,
    /acknowledgeDeterministicRepairs:\s*input\.acknowledgeDeterministicRepairs\s*===\s*true/u,
  );
  assert.ok(
    updateBody.indexOf("buildValidatedManualArtifactInputSnapshot") <
      updateBody.indexOf('supabase.rpc("create_manual_artifact_version"'),
    "manuell validering må fullføres før en ny artefaktversjon lagres",
  );
});

test("same-job artifact retries validate current and stored authority before idempotent return", () => {
  for (const relativePath of [
    "supabase/migrations/20260711130000_generated_artifact_source_revision_fence.sql",
    "supabase/project_jobs_durable_execution.sql",
    "supabase/schema.sql",
  ]) {
    const sql = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    const body = sql.match(
      /create or replace function public\.lease_fenced_save_generated_artifact\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
    )?.groups?.body;
    assert.ok(body, `${relativePath} mangler generated-artifact-fence`);
    const existingArtifactLookup = body.indexOf(
      "where generation_job_id = p_job_id",
    );
    assert.ok(existingArtifactLookup > 0, `${relativePath} mangler idempotent lookup`);
    for (const authorityCheck of [
      "PROJECT_JOB_SUPERSEDED",
      "ARTIFACT_SOURCE_REVISION_CHANGED",
      "SERVICE_LIBRARY_REVISION_CHANGED",
      "ARTIFACT_KNOWLEDGE_CHANGED",
      "ARTIFACT_SOLUTION_EVALUATION_CHANGED",
    ]) {
      assert.ok(
        body.indexOf(authorityCheck) < existingArtifactLookup,
        `${relativePath}: ${authorityCheck} må kjøre før idempotent retur`,
      );
    }
    assert.ok(
      body.indexOf("ARTIFACT_IDEMPOTENCY_CONFLICT") > existingArtifactLookup,
      `${relativePath} må validere lagret autoritet ved replay`,
    );
    assert.match(body, /input_artifact_source_revision is distinct from v_expected_artifact_revision/u);
    assert.match(body, /source_snapshot_hash is distinct from/u);
    assert.match(body, /knowledge_artifact_manifest is distinct from/u);
  }
});

test("every SQL bootstrap atomically reuses an identical active project job", () => {
  for (const relativePath of [
    "supabase/migrations/20260711130000_generated_artifact_source_revision_fence.sql",
    "supabase/project_jobs_durable_execution.sql",
    "supabase/schema.sql",
  ]) {
    const sql = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    const body = sql.match(
      /create or replace function public\.enqueue_project_job_serialized\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
    )?.groups?.body;
    assert.ok(body, `${relativePath} mangler serialized enqueue`);
    assert.match(body, /input_json = p_job -> 'input_json'/u);
    assert.match(body, /status in \('queued', 'running'\)/u);
    assert.ok(
      body.indexOf("status in ('queued', 'running')") <
        body.indexOf("insert into public.project_jobs"),
      `${relativePath} må gjenbruke identisk aktiv jobb før insert`,
    );
  }
});

test("every SQL bootstrap preserves evaluation and summary provenance fences", () => {
  for (const relativePath of [
    "supabase/migrations/20260711130000_generated_artifact_source_revision_fence.sql",
    "supabase/project_jobs_durable_execution.sql",
    "supabase/schema.sql",
  ]) {
    const sql = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    const evaluationSaveBody = sql.match(
      /create or replace function public\.lease_fenced_save_solution_evaluation\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
    )?.groups?.body;
    assert.ok(evaluationSaveBody, `${relativePath} mangler evaluation-save-fence`);
    assert.match(evaluationSaveBody, /EVALUATED_ARTIFACT_REQUIRED/u);
    assert.match(evaluationSaveBody, /artifact\.generation_job_id = p_job_id/u);
    assert.match(evaluationSaveBody, /evaluated_generated_artifact_id = excluded\.evaluated_generated_artifact_id/u);
    assert.match(evaluationSaveBody, /evaluation_provenance_mode = excluded\.evaluation_provenance_mode/u);

    const evaluationCurrentnessBody = sql.match(
      /create or replace function public\.solution_evaluation_is_current\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
    )?.groups?.body;
    assert.ok(evaluationCurrentnessBody, `${relativePath} mangler evaluation-currentness`);
    assert.match(evaluationCurrentnessBody, /artifact_cross_type_knowledge_is_current\(artifact\.id\)/u);

    const summarySaveBody = sql.match(
      /create or replace function public\.lease_fenced_save_executive_summary\([\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
    )?.groups?.body;
    assert.ok(summarySaveBody, `${relativePath} mangler summary-save-fence`);
    assert.match(summarySaveBody, /EXECUTIVE_SUMMARY_EVALUATION_CHANGED/u);
    assert.match(summarySaveBody, /v_current_dependency is distinct from v_expected_dependency/u);
    assert.match(summarySaveBody, /provenance_verified = true/u);

    assert.match(sql, /create or replace function public\.get_current_project_derived_snapshot/u);
    assert.match(sql, /knowledge_base_manifest jsonb not null default '\[\]'::jsonb/u);
  }
});

test("generated artifacts use their dedicated fenced RPC", async () => {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: { id: "artifact-1" }, error: null };
    },
  };
  const result = await runWithProjectWorkflowContext(
    leaseContext(currentLease),
    () =>
      runLeaseFencedGeneratedArtifactMutation(
        projectId,
        { expected_artifact_source_revision: 3 },
        { client },
      ),
  );
  assert.equal(result.fenced, true);
  assert.equal(result.data.id, "artifact-1");
  assert.equal(calls[0].name, "lease_fenced_save_generated_artifact");
  assert.equal(calls[0].args.p_job_id, parentJobId);
});

function authoritativeDatabase() {
  const jobs = new Map([
    [
      parentJobId,
      {
        ...queuedRecord(parentJobId),
        kind: "document_ingestion",
        status: "running",
        submission_sequence: 1,
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
  let failSolutionAfterUpsert = false;

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
    addSolutionEvaluationJob({
      id,
      leaseToken,
      submissionSequence,
      kind = "solution_evaluation",
    }) {
      jobs.set(id, {
        ...queuedRecord(id),
        kind,
        status: "running",
        submission_sequence: submissionSequence,
        lease_token: leaseToken,
        input_json: { kind, projectId },
        result_json: null,
        locked_at: "2026-07-10T12:00:00.000Z",
        started_at: "2026-07-10T12:00:00.000Z",
        completed_at: null,
        parent_job_id: null,
        idempotency_key: null,
      });
    },
    failNextSolutionSaveAfterUpsert() {
      failSolutionAfterUpsert = true;
    },
    takeover() {
      const row = jobs.get(parentJobId);
      row.lease_token = currentLease;
      row.locked_at = "2026-07-10T12:02:00.000Z";
    },
    async rpc(name, args) {
      if (name === "lease_fenced_save_customer_analysis") {
        if (!ownsLease(args.p_job_id, args.p_lease_token, args.p_project_id)) {
          return {
            data: null,
            error: {
              message:
                "PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative",
            },
          };
        }
        const job = jobs.get(args.p_job_id);
        if (!["customer_analysis", "high_level_design"].includes(job.kind)) {
          return {
            data: null,
            error: {
              message:
                "PROJECT_JOB_KIND_MISMATCH: job cannot persist a customer analysis",
            },
          };
        }
        const superseded = [...jobs.values()].some(
          (candidate) =>
            candidate.project_id === args.p_project_id &&
            ["customer_analysis", "high_level_design"].includes(
              candidate.kind,
            ) &&
            candidate.submission_sequence > job.submission_sequence,
        );
        if (superseded) {
          return {
            data: null,
            error: {
              message:
                "PROJECT_JOB_SUPERSEDED: a newer customer analysis job is authoritative",
            },
          };
        }
        const project = business.projects.find(
          (row) => row.id === args.p_project_id,
        );
        if (!project) {
          return { data: null, error: { message: "Project does not exist" } };
        }
        if (
          project.source_revision !==
          args.p_payload.expected_source_revision
        ) {
          return {
            data: null,
            error: {
              message:
                "PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the analysis was running",
            },
          };
        }

        const staged = structuredClone(business);
        const existing = staged.customer_analyses.find(
          (row) => row.project_id === args.p_project_id,
        );
        const analysis = {
          id: existing?.id ?? `analysis-${args.p_job_id}`,
          project_id: args.p_project_id,
          source_document_ids: structuredClone(
            args.p_payload.source_document_ids,
          ),
          result_json: structuredClone(args.p_payload.result_json),
        };
        staged.customer_analyses = staged.customer_analyses.filter(
          (row) => row.project_id !== args.p_project_id,
        );
        staged.customer_analyses.push(analysis);
        staged.solution_evaluations = staged.solution_evaluations.filter(
          (row) => row.project_id !== args.p_project_id,
        );
        staged.executive_summaries = staged.executive_summaries.filter(
          (row) => row.project_id !== args.p_project_id,
        );
        const stagedProject = staged.projects.find(
          (row) => row.id === args.p_project_id,
        );
        stagedProject.customer_analysis_generated = true;
        stagedProject.solution_evaluation_generated = false;
        stagedProject.source_revision += 1;
        stagedProject.context_keywords = structuredClone(
          args.p_payload.context_keywords,
        );
        stagedProject.last_activity_at = args.p_payload.last_activity_at;

        for (const [table, rows] of Object.entries(staged)) {
          business[table].splice(0, business[table].length, ...rows);
        }
        return { data: structuredClone(analysis), error: null };
      }

      if (name === "lease_fenced_save_solution_evaluation") {
        if (!ownsLease(args.p_job_id, args.p_lease_token, args.p_project_id)) {
          return {
            data: null,
            error: {
              message:
                "PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative",
            },
          };
        }

        const job = jobs.get(args.p_job_id);
        if (
          !["solution_evaluation", "perfect_system_solution"].includes(job.kind)
        ) {
          return {
            data: null,
            error: {
              message:
                "PROJECT_JOB_KIND_MISMATCH: job cannot persist a solution evaluation",
            },
          };
        }
        const superseded = [...jobs.values()].some(
          (candidate) =>
            candidate.project_id === args.p_project_id &&
            ["solution_evaluation", "perfect_system_solution"].includes(
              candidate.kind,
            ) &&
            candidate.submission_sequence > job.submission_sequence,
        );
        if (superseded) {
          return {
            data: null,
            error: {
              message:
                "PROJECT_JOB_SUPERSEDED: a newer solution evaluation job is authoritative",
            },
          };
        }

        const authoritativeProject = business.projects.find(
          (row) => row.id === args.p_project_id,
        );
        if (!authoritativeProject) {
          return { data: null, error: { message: "Project does not exist" } };
        }
        if (
          authoritativeProject.source_revision !==
          args.p_payload.expected_source_revision
        ) {
          return {
            data: null,
            error: {
              message:
                "PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the evaluation was running",
            },
          };
        }

        // Stage every related change and only publish after all operations
        // succeed, mirroring a PostgreSQL function transaction.
        const staged = structuredClone(business);
        const previousEvaluation = staged.solution_evaluations.find(
          (row) => row.project_id === args.p_project_id,
        );
        const evaluation = {
          id: previousEvaluation?.id ?? `evaluation-${args.p_job_id}`,
          project_id: args.p_project_id,
          source_document_ids: args.p_payload.source_document_ids,
          customer_document_id: args.p_payload.customer_document_id,
          solution_document_id: args.p_payload.solution_document_id,
          analysis_id: args.p_payload.analysis_id,
          result_json: structuredClone(args.p_payload.result_json),
          updated_at: "2026-07-10T12:03:00.000Z",
        };
        staged.solution_evaluations = staged.solution_evaluations.filter(
          (row) => row.project_id !== args.p_project_id,
        );
        staged.solution_evaluations.push(evaluation);

        if (failSolutionAfterUpsert) {
          failSolutionAfterUpsert = false;
          return {
            data: null,
            error: { message: "forced failure after evaluation upsert" },
          };
        }

        staged.executive_summaries = staged.executive_summaries.filter(
          (row) => row.project_id !== args.p_project_id,
        );
        const project = staged.projects.find(
          (row) => row.id === args.p_project_id,
        );
        if (!project) {
          return { data: null, error: { message: "Project does not exist" } };
        }
        project.solution_evaluation_generated = true;
        project.last_activity_at = args.p_payload.last_activity_at;

        for (const [table, rows] of Object.entries(staged)) {
          business[table].splice(0, business[table].length, ...rows);
        }
        return { data: structuredClone(evaluation), error: null };
      }

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
        submission_sequence:
          Math.max(...[...jobs.values()].map((job) => job.submission_sequence)) +
          1,
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

  await assert.rejects(
    runWithProjectWorkflowContext(staleContext, () =>
      runLeaseFencedProjectMutation(
        projectId,
        "generated_artifact",
        { marker: "must-use-dedicated-rpc" },
        { client: database },
      ),
    ),
    /atomiske, versjonsfencede lagringsoperasjonen/u,
  );
  await assert.rejects(
    runWithProjectWorkflowContext(staleContext, () =>
      runLeaseFencedProjectMutation(
        projectId,
        "executive_summary",
        { marker: "must-use-dedicated-rpc" },
        { client: database },
      ),
    ),
    /atomiske, versjonsfencede lagringsoperasjonen/u,
  );

  assert.equal(staleContext.signal.aborted, false);
  await assert.rejects(
    runWithProjectWorkflowContext(leaseContext(currentLease), () =>
      runLeaseFencedProjectMutation(
        projectId,
        "solution_evaluation",
        { marker: "must-use-dedicated-rpc" },
        { client: database },
      ),
    ),
    /atomiske, versjonsfencede lagringsoperasjonen/u,
  );
  await assert.rejects(
    runWithProjectWorkflowContext(leaseContext(currentLease), () =>
      runLeaseFencedProjectMutation(
        projectId,
        "customer_analysis",
        { marker: "must-use-dedicated-rpc" },
        { client: database },
      ),
    ),
    /atomiske, versjonsfencede lagringsoperasjonen/u,
  );
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

test("concurrent solution evaluation jobs persist only the newest submission", async () => {
  const database = authoritativeDatabase();
  database.addSolutionEvaluationJob({
    id: olderEvaluationJobId,
    leaseToken: olderEvaluationLease,
    submissionSequence: 10,
  });
  database.addSolutionEvaluationJob({
    id: newerEvaluationJobId,
    leaseToken: newerEvaluationLease,
    submissionSequence: 11,
  });
  database.business.solution_evaluations.push({
    id: "evaluation-existing",
    project_id: projectId,
    result_json: { marker: "existing" },
  });
  database.business.executive_summaries.push({
    id: "summary-existing",
    project_id: projectId,
  });
  database.business.projects.push({
    id: projectId,
    source_revision: 0,
    solution_evaluation_generated: false,
    last_activity_at: "2026-07-10T11:59:00.000Z",
  });

  const [olderWrite, newerWrite] = await Promise.allSettled([
    runWithProjectWorkflowContext(
      leaseContext(olderEvaluationLease, olderEvaluationJobId),
      () =>
        runLeaseFencedSolutionEvaluationMutation(
          projectId,
          evaluationPayload("older"),
          { client: database },
        ),
    ),
    runWithProjectWorkflowContext(
      leaseContext(newerEvaluationLease, newerEvaluationJobId),
      () =>
        runLeaseFencedSolutionEvaluationMutation(
          projectId,
          evaluationPayload("newer"),
          { client: database },
        ),
    ),
  ]);

  assert.equal(olderWrite.status, "rejected");
  assert.match(olderWrite.reason.message, /PROJECT_JOB_SUPERSEDED/u);
  assert.equal(newerWrite.status, "fulfilled");
  assert.equal(
    database.business.solution_evaluations[0].result_json.marker,
    "newer",
  );
  assert.equal(database.business.executive_summaries.length, 0);
  assert.equal(
    database.business.projects[0].solution_evaluation_generated,
    true,
  );
});

test("concurrent customer-analysis jobs persist only the newest submission", async () => {
  const database = authoritativeDatabase();
  database.addSolutionEvaluationJob({
    id: olderEvaluationJobId,
    leaseToken: olderEvaluationLease,
    submissionSequence: 10,
    kind: "customer_analysis",
  });
  database.addSolutionEvaluationJob({
    id: newerEvaluationJobId,
    leaseToken: newerEvaluationLease,
    submissionSequence: 11,
    kind: "high_level_design",
  });
  database.business.projects.push({
    id: projectId,
    source_revision: 0,
    customer_analysis_generated: false,
    solution_evaluation_generated: true,
    last_activity_at: "2026-07-10T11:59:00.000Z",
  });

  const [olderWrite, newerWrite] = await Promise.allSettled([
    runWithProjectWorkflowContext(
      leaseContext(olderEvaluationLease, olderEvaluationJobId),
      () =>
        runLeaseFencedCustomerAnalysisMutation(
          projectId,
          customerAnalysisPayload("older"),
          { client: database },
        ),
    ),
    runWithProjectWorkflowContext(
      leaseContext(newerEvaluationLease, newerEvaluationJobId),
      () =>
        runLeaseFencedCustomerAnalysisMutation(
          projectId,
          customerAnalysisPayload("newer"),
          { client: database },
        ),
    ),
  ]);

  assert.equal(olderWrite.status, "rejected");
  assert.match(olderWrite.reason.message, /PROJECT_JOB_SUPERSEDED/u);
  assert.equal(newerWrite.status, "fulfilled");
  assert.equal(database.business.customer_analyses[0].result_json.marker, "newer");
  assert.equal(database.business.projects[0].source_revision, 1);
});

test("solution evaluation RPC rolls back every related write after a partial failure", async () => {
  const database = authoritativeDatabase();
  database.addSolutionEvaluationJob({
    id: newerEvaluationJobId,
    leaseToken: newerEvaluationLease,
    submissionSequence: 10,
  });
  database.business.solution_evaluations.push({
    id: "evaluation-existing",
    project_id: projectId,
    result_json: { marker: "existing" },
  });
  database.business.executive_summaries.push({
    id: "summary-existing",
    project_id: projectId,
  });
  database.business.projects.push({
    id: projectId,
    source_revision: 0,
    solution_evaluation_generated: false,
    last_activity_at: "2026-07-10T11:59:00.000Z",
  });
  const before = structuredClone(database.business);
  database.failNextSolutionSaveAfterUpsert();

  await assert.rejects(
    runWithProjectWorkflowContext(
      leaseContext(newerEvaluationLease, newerEvaluationJobId),
      () =>
        runLeaseFencedSolutionEvaluationMutation(
          projectId,
          evaluationPayload("failed-write"),
          { client: database },
        ),
    ),
    /forced failure after evaluation upsert/u,
  );
  assert.deepEqual(database.business, before);

  await runWithProjectWorkflowContext(
    leaseContext(newerEvaluationLease, newerEvaluationJobId),
    () =>
      runLeaseFencedSolutionEvaluationMutation(
        projectId,
        evaluationPayload("successful-retry"),
        { client: database },
      ),
  );
  assert.equal(
    database.business.solution_evaluations[0].result_json.marker,
    "successful-retry",
  );
  assert.equal(database.business.executive_summaries.length, 0);
  assert.equal(
    database.business.projects[0].solution_evaluation_generated,
    true,
  );
});

test("a source mutation after input capture fences the stale evaluation atomically", async () => {
  const database = authoritativeDatabase();
  database.addSolutionEvaluationJob({
    id: newerEvaluationJobId,
    leaseToken: newerEvaluationLease,
    submissionSequence: 10,
  });
  database.business.solution_evaluations.push({
    id: "evaluation-existing",
    project_id: projectId,
    result_json: { marker: "existing" },
  });
  database.business.executive_summaries.push({
    id: "summary-existing",
    project_id: projectId,
  });
  database.business.projects.push({
    id: projectId,
    source_revision: 0,
    solution_evaluation_generated: true,
    last_activity_at: "2026-07-10T11:59:00.000Z",
  });
  const before = structuredClone(database.business);
  const stalePayload = evaluationPayload("stale");

  database.business.projects[0].source_revision += 1;

  await assert.rejects(
    runWithProjectWorkflowContext(
      leaseContext(newerEvaluationLease, newerEvaluationJobId),
      () =>
        runLeaseFencedSolutionEvaluationMutation(projectId, stalePayload, {
          client: database,
        }),
    ),
    /PROJECT_SOURCE_REVISION_CHANGED/u,
  );
  assert.deepEqual(database.business.solution_evaluations, before.solution_evaluations);
  assert.deepEqual(database.business.executive_summaries, before.executive_summaries);
  assert.equal(database.business.projects[0].solution_evaluation_generated, true);

  await runWithProjectWorkflowContext(
    leaseContext(newerEvaluationLease, newerEvaluationJobId),
    () =>
      runLeaseFencedSolutionEvaluationMutation(
        projectId,
        { ...evaluationPayload("fresh"), expected_source_revision: 1 },
        { client: database },
      ),
  );
  assert.equal(
    database.business.solution_evaluations[0].result_json.marker,
    "fresh",
  );
  assert.equal(database.business.executive_summaries.length, 0);
});

test("a source mutation after input capture fences stale customer analysis atomically", async () => {
  const database = authoritativeDatabase();
  database.addSolutionEvaluationJob({
    id: newerEvaluationJobId,
    leaseToken: newerEvaluationLease,
    submissionSequence: 10,
    kind: "customer_analysis",
  });
  database.business.customer_analyses.push({
    id: "analysis-existing",
    project_id: projectId,
    result_json: { marker: "existing" },
  });
  database.business.solution_evaluations.push({
    id: "evaluation-existing",
    project_id: projectId,
    result_json: { marker: "existing" },
  });
  database.business.executive_summaries.push({
    id: "summary-existing",
    project_id: projectId,
  });
  database.business.projects.push({
    id: projectId,
    source_revision: 1,
    customer_analysis_generated: false,
    solution_evaluation_generated: true,
    last_activity_at: "2026-07-10T11:59:00.000Z",
  });
  const before = structuredClone(database.business);

  await assert.rejects(
    runWithProjectWorkflowContext(
      leaseContext(newerEvaluationLease, newerEvaluationJobId),
      () =>
        runLeaseFencedCustomerAnalysisMutation(
          projectId,
          customerAnalysisPayload("stale", 0),
          { client: database },
        ),
    ),
    /PROJECT_SOURCE_REVISION_CHANGED/u,
  );
  assert.deepEqual(database.business, before);

  await runWithProjectWorkflowContext(
    leaseContext(newerEvaluationLease, newerEvaluationJobId),
    () =>
      runLeaseFencedCustomerAnalysisMutation(
        projectId,
        customerAnalysisPayload("fresh", 1),
        { client: database },
      ),
  );
  assert.equal(database.business.customer_analyses[0].result_json.marker, "fresh");
  assert.equal(database.business.solution_evaluations.length, 0);
  assert.equal(database.business.executive_summaries.length, 0);
  assert.equal(database.business.projects[0].source_revision, 2);
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
