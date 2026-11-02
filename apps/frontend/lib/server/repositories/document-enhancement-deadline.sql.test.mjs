import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../../..");
const migration = readFileSync(path.join(root, "database/migrations/20261102140000_document_enhancement_deadline_failure.sql"), "utf8");
const expiryMigration = readFileSync(path.join(root, "database/migrations/20261102170000_enhancement_deadline_lease_expiry.sql"), "utf8");
const baseline = readFileSync(path.join(root, "database/schema.sql"), "utf8");
const url = process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL;
const LEASE = "22222222-2222-4222-8222-222222222222";

test("the baseline contains the exact ordered migration", () => {
  assert.ok(baseline.includes(migration));
  assert.ok(baseline.includes(expiryMigration));
});

test("postgres: the deadline transition is lease- and source-fenced and leaves the usable version untouched", { skip: !url, timeout: 180_000 }, () => {
  const name = `enhancement_deadline_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(url);
  target.pathname = `/${name}`;
  target.searchParams.delete("dbname");
  const run = (database, input) => spawnSync("psql", [database, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const sql = (input, database = target.toString()) => {
    const result = run(database, input);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  sql(`create database ${name};`, url);
  try {
    sql(`set client_min_messages = warning; set anbud.allow_destructive_schema_rebuild = on;\n${baseline}`);
    sql(migration); // An installation that already applied the original function.
    sql(expiryMigration);
    sql(expiryMigration); // The upgrade is rerunnable.

    const fixture = (overrides = {}) => {
      const project = randomUUID(), document = randomUUID(), job = randomUUID();
      const { status = "basic_ready", parser = "pdf-parse", kind = "document_docling_enhancement", jobStatus = "running", lease = LEASE } = overrides;
      sql(`
        insert into public.projects(id, client_name, title) values ('${project}', 'Fiktiv kunde', 'Fiktivt prosjekt');
        insert into public.documents(id, project_id, role, supporting_subtype, title, display_name, file_name, content_type, file_format, raw_text, processing_status, processing_message, parser_used, indexed_at)
          values ('${document}', '${project}', 'supporting_document', 'kravdokument', 'Bilag 1', 'Bilag 1', 'bilag.pdf', 'application/pdf', 'pdf', 'kryptert grunnversjon', '${status}', 'Docling-forbedring pågår', '${parser}', now());
        insert into public.project_jobs(id, project_id, kind, status, message, lease_token, locked_at, started_at)
          values ('${job}', '${project}', '${kind}', '${jobStatus}', 'Kjører', ${lease ? `'${lease}'` : "null"}, now(), now());
      `);
      return { project, document, job, revision: Number(sql(`select chunk_source_revision from public.documents where id='${document}'`)) };
    };
    const call = (item, overrides = {}) => {
      const { lease = LEASE, revision = item.revision, documentId = item.document } = overrides;
      return run(target.toString(), `set role service_role;
        select public.fail_document_enhancement_job('${item.job}', '${lease}', '${item.project}', '${documentId}', ${revision}, 'Jobben nådde totalfristen.', 'Jobben overskred totalfristen.', 'Grunnversjonen er lagret og kan brukes.', 'Dokumentforbedringen feilet.', '{}'::jsonb)::text;`);
    };
    const documentState = id => sql(`select to_jsonb(d) - 'updated_at' from public.documents d where id='${id}'`);
    const jobState = id => JSON.parse(sql(`select jsonb_build_object('status',status,'lease',lease_token,'locked',locked_at,'completed',completed_at is not null,'error',error,'message',message) from public.project_jobs where id='${id}'`));
    const projectRevision = id => sql(`select source_revision from public.projects where id='${id}'`);

    // The transition itself: both records change together, and only the outcome.
    const happy = fixture();
    sql(`insert into public.document_chunks(project_id, source_type, source_id, document_title, file_name, file_format, chunk_index, kind, text_encrypted, content_hash)
         select project_id, 'project_document', id, title, file_name, file_format, 0, 'paragraph', 'kryptert', 'hash' from public.documents where id='${happy.document}'`);
    const sourceBefore = projectRevision(happy.project);
    const documentBefore = JSON.parse(documentState(happy.document));
    const applied = call(happy);
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(JSON.parse(applied.stdout.trim()), { document_failure_recorded: true });
    const documentAfter = JSON.parse(documentState(happy.document));
    assert.equal(documentAfter.processing_error, "Dokumentforbedringen feilet.");
    assert.equal(documentAfter.processing_message, "Grunnversjonen er lagret og kan brukes.");
    for (const field of ["processing_status", "parser_used", "chunk_source_revision", "raw_text", "structure_map", "indexed_at", "file_base64"]) {
      assert.deepEqual(documentAfter[field], documentBefore[field], `${field} belongs to the usable version.`);
    }
    assert.equal(projectRevision(happy.project), sourceBefore, "Recording the outcome must not stale work based on this source.");
    assert.equal(sql(`select count(*) from public.document_chunks where source_id='${happy.document}'`), "1");
    const job = jobState(happy.job);
    assert.deepEqual([job.status, job.lease, job.locked, job.completed], ["failed", null, null, true]);
    assert.equal(sql(`select count(*) from public.audit_events where entity_id='${happy.job}'`), "1", "The terminal audit trigger still fires.");

    // The abandoned workflow's next write finds no lease.
    const late = run(target.toString(), `set role service_role; select public.lease_fenced_project_write('${happy.job}', '${LEASE}', '${happy.project}', 'document_processing_state', '{"document_id":"${happy.document}","status":"enhanced_ready","error":null,"updated_at":"2026-11-02T00:00:00Z"}'::jsonb);`);
    assert.notEqual(late.status, 0);
    assert.match(late.stderr, /PROJECT_JOB_LEASE_LOST/u);
    assert.equal(JSON.parse(documentState(happy.document)).processing_status, "basic_ready");
    const again = call(happy);
    assert.notEqual(again.status, 0, "A terminal job cannot transition twice.");
    assert.match(again.stderr, /PROJECT_JOB_LEASE_LOST/u);

    // A lost lease and a cancelled or taken-over job change nothing.
    const stolen = fixture();
    const stolenDocument = documentState(stolen.document);
    const refused = call(stolen, { lease: randomUUID() });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /PROJECT_JOB_LEASE_LOST/u);
    assert.equal(documentState(stolen.document), stolenDocument);
    assert.equal(jobState(stolen.job).status, "running");
    const queued = fixture({ jobStatus: "queued", lease: null });
    const queuedDocument = documentState(queued.document);
    assert.notEqual(call(queued).status, 0, "A requeued job has no holder.");
    assert.equal(documentState(queued.document), queuedDocument);

    // Recovery eligibility ends deadline authority even before recovery acquires
    // the row. Reject without a terminal audit or any job/document mutation.
    for (const lockedAt of ["clock_timestamp() - interval '16 minutes'", "null"]) {
      const expired = fixture();
      sql(`update public.project_jobs set locked_at=${lockedAt} where id='${expired.job}'`);
      const beforeDocument = sql(`select to_jsonb(d) from public.documents d where id='${expired.document}'`);
      const beforeJob = sql(`select to_jsonb(j) from public.project_jobs j where id='${expired.job}'`);
      const stale = call(expired);
      assert.notEqual(stale.status, 0, `A ${lockedAt} heartbeat must not authorize deadline failure.`);
      assert.match(stale.stderr, /PROJECT_JOB_LEASE_LOST/u);
      assert.equal(sql(`select to_jsonb(d) from public.documents d where id='${expired.document}'`), beforeDocument);
      assert.equal(sql(`select to_jsonb(j) from public.project_jobs j where id='${expired.job}'`), beforeJob);
      assert.equal(sql(`select count(*) from public.audit_events where entity_id='${expired.job}'`), "0");

      // Stale recovery can still requeue, and only a newly claimed lease may end it.
      sql(`update public.project_jobs set status='queued',locked_at=null,lease_token=null where id='${expired.job}'
        and status='running' and (locked_at is null or locked_at < clock_timestamp()-interval '15 minutes')`);
      assert.equal(jobState(expired.job).status, "queued");
      const replacementLease = randomUUID();
      sql(`update public.project_jobs set status='running',locked_at=clock_timestamp(),lease_token='${replacementLease}' where id='${expired.job}'`);
      assert.match(call(expired).stderr, /PROJECT_JOB_LEASE_LOST/u);
      const replacement = call(expired, { lease: replacementLease });
      assert.equal(replacement.status, 0, replacement.stderr);
      assert.deepEqual(JSON.parse(replacement.stdout.trim()), { document_failure_recorded: true });
    }

    const recent = fixture();
    sql(`update public.project_jobs set locked_at=clock_timestamp()-interval '14 minutes' where id='${recent.job}'`);
    assert.equal(call(recent).status, 0, "A matching recent lease remains authoritative.");

    // A newer source, a published enhancement or a document in another state keeps its own truth.
    for (const [label, setup, overrides] of [
      ["newer source", {}, { revisionDelta: 1 }],
      ["published enhancement", { status: "enhanced_ready", parser: "docling" }, {}],
      ["reprocessing document", { status: "processing" }, {}],
    ]) {
      const item = fixture(setup);
      const before = documentState(item.document);
      const result = call(item, { revision: item.revision + (overrides.revisionDelta ?? 0) });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { document_failure_recorded: false }, label);
      assert.equal(documentState(item.document), before, label);
      assert.equal(jobState(item.job).status, "failed", `${label}: the job still ends.`);
    }

    // Another project's document cannot be reached through this job.
    const owner = fixture(), foreign = fixture();
    const foreignBefore = documentState(foreign.document);
    const reached = call(owner, { documentId: foreign.document });
    assert.equal(reached.status, 0, reached.stderr);
    assert.deepEqual(JSON.parse(reached.stdout.trim()), { document_failure_recorded: false });
    assert.equal(documentState(foreign.document), foreignBefore);

    // Another job kind must not be able to mark a document failed.
    const other = fixture({ kind: "customer_analysis" });
    const otherDocument = documentState(other.document);
    const wrongKind = call(other);
    assert.notEqual(wrongKind.status, 0);
    assert.match(wrongKind.stderr, /Only a document enhancement job/u);
    assert.equal(documentState(other.document), otherDocument);
    assert.equal(jobState(other.job).status, "running");

    // Only the service role may call it.
    for (const role of ["anon", "authenticated"]) {
      assert.equal(sql(`select has_function_privilege('${role}', 'public.fail_document_enhancement_job(uuid,uuid,uuid,uuid,bigint,text,text,text,text,jsonb)', 'execute')`), "f");
    }
    assert.equal(sql(`select has_function_privilege('service_role', 'public.fail_document_enhancement_job(uuid,uuid,uuid,uuid,bigint,text,text,text,text,jsonb)', 'execute')`), "t");

    // A destructive reset of the same database keeps ownership of the partial previews and this function.
    sql(`set client_min_messages = warning; set anbud.allow_destructive_schema_rebuild = on;\n${baseline}`);
    assert.equal(sql(`select to_regprocedure('public.fail_document_enhancement_job(uuid,uuid,uuid,uuid,bigint,text,text,text,text,jsonb)') is not null`), "t");
    const resetExpired = fixture();
    sql(`update public.project_jobs set locked_at=null where id='${resetExpired.job}'`);
    assert.match(call(resetExpired).stderr, /PROJECT_JOB_LEASE_LOST/u, "The fresh baseline also installs the expiry guard.");
  } finally {
    sql(`drop database ${name} with (force);`, url);
  }
});
