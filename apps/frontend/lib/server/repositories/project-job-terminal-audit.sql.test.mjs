import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const migrationPath = path.join(
  repositoryRoot,
  "supabase/migrations/20260712130000_transactional_project_job_terminal_audit_v2.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const schemaSql = readFileSync(
  path.join(repositoryRoot, "supabase/schema.sql"),
  "utf8",
);
const durableSql = readFileSync(
  path.join(repositoryRoot, "supabase/project_jobs_durable_execution.sql"),
  "utf8",
);

test("terminal project-job audit is transactional, idempotent, and canonical", () => {
  for (const sql of [migrationSql, schemaSql, durableSql]) {
    assert.match(sql, /function public\.audit_project_job_terminal_state\(\)/u);
    assert.match(sql, /security definer[\s\S]*set search_path = ''/u);
    assert.match(sql, /on conflict \(id\) do nothing/u);
    assert.match(
      sql,
      /after update of status on public\.project_jobs[\s\S]*new\.status in \('completed', 'failed'\)/u,
    );
    assert.match(sql, /'solution_evaluation_generated'/u);
    assert.match(sql, /'project_job_failed'/u);
    assert.match(sql, /subject_project_id/u);
    assert.match(sql, /audit_project_job_terminal_insert/u);
    assert.match(sql, /protect_project_job_terminal_state/u);
    assert.match(
      sql,
      /Invalid produced solution-evaluation terminal marker/u,
    );
    assert.match(sql, /requirement_response_handoff/u);
    assert.match(sql, /pg_catalog\.pg_get_indexdef/u);
    assert.match(sql, /pg_catalog\.pg_get_triggerdef/u);
    assert.match(sql, /pg_catalog\.pg_attrdef/u);
    assert.match(sql, /trigger\.tgenabled in \('O', 'A'\)/u);
    assert.match(sql, /trigger\.tgfoid = pg_catalog\.to_regprocedure/u);
  }
  for (const sql of [migrationSql, durableSql]) {
    const terminalSectionStart = sql.indexOf(
      "create or replace function public.audit_project_job_terminal_state()",
    );
    const triggerPosition = sql.indexOf(
      "create trigger audit_project_job_terminal_state",
      terminalSectionStart,
    );
    const backfillPosition = sql.indexOf(
      "Backfill only immutable job facts",
      terminalSectionStart,
    );
    assert.notEqual(terminalSectionStart, -1);
    assert.notEqual(triggerPosition, -1);
    assert.notEqual(backfillPosition, -1);
    assert.ok(
      triggerPosition < backfillPosition,
      "terminal capture trigger must be installed before immutable backfill",
    );
    const nextIndependentSection = sql.indexOf(
      "-- Canonical atomic service-document writer",
      terminalSectionStart,
    );
    const terminalSectionEnd =
      nextIndependentSection === -1 ? sql.length : nextIndependentSection;
    assert.doesNotMatch(
      sql.slice(terminalSectionStart, terminalSectionEnd),
      /from public\.solution_evaluations/u,
    );
  }
});

function runPsql(databaseUrl, sql) {
  return spawnSync(
    "psql",
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    { encoding: "utf8" },
  );
}

function runPsqlFile(databaseUrl, filePath) {
  return spawnSync(
    "psql",
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-q", "-f", filePath],
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDatabaseCondition(databaseUrl, sql, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runPsql(databaseUrl, sql);
    assertPsqlSucceeded(result, "poll database race condition");
    if (result.stdout.trim() === "1") return;
    await delay(25);
  }
  assert.fail("database race condition was not observed before timeout");
}

function assertPsqlSucceeded(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed:\n${result.stderr || result.stdout}`,
  );
}

const liveDatabaseUrl =
  process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL ??
  process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;

test(
  "postgres: terminal status and audit event commit or roll back together",
  { skip: !liveDatabaseUrl, timeout: 60_000 },
  async () => {
    const databaseName = `anbud_job_audit_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = new URL(liveDatabaseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const quotedDatabaseName = `"${databaseName}"`;

    assertPsqlSucceeded(
      runPsql(liveDatabaseUrl, `create database ${quotedDatabaseName}`),
      "create disposable audit database",
    );

    try {
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            create table public.projects (id uuid primary key);
            create table public.project_jobs (
              id uuid primary key,
              project_id uuid not null references public.projects(id) on delete cascade,
              kind text not null,
              status text not null,
              input_json jsonb,
              started_at timestamptz,
              completed_at timestamptz,
              terminal_metadata jsonb not null default '{}'::jsonb
            );
            create table public.generated_artifacts (
              id uuid primary key,
              project_id uuid not null references public.projects(id) on delete cascade,
              generation_job_id uuid
            );
            create table public.solution_evaluations (
              project_id uuid not null references public.projects(id) on delete cascade,
              solution_document_id uuid,
              evaluated_generated_artifact_id uuid
            );
            create table public.audit_events (
              id uuid primary key,
              action text not null,
              project_id uuid references public.projects(id) on delete set null,
              subject_project_id uuid,
              entity_type text,
              entity_id uuid,
              metadata jsonb not null default '{}'::jsonb,
              created_at timestamptz not null default now()
            );
            insert into public.projects(id)
            values ('00000000-0000-4000-8000-000000000000');
            insert into public.project_jobs(
              id, project_id, kind, status, input_json, started_at, completed_at
            ) values (
              '00000000-0000-4000-8000-000000000001',
              '00000000-0000-4000-8000-000000000000',
              'artifact_generation', 'completed', '{}', now(), now()
            );
            insert into public.audit_events(id, action, metadata)
            values (
              '00000000-0000-4000-8000-000000000061',
              'legacy_event',
              '{"project_id":"00000000-0000-4000-8000-000000000000"}'
            );
          `,
        ),
        "create terminal audit fixture",
      );
      assertPsqlSucceeded(
        runPsqlFile(databaseUrl.toString(), migrationPath),
        "apply terminal audit migration",
      );
      const preflight = runPsql(
        databaseUrl.toString(),
        "select public.project_job_terminal_audit_preflight();",
      );
      assertPsqlSucceeded(preflight, "run terminal audit preflight");
      assert.equal(
        preflight.stdout.trim(),
        "transactional-project-job-terminal-audit-v2",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.project_jobs alter column terminal_metadata drop default;",
        ),
        "drop terminal metadata default",
      );
      const missingDefaultPreflight = runPsql(
        databaseUrl.toString(),
        "select public.project_job_terminal_audit_preflight();",
      );
      assert.notEqual(missingDefaultPreflight.status, 0);
      assert.match(
        missingDefaultPreflight.stderr,
        /terminal_metadata or its default is missing or unexpected/u,
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.project_jobs alter column terminal_metadata set default '{}'::jsonb;",
        ),
        "restore terminal metadata default",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.project_jobs disable trigger protect_project_job_terminal_state;",
        ),
        "disable terminal metadata guard",
      );
      const disabledGuardPreflight = runPsql(
        databaseUrl.toString(),
        "select public.project_job_terminal_audit_preflight();",
      );
      assert.notEqual(disabledGuardPreflight.status, 0);
      assert.match(
        disabledGuardPreflight.stderr,
        /state guard is missing or unexpected/u,
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.project_jobs enable trigger protect_project_job_terminal_state;",
        ),
        "re-enable terminal metadata guard",
      );
      const repairedLegacySubject = runPsql(
        databaseUrl.toString(),
        `select subject_project_id::text from public.audit_events
         where id = '00000000-0000-4000-8000-000000000061';`,
      );
      assertPsqlSucceeded(
        repairedLegacySubject,
        "read repaired legacy audit subject",
      );
      assert.equal(
        repairedLegacySubject.stdout.trim(),
        "00000000-0000-4000-8000-000000000000",
      );
      const backfilledAudit = runPsql(
        databaseUrl.toString(),
        `select action || '|' || subject_project_id::text
         from public.audit_events
         where id = '00000000-0000-4000-8000-000000000001';`,
      );
      assertPsqlSucceeded(backfilledAudit, "read backfilled terminal audit");
      assert.equal(
        backfilledAudit.stdout.trim(),
        "project_job_completed|00000000-0000-4000-8000-000000000000",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.project_jobs disable trigger audit_project_job_terminal_state;",
        ),
        "disable terminal audit trigger",
      );
      const disabledPreflight = runPsql(
        databaseUrl.toString(),
        "select public.project_job_terminal_audit_preflight();",
      );
      assert.notEqual(disabledPreflight.status, 0);
      assert.match(
        disabledPreflight.stderr,
        /terminal audit trigger definitions are missing or unexpected/u,
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.project_jobs enable trigger audit_project_job_terminal_state;",
        ),
        "re-enable terminal audit trigger",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `drop trigger audit_project_job_terminal_state on public.project_jobs;
           create trigger audit_project_job_terminal_state
           after insert on public.project_jobs
           for each row execute function public.audit_project_job_terminal_state();`,
        ),
        "replace status trigger with wrong event shape",
      );
      const wrongTriggerPreflight = runPsql(
        databaseUrl.toString(),
        "select public.project_job_terminal_audit_preflight();",
      );
      assert.notEqual(wrongTriggerPreflight.status, 0);
      assert.match(
        wrongTriggerPreflight.stderr,
        /terminal audit trigger definitions are missing or unexpected/u,
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `drop trigger audit_project_job_terminal_state on public.project_jobs;
           create trigger audit_project_job_terminal_state
           after update of status on public.project_jobs
           for each row
           when (
             old.status is distinct from new.status
             and new.status in ('completed', 'failed')
           )
           execute function public.audit_project_job_terminal_state();`,
        ),
        "restore exact terminal status trigger",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            insert into public.projects(id)
            values ('00000000-0000-4000-8000-000000000001');
            insert into public.project_jobs(
              id, project_id, kind, status, input_json, started_at
            ) values
              (
                '00000000-0000-4000-8000-000000000011',
                '00000000-0000-4000-8000-000000000001',
                'solution_evaluation',
                'running',
                '{"solutionDocumentId":"00000000-0000-4000-8000-000000000099"}',
                '2026-07-12T10:00:00Z'
              ),
              (
                '00000000-0000-4000-8000-000000000012',
                '00000000-0000-4000-8000-000000000001',
                'artifact_generation',
                'running',
                '{}',
                '2026-07-12T10:00:00Z'
              );
            insert into public.solution_evaluations(
              project_id, solution_document_id, evaluated_generated_artifact_id
            ) values (
              '00000000-0000-4000-8000-000000000001',
              '00000000-0000-4000-8000-000000000099',
              null
            );
            update public.project_jobs
            set status = 'completed', completed_at = '2026-07-12T10:01:00Z'
            where id = '00000000-0000-4000-8000-000000000011';
          `,
        ),
        "complete solution-evaluation job",
      );

      const terminalEvent = runPsql(
        databaseUrl.toString(),
        `
          select action || '|' || entity_type || '|' ||
            coalesce(project_id::text, 'null') || '|' ||
            subject_project_id::text || '|' ||
            (metadata ->> 'project_id') || '|' ||
            (metadata ->> 'status') || '|' ||
            (metadata ->> 'solution_document_id')
          from public.audit_events
          where id = '00000000-0000-4000-8000-000000000011';
        `,
      );
      assertPsqlSucceeded(terminalEvent, "read terminal audit event");
      assert.equal(
        terminalEvent.stdout.trim(),
        "solution_evaluation_generated|project_job|null|00000000-0000-4000-8000-000000000001|00000000-0000-4000-8000-000000000001|completed|00000000-0000-4000-8000-000000000099",
      );
      const rejectedTerminalReopen = runPsql(
        databaseUrl.toString(),
        `update public.project_jobs set status = 'running'
         where id = '00000000-0000-4000-8000-000000000011';`,
      );
      assert.notEqual(rejectedTerminalReopen.status, 0);
      assert.match(
        rejectedTerminalReopen.stderr,
        /state and metadata are immutable/u,
      );
      const rejectedTerminalMetadataMutation = runPsql(
        databaseUrl.toString(),
        `update public.project_jobs
         set terminal_metadata = '{"produced_solution_evaluation":false}'::jsonb
         where id = '00000000-0000-4000-8000-000000000011';`,
      );
      assert.notEqual(rejectedTerminalMetadataMutation.status, 0);
      assert.match(
        rejectedTerminalMetadataMutation.stderr,
        /state and metadata are immutable/u,
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.project_jobs
           set status = status, terminal_metadata = terminal_metadata
           where id = '00000000-0000-4000-8000-000000000011';`,
        ),
        "allow a terminal no-op without duplicating audit",
      );
      const terminalEventCount = runPsql(
        databaseUrl.toString(),
        `select count(*) from public.audit_events
         where id = '00000000-0000-4000-8000-000000000011';`,
      );
      assertPsqlSucceeded(terminalEventCount, "count idempotent terminal audit");
      assert.equal(terminalEventCount.stdout.trim(), "1");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.audit_events
           set metadata = jsonb_set(
             metadata,
             '{solution_document_id}',
             '"00000000-0000-4000-8000-000000000098"'::jsonb
           )
           where id = '00000000-0000-4000-8000-000000000011';`,
        ),
        "tamper immutable audit provenance",
      );
      const rejectedMigrationRerun = runPsqlFile(
        databaseUrl.toString(),
        migrationPath,
      );
      assert.notEqual(rejectedMigrationRerun.status, 0);
      assert.match(
        rejectedMigrationRerun.stderr,
        /audit rows are incomplete or conflicting/u,
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.audit_events
           set metadata = jsonb_set(
             metadata,
             '{solution_document_id}',
             '"00000000-0000-4000-8000-000000000099"'::jsonb
           )
           where id = '00000000-0000-4000-8000-000000000011';`,
        ),
        "restore immutable audit provenance",
      );
      assertPsqlSucceeded(
        runPsqlFile(databaseUrl.toString(), migrationPath),
        "rerun terminal audit migration idempotently",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            insert into public.projects(id) values
              ('00000000-0000-4000-8000-000000000003'),
              ('00000000-0000-4000-8000-000000000004');
            insert into public.project_jobs(
              id, project_id, kind, status, input_json, started_at
            ) values
              (
                '00000000-0000-4000-8000-000000000031',
                '00000000-0000-4000-8000-000000000003',
                'perfect_system_solution', 'running', '{}', now()
              ),
              (
                '00000000-0000-4000-8000-000000000041',
                '00000000-0000-4000-8000-000000000004',
                'perfect_system_solution', 'running', '{}', now()
              );
            insert into public.generated_artifacts(
              id, project_id, generation_job_id
            ) values (
              '00000000-0000-4000-8000-000000000311',
              '00000000-0000-4000-8000-000000000003',
              '00000000-0000-4000-8000-000000000031'
            );
            insert into public.solution_evaluations(
              project_id, solution_document_id, evaluated_generated_artifact_id
            ) values (
              '00000000-0000-4000-8000-000000000003',
              '00000000-0000-4000-8000-000000000399',
              '00000000-0000-4000-8000-000000000311'
            );
            update public.project_jobs
            set status = 'completed',
                completed_at = now(),
                terminal_metadata = case id
                  when '00000000-0000-4000-8000-000000000031'::uuid then
                    '{"produced_solution_evaluation":true,"solution_document_id":"00000000-0000-4000-8000-000000000399"}'::jsonb
                  else '{"produced_solution_evaluation":false}'::jsonb
                end
            where id in (
              '00000000-0000-4000-8000-000000000031',
              '00000000-0000-4000-8000-000000000041'
            );
          `,
        ),
        "complete perfect-system jobs with and without an evaluation",
      );
      const perfectSystemActions = runPsql(
        databaseUrl.toString(),
        `
          select id::text || ':' || action || ':' ||
            (metadata ->> 'produced_solution_evaluation')
          from public.audit_events
          where id in (
            '00000000-0000-4000-8000-000000000031',
            '00000000-0000-4000-8000-000000000041'
          )
          order by id;
        `,
      );
      assertPsqlSucceeded(perfectSystemActions, "read perfect-system audits");
      assert.deepEqual(perfectSystemActions.stdout.trim().split("\n"), [
        "00000000-0000-4000-8000-000000000031:solution_evaluation_generated:true",
        "00000000-0000-4000-8000-000000000041:project_job_completed:false",
      ]);
      const immutableTerminalMetadata = runPsql(
        databaseUrl.toString(),
        `update public.project_jobs
         set terminal_metadata = '{"produced_solution_evaluation":false}'::jsonb
         where id = '00000000-0000-4000-8000-000000000031';`,
      );
      assert.notEqual(immutableTerminalMetadata.status, 0);
      assert.match(
        immutableTerminalMetadata.stderr,
        /state and metadata are immutable/u,
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            insert into public.projects(id)
            values ('00000000-0000-4000-8000-000000000005');
            insert into public.project_jobs(
              id, project_id, kind, status, input_json, started_at, completed_at
            ) values (
              '00000000-0000-4000-8000-000000000051',
              '00000000-0000-4000-8000-000000000005',
              'artifact_generation', 'completed', '{}', now(), now()
            );
          `,
        ),
        "insert an already-terminal job",
      );
      const insertedTerminalAudit = runPsql(
        databaseUrl.toString(),
        `select action from public.audit_events
         where id = '00000000-0000-4000-8000-000000000051';`,
      );
      assertPsqlSucceeded(insertedTerminalAudit, "read inserted terminal audit");
      assert.equal(insertedTerminalAudit.stdout.trim(), "project_job_completed");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.project_jobs(
             id, project_id, kind, status, input_json, started_at
           ) values (
             '00000000-0000-4000-8000-000000000052',
             '00000000-0000-4000-8000-000000000005',
             'artifact_generation', 'running', '{}', now()
           );`,
        ),
        "create invalid production-marker fixture",
      );
      const rejectedInvalidProductionMarker = runPsql(
        databaseUrl.toString(),
        `update public.project_jobs
         set status = 'completed',
             terminal_metadata = '{
               "produced_solution_evaluation":true,
               "solution_document_id":"00000000-0000-4000-8000-000000000599"
             }'::jsonb
         where id = '00000000-0000-4000-8000-000000000052';`,
      );
      assert.notEqual(rejectedInvalidProductionMarker.status, 0);
      assert.match(
        rejectedInvalidProductionMarker.stderr,
        /Invalid produced solution-evaluation terminal marker/u,
      );
      const invalidMarkerRollback = runPsql(
        databaseUrl.toString(),
        `select status from public.project_jobs
         where id = '00000000-0000-4000-8000-000000000052';`,
      );
      assertPsqlSucceeded(
        invalidMarkerRollback,
        "read invalid production-marker rollback",
      );
      assert.equal(invalidMarkerRollback.stdout.trim(), "running");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.projects(id)
           values ('00000000-0000-4000-8000-000000000006');
           insert into public.project_jobs(
             id, project_id, kind, status, input_json, started_at
           ) values (
             '00000000-0000-4000-8000-000000000062',
             '00000000-0000-4000-8000-000000000006',
             'artifact_generation', 'running', '{}', now()
           );
           update public.project_jobs
           set status = 'failed',
               completed_at = now(),
               terminal_metadata = '{
                 "produced_solution_evaluation":false,
                 "solution_document_id":null,
                 "requirement_response_handoff":{
                   "outcome":"failed_closed",
                   "terminal_reason":"deadline_exceeded",
                   "configured_call_budget":12,
                   "configured_deadline_ms":120000,
                   "configured_concurrency":2,
                   "strict_candidates":4,
                   "calls_started":2,
                   "repairs_accepted":1,
                   "calls_without_accepted_repair":1,
                   "skipped_call_budget":0,
                   "skipped_deadline":0,
                   "unresolved_after_handoff":2
                 }
               }'::jsonb
           where id = '00000000-0000-4000-8000-000000000062';
           delete from public.projects
           where id = '00000000-0000-4000-8000-000000000006';`,
        ),
        "fail and clean a project with strict handoff diagnostics",
      );
      const retainedHandoffAudit = runPsql(
        databaseUrl.toString(),
        `select action || '|' || coalesce(project_id::text, 'null') || '|' ||
           (metadata #>> '{requirement_response_handoff,terminal_reason}') || '|' ||
           (metadata #>> '{requirement_response_handoff,calls_started}')
         from public.audit_events
         where id = '00000000-0000-4000-8000-000000000062';`,
      );
      assertPsqlSucceeded(
        retainedHandoffAudit,
        "read retained handoff diagnostics after project cleanup",
      );
      assert.equal(
        retainedHandoffAudit.stdout.trim(),
        "project_job_failed|null|deadline_exceeded|2",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `alter table public.audit_events add constraint reject_failed_audit
             check (action <> 'project_job_failed') not valid;`,
        ),
        "install forced audit failure",
      );
      const rejectedTerminalUpdate = runPsql(
        databaseUrl.toString(),
        `
          update public.project_jobs
          set status = 'failed', completed_at = '2026-07-12T10:02:00Z'
          where id = '00000000-0000-4000-8000-000000000012';
        `,
      );
      assert.notEqual(rejectedTerminalUpdate.status, 0);
      assert.match(rejectedTerminalUpdate.stderr, /reject_failed_audit/u);

      const rolledBackStatus = runPsql(
        databaseUrl.toString(),
        `select status from public.project_jobs
         where id = '00000000-0000-4000-8000-000000000012';`,
      );
      assertPsqlSucceeded(rolledBackStatus, "read rolled-back job status");
      assert.equal(rolledBackStatus.stdout.trim(), "running");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            insert into public.project_jobs(
              id, project_id, kind, status, input_json, started_at
            ) values (
              '00000000-0000-4000-8000-000000000013',
              '00000000-0000-4000-8000-000000000001',
              'artifact_generation',
              'running',
              '{}',
              '2026-07-12T10:03:00Z'
            );
            insert into public.audit_events(
              id, action, entity_type, entity_id, metadata
            ) values (
              '00000000-0000-4000-8000-000000000013',
              'unrelated_existing_event',
              'project_job',
              '00000000-0000-4000-8000-000000000013',
              '{}'
            );
          `,
        ),
        "create conflicting audit fixture",
      );
      const conflictingTerminalUpdate = runPsql(
        databaseUrl.toString(),
        `
          update public.project_jobs
          set status = 'completed', completed_at = '2026-07-12T10:04:00Z'
          where id = '00000000-0000-4000-8000-000000000013';
        `,
      );
      assert.notEqual(conflictingTerminalUpdate.status, 0);
      assert.match(conflictingTerminalUpdate.stderr, /Terminal audit id conflict/u);
      const conflictRollback = runPsql(
        databaseUrl.toString(),
        `select status from public.project_jobs
         where id = '00000000-0000-4000-8000-000000000013';`,
      );
      assertPsqlSucceeded(conflictRollback, "read conflict-rolled-back status");
      assert.equal(conflictRollback.stdout.trim(), "running");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.project_jobs(
             id, project_id, kind, status, input_json, started_at
           ) values (
             '00000000-0000-4000-8000-000000000014',
             '00000000-0000-4000-8000-000000000001',
             'solution_evaluation',
             'running',
             '{"solutionDocumentId":"00000000-0000-4000-8000-000000000099"}',
             '2026-07-12T10:05:00Z'
           );
           insert into public.audit_events(
             id, action, project_id, subject_project_id, entity_type,
             entity_id, metadata
           ) values (
             '00000000-0000-4000-8000-000000000014',
             'solution_evaluation_generated',
             null,
             '00000000-0000-4000-8000-000000000001',
             'project_job',
             '00000000-0000-4000-8000-000000000014',
             '{
               "job_id":"00000000-0000-4000-8000-000000000014",
               "project_id":"00000000-0000-4000-8000-000000000001",
               "kind":"solution_evaluation",
               "status":"completed",
               "produced_solution_evaluation":true,
               "production_marker_source":"legacy_job_contract",
               "solution_document_id":"00000000-0000-4000-8000-000000000098"
             }'::jsonb
           );`,
        ),
        "create wrong-document audit conflict fixture",
      );
      const wrongDocumentConflict = runPsql(
        databaseUrl.toString(),
        `update public.project_jobs
         set status = 'completed', completed_at = '2026-07-12T10:06:00Z'
         where id = '00000000-0000-4000-8000-000000000014';`,
      );
      assert.notEqual(wrongDocumentConflict.status, 0);
      assert.match(wrongDocumentConflict.stderr, /Terminal audit id conflict/u);
      const wrongDocumentRollback = runPsql(
        databaseUrl.toString(),
        `select status from public.project_jobs
         where id = '00000000-0000-4000-8000-000000000014';`,
      );
      assertPsqlSucceeded(
        wrongDocumentRollback,
        "read wrong-document conflict rollback",
      );
      assert.equal(wrongDocumentRollback.stdout.trim(), "running");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            create or replace function public.delay_terminal_job_test()
            returns trigger language plpgsql as $$
            begin
              perform pg_catalog.pg_sleep(2);
              return new;
            end;
            $$;
            create trigger delay_terminal_job_test
            before update of status on public.project_jobs
            for each row
            when (new.status in ('completed', 'failed'))
            execute function public.delay_terminal_job_test();
            insert into public.projects(id)
            values ('00000000-0000-4000-8000-000000000002');
            insert into public.project_jobs(
              id, project_id, kind, status, input_json, started_at
            ) values (
              '00000000-0000-4000-8000-000000000021',
              '00000000-0000-4000-8000-000000000002',
              'solution_evaluation',
              'running',
              '{}',
              '2026-07-12T11:00:00Z'
            );
          `,
        ),
        "create deterministic delete race fixture",
      );

      const terminalUpdate = runPsqlAsync(
        databaseUrl.toString(),
        `
          set deadlock_timeout = '100ms';
          set lock_timeout = '5s';
          update public.project_jobs
          set status = 'completed', completed_at = '2026-07-12T11:01:00Z'
          where id = '00000000-0000-4000-8000-000000000021';
        `,
      );
      await waitForDatabaseCondition(
        databaseUrl.toString(),
        `
          select case when exists (
            select 1
            from pg_catalog.pg_stat_activity
            where pid <> pg_catalog.pg_backend_pid()
              and datname = pg_catalog.current_database()
              and state = 'active'
              and wait_event = 'PgSleep'
              and query like '%00000000-0000-4000-8000-000000000021%'
          ) then 1 else 0 end;
        `,
      );
      const projectDelete = runPsqlAsync(
        databaseUrl.toString(),
        `
          set deadlock_timeout = '100ms';
          set lock_timeout = '5s';
          delete from public.projects
          where id = '00000000-0000-4000-8000-000000000002';
        `,
      );
      const [terminalResult, deleteResult] = await Promise.all([
        terminalUpdate,
        projectDelete,
      ]);
      assertPsqlSucceeded(terminalResult, "commit terminal update in delete race");
      assertPsqlSucceeded(deleteResult, "commit project delete in terminal race");

      const retainedAudit = runPsql(
        databaseUrl.toString(),
        `
          select action || '|' || coalesce(project_id::text, 'null') || '|' ||
            (metadata ->> 'project_id')
          from public.audit_events
          where id = '00000000-0000-4000-8000-000000000021';
        `,
      );
      assertPsqlSucceeded(retainedAudit, "read retained race audit");
      assert.equal(
        retainedAudit.stdout.trim(),
        "solution_evaluation_generated|null|00000000-0000-4000-8000-000000000002",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          "drop index public.audit_events_subject_project_idx;",
        ),
        "drop audit subject index",
      );
      const missingIndexPreflight = runPsql(
        databaseUrl.toString(),
        "select public.project_job_terminal_audit_preflight();",
      );
      assert.notEqual(missingIndexPreflight.status, 0);
      assert.match(
        missingIndexPreflight.stderr,
        /subject project index is missing or invalid/u,
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `create index audit_events_subject_project_idx
             on public.audit_events(action);`,
        ),
        "install same-name audit index with wrong keys",
      );
      const wrongIndexPreflight = runPsql(
        databaseUrl.toString(),
        "select public.project_job_terminal_audit_preflight();",
      );
      assert.notEqual(wrongIndexPreflight.status, 0);
      assert.match(
        wrongIndexPreflight.stderr,
        /subject project index is missing or invalid/u,
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `drop index public.audit_events_subject_project_idx;
           create index audit_events_subject_project_idx
             on public.audit_events(subject_project_id, created_at desc);`,
        ),
        "restore audit subject index",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.audit_events drop column subject_project_id;",
        ),
        "drop audit subject column",
      );
      const missingSubjectPreflight = runPsql(
        databaseUrl.toString(),
        "select public.project_job_terminal_audit_preflight();",
      );
      assert.notEqual(missingSubjectPreflight.status, 0);
      assert.match(
        missingSubjectPreflight.stderr,
        /subject_project_id is missing/u,
      );
    } finally {
      runPsql(
        liveDatabaseUrl,
        `drop database if exists ${quotedDatabaseName} with (force)`,
      );
    }
  },
);
