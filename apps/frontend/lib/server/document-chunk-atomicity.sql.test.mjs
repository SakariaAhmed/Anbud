import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const migrationPath = path.join(
  repositoryRoot,
  "supabase/migrations/20260711140000_atomic_document_chunk_replacement.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const documentChunksSource = readFileSync(
  path.join(repositoryRoot, "apps/frontend/lib/server/document-chunks.ts"),
  "utf8",
);
const supabaseStoreSource = readFileSync(
  path.join(
    repositoryRoot,
    "apps/frontend/lib/server/repositories/supabase-store.ts",
  ),
  "utf8",
);

function sqlFunction(sql, name) {
  return [
    ...sql.matchAll(
      new RegExp(
        `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
        "gu",
      ),
    ),
  ].at(-1)?.[0];
}

test("chunk replacement and completeness are single-RPC, full-set contracts", () => {
  const atomicReplacement = sqlFunction(
    migrationSql,
    "replace_document_chunks_atomic",
  );
  const completeness = sqlFunction(
    migrationSql,
    "document_chunks_are_complete",
  );
  assert.ok(atomicReplacement, "atomic replacement RPC is missing");
  assert.ok(completeness, "chunk completeness RPC is missing");

  assert.ok(
    atomicReplacement.indexOf("delete from public.document_chunks") <
      atomicReplacement.indexOf("insert into public.document_chunks"),
    "replacement must delete and insert in one database function",
  );
  assert.match(
    atomicReplacement,
    /jsonb_array_length\(p_rows\) <> p_expected_chunk_count/u,
  );
  assert.match(
    atomicReplacement,
    /count\(distinct \(payload\.row_json ->> 'chunk_index'\)::integer\)/u,
  );
  assert.match(
    atomicReplacement,
    /v_min_index <> 0 or v_max_index <> p_expected_chunk_count - 1/u,
  );
  assert.equal(atomicReplacement.match(/for key share/gu)?.length, 2);
  assert.equal(atomicReplacement.match(/for update nowait/gu)?.length, 2);
  assert.match(atomicReplacement, /chunk_source_revision/u);
  assert.match(
    atomicReplacement,
    /get diagnostics v_inserted_count = row_count/u,
  );

  assert.match(completeness, /count\(\*\) = p_expected_chunk_count/u);
  assert.match(
    completeness,
    /count\(distinct chunk\.chunk_index\) = p_expected_chunk_count/u,
  );
  assert.match(completeness, /min\(chunk\.chunk_index\) = 0/u);
  assert.match(
    completeness,
    /max\(chunk\.chunk_index\) = p_expected_chunk_count - 1/u,
  );
  assert.equal(
    completeness.match(/bool_and\(\s*coalesce\(/gu)?.length,
    2,
    "NULL-invalid rows must fail both full-set predicates",
  );
  assert.match(
    completeness,
    /chunk\.metadata ->> 'source_fingerprint' = p_source_fingerprint/u,
  );
  assert.match(completeness, /embedding_retry_after/u);
  assert.match(completeness, /p_source_type is null/u);
  assert.match(completeness, /p_expected_source_revision/u);
  assert.match(migrationSql, /documents_chunk_source_revision/u);
  assert.match(migrationSql, /service_documents_chunk_source_revision/u);

  const leasedWrite = sqlFunction(migrationSql, "lease_fenced_project_write");
  assert.ok(leasedWrite, "final lease-fenced wrapper is missing from 1400");
  assert.ok(
    leasedWrite.indexOf("from public.projects") <
      leasedWrite.indexOf("from public.project_jobs"),
    "project parent must be fenced before the job child",
  );
  assert.match(
    leasedWrite,
    /from public\.projects[\s\S]*?for no key update/u,
    "the wrapper must take its final project-update lock mode up front",
  );
  assert.match(leasedWrite, /public\.replace_document_chunks_atomic\(/u);
  assert.doesNotMatch(
    leasedWrite.match(
      /elsif p_operation = 'replace_document_chunks' then(?<branch>[\s\S]*?)\n  end if;/u,
    )?.groups?.branch ?? "",
    /insert into public\.document_chunks/u,
  );

  for (const relativePath of [
    "supabase/schema.sql",
    "supabase/document_chunks_and_embeddings.sql",
    "supabase/project_jobs_durable_execution.sql",
  ]) {
    const canonicalSql = readFileSync(
      path.join(repositoryRoot, relativePath),
      "utf8",
    );
    for (const functionName of [
      "replace_document_chunks_atomic",
      "document_chunks_are_complete",
    ]) {
      assert.equal(
        sqlFunction(canonicalSql, functionName),
        sqlFunction(migrationSql, functionName),
        `${relativePath} has drifted for ${functionName}`,
      );
    }
    if (relativePath !== "supabase/document_chunks_and_embeddings.sql") {
      assert.equal(
        sqlFunction(canonicalSql, "lease_fenced_project_write"),
        leasedWrite,
        `${relativePath} has drifted for lease_fenced_project_write`,
      );
    }
  }

  assert.match(
    documentChunksSource,
    /supabase\.rpc\("replace_document_chunks_atomic"/u,
  );
  assert.match(
    documentChunksSource,
    /supabase\.rpc\("document_chunks_are_complete"/u,
  );
  const replacementBody = documentChunksSource.match(
    /async function replaceDocumentChunks\([\s\S]*?\n\}\n\nasync function hasCompleteExistingDocumentChunks/u,
  )?.[0];
  assert.ok(replacementBody, "replaceDocumentChunks body is missing");
  assert.doesNotMatch(
    replacementBody,
    /\.from\("document_chunks"\)\s*\.delete\(\)/u,
  );
  assert.doesNotMatch(
    replacementBody,
    /\.from\("document_chunks"\)\s*\.insert\(/u,
  );
  const ingestionSave = supabaseStoreSource.match(
    /export async function saveDocumentIngestionResult\([\s\S]*?\n\}\n\nexport async function getDocumentDetail/u,
  )?.[0];
  assert.ok(ingestionSave, "saveDocumentIngestionResult body is missing");
  assert.match(ingestionSave, /sourceRevision: updated\.chunk_source_revision/u);
  assert.match(ingestionSave, /role: updated\.role/u);
  assert.match(ingestionSave, /title: updated\.title/u);
  assert.match(ingestionSave, /status: "failed"/u);
  assert.match(ingestionSave, /indexedAt: null/u);
  assert.match(ingestionSave, /throw new Error\(`Dokumentindeksering feilet:/u);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPsqlSucceeded(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed:\n${result.stderr || result.stdout}`,
  );
}

function chunkRows({
  fingerprint,
  count = 3,
  invalidKindAt = -1,
  sourceType = "project_document",
  sourceId = "00000000-0000-4000-8000-000000000011",
  parentId = "00000000-0000-4000-8000-000000000001",
}) {
  return Array.from({ length: count }, (_, index) => {
    const contentHash = `${index + 1}`.repeat(64).slice(0, 64);
    return {
      source_type: sourceType,
      source_id: sourceId,
      project_id: sourceType === "project_document" ? parentId : null,
      service_id: sourceType === "service_document" ? parentId : null,
      document_title:
        sourceType === "service_document" ? "Tjenestedokument" : "Kravdokument",
      file_name: sourceType === "service_document" ? "service.txt" : "krav.txt",
      file_format: "txt",
      role:
        sourceType === "service_document" ? null : "primary_customer_document",
      supporting_subtype: null,
      chunk_index: index,
      kind: index === invalidKindAt ? "not-a-kind" : "requirement",
      reference: `K-${index + 1}`,
      heading_path: [],
      page_start: null,
      page_end: null,
      token_count: 4,
      text_encrypted: `encrypted-${index}`,
      content_hash: contentHash,
      metadata: {
        content_hash: contentHash,
        source_fingerprint: fingerprint,
        source_fingerprint_version: 1,
      },
      embedding: null,
      embedding_model: null,
      embedding_created_at: null,
      search_text: `krav ${index + 1}`,
    };
  });
}

function replaceSql(
  fingerprint,
  rows,
  expectedCount = rows.length,
  sourceRevision = 0,
) {
  const sourceType = rows[0]?.source_type ?? "project_document";
  const sourceId =
    rows[0]?.source_id ?? "00000000-0000-4000-8000-000000000011";
  return `select public.replace_document_chunks_atomic(
    '${sourceType}',
    '${sourceId}',
    '${fingerprint}',
    ${sourceRevision},
    ${expectedCount},
    $payload$${JSON.stringify(rows)}$payload$::jsonb
  );`;
}

function completenessSql(
  fingerprint,
  expectedCount,
  embeddingModel = "null",
  sourceRevision = 0,
) {
  return `select public.document_chunks_are_complete(
    'project_document',
    '00000000-0000-4000-8000-000000000011',
    '${fingerprint}',
    ${sourceRevision},
    ${expectedCount},
    ${embeddingModel},
    '2026-07-11T08:00:00.000Z'::timestamptz
  );`;
}

function leasedReplaceSql({
  fingerprint,
  rows,
  sourceRevision = 0,
  projectId = "00000000-0000-4000-8000-000000000001",
  jobId = "00000000-0000-4000-8000-000000000031",
  leaseToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}) {
  const payload = {
    source_type: rows[0]?.source_type ?? "project_document",
    source_id:
      rows[0]?.source_id ?? "00000000-0000-4000-8000-000000000011",
    source_fingerprint: fingerprint,
    expected_source_revision: sourceRevision,
    expected_chunk_count: rows.length,
    rows,
  };
  return `select public.lease_fenced_project_write(
    '${jobId}',
    '${leaseToken}',
    '${projectId}',
    'replace_document_chunks',
    $payload$${JSON.stringify(payload)}$payload$::jsonb
  ) ->> 'count';`;
}

const liveDatabaseUrl = process.env.DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL;

test(
  "postgres: replacement rolls back and completeness rejects every truncated or NULL-invalid set",
  { skip: !liveDatabaseUrl, timeout: 30_000 },
  async () => {
    const databaseName = `anbud_chunk_atomic_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = new URL(liveDatabaseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const quotedDatabaseName = `"${databaseName}"`;
    const oldFingerprint = "a".repeat(64);
    const newFingerprint = "b".repeat(64);

    assertPsqlSucceeded(
      runPsql(liveDatabaseUrl, `create database ${quotedDatabaseName}`),
      "create disposable database",
    );

    try {
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            create schema extensions;
            create extension vector with schema extensions;
            create table public.projects (
              id uuid primary key,
              touched integer not null default 0,
              context_keywords text[] not null default '{}'
            );
            create table public.documents (
              id uuid primary key,
              project_id uuid not null references public.projects(id) on delete cascade,
              role text not null default 'primary_customer_document',
              supporting_subtype text,
              title text not null default 'Kravdokument',
              file_name text not null default 'krav.txt',
              file_format text not null default 'txt',
              raw_text text not null default 'Krav',
              structure_map jsonb not null default '[]'::jsonb,
              updated_at timestamptz not null default '2026-07-11T08:00:00Z'
            );
            create table public.service_descriptions (id uuid primary key);
            create table public.service_documents (
              id uuid primary key,
              service_id uuid not null references public.service_descriptions(id) on delete cascade,
              title text not null default 'Tjenestedokument',
              file_name text not null default 'service.txt',
              file_format text not null default 'txt',
              raw_text text not null default 'Tjeneste',
              structure_map jsonb not null default '[]'::jsonb,
              updated_at timestamptz not null default '2026-07-11T08:00:00Z'
            );
            create table public.customer_analyses (id uuid);
            create table public.solution_evaluations (id uuid);
            create table public.executive_summaries (id uuid);
            create table public.generated_artifacts (id uuid);
            create table public.project_jobs (
              id uuid primary key,
              project_id uuid not null references public.projects(id) on delete cascade,
              status text not null,
              lease_token uuid
            );
            create table public.document_chunks (
              id uuid primary key default gen_random_uuid(),
              source_type text not null,
              source_id uuid not null,
              project_id uuid references public.projects(id) on delete cascade,
              service_id uuid references public.service_descriptions(id) on delete cascade,
              document_title text not null,
              file_name text not null,
              file_format text not null,
              role text,
              supporting_subtype text,
              chunk_index integer not null,
              kind text not null check (kind in ('requirement')),
              reference text not null,
              heading_path text[] not null,
              page_start integer,
              page_end integer,
              token_count integer not null,
              text_encrypted text not null,
              fts tsvector not null default ''::tsvector,
              content_hash text not null,
              metadata jsonb not null,
              embedding extensions.vector(1536),
              embedding_model text,
              embedding_created_at timestamptz,
              unique (source_type, source_id, chunk_index)
            );
            insert into public.projects(id)
            values ('00000000-0000-4000-8000-000000000001');
            insert into public.service_descriptions(id)
            values ('00000000-0000-4000-8000-000000000002');
            insert into public.documents(id, project_id)
            values (
              '00000000-0000-4000-8000-000000000011',
              '00000000-0000-4000-8000-000000000001'
            );
            insert into public.service_documents(id, service_id)
            values (
              '00000000-0000-4000-8000-000000000021',
              '00000000-0000-4000-8000-000000000002'
            );
            insert into public.project_jobs(id, project_id, status, lease_token)
            values (
              '00000000-0000-4000-8000-000000000031',
              '00000000-0000-4000-8000-000000000001',
              'running',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            );
          `,
        ),
        "create SQL fixture",
      );
      assertPsqlSucceeded(
        runPsqlFile(databaseUrl.toString(), migrationPath),
        "apply atomic chunk migration",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            create or replace function public.test_delete_project_document_chunks()
            returns trigger language plpgsql as $$
            begin
              delete from public.document_chunks
              where source_type = 'project_document' and source_id = old.id;
              return old;
            end $$;
            create trigger test_documents_delete_chunks
            after delete on public.documents for each row
            execute function public.test_delete_project_document_chunks();

            create or replace function public.test_delete_service_document_chunks()
            returns trigger language plpgsql as $$
            begin
              delete from public.document_chunks
              where source_type = 'service_document' and source_id = old.id;
              update public.projects set touched = touched + 1;
              return old;
            end $$;
            create trigger test_service_documents_delete_chunks
            after delete on public.service_documents for each row
            execute function public.test_delete_service_document_chunks();

            create or replace function public.test_slow_chunk_insert()
            returns trigger language plpgsql as $$
            begin
              if current_setting('anbud.slow_chunk_insert', true) = 'on' then
                perform pg_sleep(0.35);
              end if;
              return new;
            end $$;
            create trigger test_document_chunks_slow_insert
            before insert on public.document_chunks for each row
            execute function public.test_slow_chunk_insert();
          `,
        ),
        "install concurrency probes",
      );

      const validRows = chunkRows({ fingerprint: newFingerprint });
      const oldRows = chunkRows({ fingerprint: oldFingerprint, count: 2 });
      assertPsqlSucceeded(
        runPsql(databaseUrl.toString(), replaceSql(oldFingerprint, oldRows)),
        "seed old chunk set",
      );

      const failedReplacement = runPsql(
        databaseUrl.toString(),
        replaceSql(
          newFingerprint,
          chunkRows({ fingerprint: newFingerprint, invalidKindAt: 1 }),
        ),
      );
      assert.notEqual(failedReplacement.status, 0);
      assert.match(failedReplacement.stderr, /document_chunks_kind_check|check constraint/u);

      const preserved = runPsql(
        databaseUrl.toString(),
        `select count(*) || ':' || min(metadata ->> 'source_fingerprint')
         from public.document_chunks;`,
      );
      assertPsqlSucceeded(preserved, "read rollback-preserved chunks");
      assert.equal(preserved.stdout.trim(), `2:${oldFingerprint}`);

      const replaced = runPsql(
        databaseUrl.toString(),
        replaceSql(newFingerprint, validRows),
      );
      assertPsqlSucceeded(replaced, "replace complete chunk set");
      assert.equal(replaced.stdout.trim(), "3");
      const complete = runPsql(
        databaseUrl.toString(),
        completenessSql(newFingerprint, 3),
      );
      assertPsqlSucceeded(complete, "verify complete chunk set");
      assert.equal(complete.stdout.trim(), "t");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.document_chunks
           set metadata = metadata - 'source_fingerprint'
           where chunk_index = 1;`,
        ),
        "remove one row fingerprint",
      );
      const nullInvalidManifest = runPsql(
        databaseUrl.toString(),
        completenessSql(newFingerprint, 3),
      );
      assertPsqlSucceeded(nullInvalidManifest, "verify NULL-invalid manifest");
      assert.equal(nullInvalidManifest.stdout.trim(), "f");

      assertPsqlSucceeded(
        runPsql(databaseUrl.toString(), replaceSql(newFingerprint, validRows)),
        "restore complete chunk set",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.document_chunks
           set metadata = jsonb_set(
             metadata,
             '{embedding_retry_after}',
             to_jsonb('2026-07-11T09:00:00.000Z'::text)
           );`,
        ),
        "defer embedding retries",
      );
      const deferred = runPsql(
        databaseUrl.toString(),
        completenessSql(newFingerprint, 3, "'text-embedding-3-small'"),
      );
      assertPsqlSucceeded(deferred, "verify all embedding retries deferred");
      assert.equal(deferred.stdout.trim(), "t");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.document_chunks
           set metadata = metadata - 'embedding_retry_after'
           where chunk_index = 1;`,
        ),
        "remove one embedding retry timestamp",
      );
      const nullInvalidEmbedding = runPsql(
        databaseUrl.toString(),
        completenessSql(newFingerprint, 3, "'text-embedding-3-small'"),
      );
      assertPsqlSucceeded(nullInvalidEmbedding, "verify NULL-invalid embedding row");
      assert.equal(nullInvalidEmbedding.stdout.trim(), "f");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          "delete from public.document_chunks where chunk_index = 2;",
        ),
        "truncate one chunk",
      );
      const truncated = runPsql(
        databaseUrl.toString(),
        completenessSql(newFingerprint, 3),
      );
      assertPsqlSucceeded(truncated, "verify truncated chunk set");
      assert.equal(truncated.stdout.trim(), "f");

      const nullSourceType = runPsql(
        databaseUrl.toString(),
        `select public.document_chunks_are_complete(
          null,
          '00000000-0000-4000-8000-000000000021',
          '${newFingerprint}',
          0,
          0,
          null,
          now()
        );`,
      );
      assertPsqlSucceeded(nullSourceType, "reject NULL source type");
      assert.equal(nullSourceType.stdout.trim(), "f");

      assertPsqlSucceeded(
        runPsql(databaseUrl.toString(), replaceSql(newFingerprint, validRows)),
        "restore rows before source revision race",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.documents
           set role = 'supporting_document'
           where id = '00000000-0000-4000-8000-000000000011';`,
        ),
        "demote source role",
      );
      const sourceRevision = runPsql(
        databaseUrl.toString(),
        `select chunk_source_revision
         from public.documents
         where id = '00000000-0000-4000-8000-000000000011';`,
      );
      assertPsqlSucceeded(sourceRevision, "read bumped source revision");
      assert.equal(sourceRevision.stdout.trim(), "1");
      const staleCompleteness = runPsql(
        databaseUrl.toString(),
        completenessSql(newFingerprint, 3, "null", 0),
      );
      assertPsqlSucceeded(staleCompleteness, "reject stale completeness snapshot");
      assert.equal(staleCompleteness.stdout.trim(), "f");
      const staleReplacement = runPsql(
        databaseUrl.toString(),
        replaceSql("c".repeat(64), chunkRows({ fingerprint: "c".repeat(64) }), 3, 0),
      );
      assert.notEqual(staleReplacement.status, 0);
      assert.match(staleReplacement.stderr, /source changed/u);

      const leaseFingerprint = "d".repeat(64);
      const leaseRows = chunkRows({
        fingerprint: leaseFingerprint,
        count: 2,
      }).map((row) => ({ ...row, role: "supporting_document" }));
      const filteredLeaseRows = [
        leaseRows[0],
        { ...leaseRows[1], source_type: "service_document", project_id: null },
      ];
      const partialLease = runPsql(
        databaseUrl.toString(),
        leasedReplaceSql({
          fingerprint: leaseFingerprint,
          rows: filteredLeaseRows,
          sourceRevision: 1,
        }),
      );
      assert.notEqual(partialLease.status, 0);
      const preservedAfterLeaseFailure = runPsql(
        databaseUrl.toString(),
        `select count(*) || ':' || min(metadata ->> 'source_fingerprint')
         from public.document_chunks
         where source_type = 'project_document'
           and source_id = '00000000-0000-4000-8000-000000000011';`,
      );
      assertPsqlSucceeded(
        preservedAfterLeaseFailure,
        "verify leased partial payload rollback",
      );
      assert.equal(
        preservedAfterLeaseFailure.stdout.trim(),
        `3:${newFingerprint}`,
      );
      const validLease = runPsql(
        databaseUrl.toString(),
        leasedReplaceSql({
          fingerprint: leaseFingerprint,
          rows: leaseRows,
          sourceRevision: 1,
        }),
      );
      assertPsqlSucceeded(validLease, "persist exact leased chunk set");
      assert.equal(validLease.stdout.trim(), "2");

      const concurrencyFingerprint = "e".repeat(64);
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            insert into public.projects(id) values
              ('00000000-0000-4000-8000-000000000101'),
              ('00000000-0000-4000-8000-000000000201'),
              ('00000000-0000-4000-8000-000000000301'),
              ('00000000-0000-4000-8000-000000000401'),
              ('00000000-0000-4000-8000-000000000501'),
              ('00000000-0000-4000-8000-000000000601'),
              ('00000000-0000-4000-8000-000000000701');
            insert into public.documents(id, project_id) values
              ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101'),
              ('00000000-0000-4000-8000-000000000311', '00000000-0000-4000-8000-000000000301'),
              ('00000000-0000-4000-8000-000000000511', '00000000-0000-4000-8000-000000000501'),
              ('00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000701'),
              ('00000000-0000-4000-8000-000000000712', '00000000-0000-4000-8000-000000000701');
            insert into public.service_descriptions(id) values
              ('00000000-0000-4000-8000-000000000202'),
              ('00000000-0000-4000-8000-000000000402');
            insert into public.service_documents(id, service_id) values
              ('00000000-0000-4000-8000-000000000221', '00000000-0000-4000-8000-000000000202'),
              ('00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000402');
            insert into public.project_jobs(id, project_id, status, lease_token) values
              ('00000000-0000-4000-8000-000000000131', '00000000-0000-4000-8000-000000000101', 'running', '11111111-1111-4111-8111-111111111111'),
              ('00000000-0000-4000-8000-000000000231', '00000000-0000-4000-8000-000000000201', 'running', '22222222-2222-4222-8222-222222222222'),
              ('00000000-0000-4000-8000-000000000331', '00000000-0000-4000-8000-000000000301', 'running', '33333333-3333-4333-8333-333333333333'),
              ('00000000-0000-4000-8000-000000000431', '00000000-0000-4000-8000-000000000401', 'running', '44444444-4444-4444-8444-444444444444'),
              ('00000000-0000-4000-8000-000000000631', '00000000-0000-4000-8000-000000000601', 'running', '66666666-6666-4666-8666-666666666666'),
              ('00000000-0000-4000-8000-000000000731', '00000000-0000-4000-8000-000000000701', 'running', '77777777-7777-4777-8777-777777777777'),
              ('00000000-0000-4000-8000-000000000732', '00000000-0000-4000-8000-000000000701', 'running', '88888888-8888-4888-8888-888888888888');
          `,
        ),
        "create concurrency fixtures",
      );

      const projectParentRows = chunkRows({
        fingerprint: concurrencyFingerprint,
        count: 2,
        sourceId: "00000000-0000-4000-8000-000000000111",
        parentId: "00000000-0000-4000-8000-000000000101",
      });
      const projectParentReplace = runPsqlAsync(
        databaseUrl.toString(),
        `begin; select set_config('anbud.slow_chunk_insert', 'on', true); ${leasedReplaceSql({
          fingerprint: concurrencyFingerprint,
          rows: projectParentRows,
          projectId: "00000000-0000-4000-8000-000000000101",
          jobId: "00000000-0000-4000-8000-000000000131",
          leaseToken: "11111111-1111-4111-8111-111111111111",
        })} commit;`,
      );
      await delay(80);
      const projectParentDelete = runPsqlAsync(
        databaseUrl.toString(),
        "delete from public.projects where id = '00000000-0000-4000-8000-000000000101';",
      );
      for (const [result, label] of [
        [await projectParentReplace, "leased replacement vs project DELETE"],
        [await projectParentDelete, "project DELETE vs leased replacement"],
      ]) {
        assertPsqlSucceeded(result, label);
      }

      const serviceParentRows = chunkRows({
        fingerprint: concurrencyFingerprint,
        count: 2,
        sourceType: "service_document",
        sourceId: "00000000-0000-4000-8000-000000000221",
        parentId: "00000000-0000-4000-8000-000000000202",
      });
      const serviceParentReplace = runPsqlAsync(
        databaseUrl.toString(),
        `begin; select set_config('anbud.slow_chunk_insert', 'on', true); ${leasedReplaceSql({
          fingerprint: concurrencyFingerprint,
          rows: serviceParentRows,
          projectId: "00000000-0000-4000-8000-000000000201",
          jobId: "00000000-0000-4000-8000-000000000231",
          leaseToken: "22222222-2222-4222-8222-222222222222",
        })} commit;`,
      );
      await delay(80);
      const serviceParentDelete = runPsqlAsync(
        databaseUrl.toString(),
        "delete from public.service_descriptions where id = '00000000-0000-4000-8000-000000000202';",
      );
      for (const [result, label] of [
        [await serviceParentReplace, "leased replacement vs service DELETE"],
        [await serviceParentDelete, "service DELETE vs leased replacement"],
      ]) {
        assertPsqlSucceeded(result, label);
      }

      const projectChildDelete = runPsqlAsync(
        databaseUrl.toString(),
        "begin; delete from public.documents where id = '00000000-0000-4000-8000-000000000311'; select pg_sleep(0.35); commit;",
      );
      await delay(80);
      const projectChildRows = chunkRows({
        fingerprint: concurrencyFingerprint,
        sourceId: "00000000-0000-4000-8000-000000000311",
        parentId: "00000000-0000-4000-8000-000000000301",
      });
      const projectChildReplace = await runPsqlAsync(
        databaseUrl.toString(),
        leasedReplaceSql({
          fingerprint: concurrencyFingerprint,
          rows: projectChildRows,
          projectId: "00000000-0000-4000-8000-000000000301",
          jobId: "00000000-0000-4000-8000-000000000331",
          leaseToken: "33333333-3333-4333-8333-333333333333",
        }),
      );
      assert.notEqual(projectChildReplace.status, 0);
      assert.match(projectChildReplace.stderr, /could not obtain lock|source changed/u);
      assertPsqlSucceeded(await projectChildDelete, "direct project document DELETE");

      const serviceChildDelete = runPsqlAsync(
        databaseUrl.toString(),
        "begin; delete from public.service_documents where id = '00000000-0000-4000-8000-000000000421'; select pg_sleep(0.35); commit;",
      );
      await delay(80);
      const serviceChildRows = chunkRows({
        fingerprint: concurrencyFingerprint,
        sourceType: "service_document",
        sourceId: "00000000-0000-4000-8000-000000000421",
        parentId: "00000000-0000-4000-8000-000000000402",
      });
      const serviceChildReplace = await runPsqlAsync(
        databaseUrl.toString(),
        leasedReplaceSql({
          fingerprint: concurrencyFingerprint,
          rows: serviceChildRows,
          projectId: "00000000-0000-4000-8000-000000000401",
          jobId: "00000000-0000-4000-8000-000000000431",
          leaseToken: "44444444-4444-4444-8444-444444444444",
        }),
      );
      assert.notEqual(serviceChildReplace.status, 0);
      assert.match(serviceChildReplace.stderr, /could not obtain lock|source changed/u);
      assertPsqlSucceeded(await serviceChildDelete, "direct service document DELETE");

      const roleRaceRows = chunkRows({
        fingerprint: concurrencyFingerprint,
        sourceId: "00000000-0000-4000-8000-000000000511",
        parentId: "00000000-0000-4000-8000-000000000501",
      });
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          replaceSql(concurrencyFingerprint, roleRaceRows),
        ),
        "seed role-race chunks",
      );
      const roleDemotion = runPsqlAsync(
        databaseUrl.toString(),
        "begin; update public.documents set role = 'supporting_document' where id = '00000000-0000-4000-8000-000000000511'; select pg_sleep(0.35); commit;",
      );
      await delay(80);
      const duringRoleRace = runPsql(
        databaseUrl.toString(),
        replaceSql(concurrencyFingerprint, roleRaceRows, roleRaceRows.length, 0),
      );
      assert.notEqual(duringRoleRace.status, 0);
      assert.match(duringRoleRace.stderr, /could not obtain lock/u);
      assertPsqlSucceeded(await roleDemotion, "concurrent primary-role demotion");
      const afterRoleRace = runPsql(
        databaseUrl.toString(),
        replaceSql(concurrencyFingerprint, roleRaceRows, roleRaceRows.length, 0),
      );
      assert.notEqual(afterRoleRace.status, 0);
      assert.match(afterRoleRace.stderr, /source changed/u);

      const blockedJob = runPsqlAsync(
        databaseUrl.toString(),
        `begin;
         set local statement_timeout = '5s';
         select id from public.project_jobs
         where id = '00000000-0000-4000-8000-000000000631'
         for update;
         select pg_sleep(0.45);
         commit;`,
      );
      await delay(75);
      const queuedProjectUpdate = runPsqlAsync(
        databaseUrl.toString(),
        `set deadlock_timeout = '100ms';
         set statement_timeout = '5s';
         select public.lease_fenced_project_write(
           '00000000-0000-4000-8000-000000000631',
           '66666666-6666-4666-8666-666666666666',
           '00000000-0000-4000-8000-000000000601',
           'project_context_keywords',
           '{"context_keywords":["queued-updater-safe"]}'::jsonb
         );`,
      );
      await delay(75);
      const deleteDuringQueuedUpdate = runPsqlAsync(
        databaseUrl.toString(),
        `set deadlock_timeout = '100ms';
         set statement_timeout = '5s';
         delete from public.projects
         where id = '00000000-0000-4000-8000-000000000601';`,
      );
      assertPsqlSucceeded(await blockedJob, "release blocked project job");
      assertPsqlSucceeded(
        await queuedProjectUpdate,
        "lease write with queued project DELETE",
      );
      assertPsqlSucceeded(
        await deleteDuringQueuedUpdate,
        "queued project DELETE after lease write",
      );

      const distinctFingerprint = "f".repeat(64);
      const distinctRowsA = chunkRows({
        fingerprint: distinctFingerprint,
        count: 2,
        sourceId: "00000000-0000-4000-8000-000000000711",
        parentId: "00000000-0000-4000-8000-000000000701",
      });
      const distinctRowsB = chunkRows({
        fingerprint: distinctFingerprint,
        count: 2,
        sourceId: "00000000-0000-4000-8000-000000000712",
        parentId: "00000000-0000-4000-8000-000000000701",
      });
      const firstDistinctReplacement = runPsqlAsync(
        databaseUrl.toString(),
        `begin;
         select set_config('anbud.slow_chunk_insert', 'on', true);
         ${leasedReplaceSql({
           fingerprint: distinctFingerprint,
           rows: distinctRowsA,
           projectId: "00000000-0000-4000-8000-000000000701",
           jobId: "00000000-0000-4000-8000-000000000731",
           leaseToken: "77777777-7777-4777-8777-777777777777",
         })}
         commit;`,
      );
      await delay(75);
      const secondDistinctReplacement = runPsqlAsync(
        databaseUrl.toString(),
        leasedReplaceSql({
          fingerprint: distinctFingerprint,
          rows: distinctRowsB,
          projectId: "00000000-0000-4000-8000-000000000701",
          jobId: "00000000-0000-4000-8000-000000000732",
          leaseToken: "88888888-8888-4888-8888-888888888888",
        }),
      );
      for (const [result, label] of [
        [await firstDistinctReplacement, "first distinct chunk replacement"],
        [await secondDistinctReplacement, "second distinct chunk replacement"],
      ]) {
        assertPsqlSucceeded(result, label);
      }
      const distinctChunkSets = runPsql(
        databaseUrl.toString(),
        `select source_id || ':' || count(*) || ':' ||
                min(metadata ->> 'source_fingerprint')
         from public.document_chunks
         where source_id in (
           '00000000-0000-4000-8000-000000000711',
           '00000000-0000-4000-8000-000000000712'
         )
         group by source_id
         order by source_id;`,
      );
      assertPsqlSucceeded(distinctChunkSets, "verify distinct chunk sets");
      assert.deepEqual(distinctChunkSets.stdout.trim().split("\n"), [
        `00000000-0000-4000-8000-000000000711:2:${distinctFingerprint}`,
        `00000000-0000-4000-8000-000000000712:2:${distinctFingerprint}`,
      ]);

      const privileges = runPsql(
        databaseUrl.toString(),
        `select
           has_function_privilege(
             'anon',
             'public.replace_document_chunks_atomic(text,uuid,text,bigint,integer,jsonb)',
             'execute'
           ) || ':' ||
           has_function_privilege(
             'authenticated',
             'public.document_chunks_are_complete(text,uuid,text,bigint,integer,text,timestamptz)',
             'execute'
           ) || ':' ||
           has_function_privilege(
             'service_role',
             'public.replace_document_chunks_atomic(text,uuid,text,bigint,integer,jsonb)',
             'execute'
           );`,
      );
      assertPsqlSucceeded(privileges, "verify RPC privileges");
      assert.equal(privileges.stdout.trim(), "false:false:true");
    } finally {
      const dropped = runPsql(
        liveDatabaseUrl,
        `drop database if exists ${quotedDatabaseName} with (force)`,
      );
      assertPsqlSucceeded(dropped, "drop disposable database");
    }
  },
);
