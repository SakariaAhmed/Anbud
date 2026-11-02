import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");
const support = path.join(import.meta.dirname, "data-store.persistence.test-support.ts");
const load = createJiti(import.meta.url, { alias: {
  "@": frontend, "server-only": "/dev/null", "next/cache": support,
  "@/lib/server/data-api": support, "@/lib/server/document-chunks": support,
} });
// Only transport/cache are replaced. Save, encryption, lease fencing, SQL
// functions/triggers, current-snapshot mapping and history decryption are real.
const { saveSolutionEvaluation, getFreshSolutionEvaluation, getProjectResultHistory } = load("./data-store.ts");
const { setPostgRESTStorePersistenceTestClient } = load(support);
const { runWithProjectWorkflowContext } = load("../project-workflow-cancellation.ts");
const { normalizeCriterionCoverage, reconcileCriterionCoverage } = load("../ai/criterion-coverage.ts");
const { projectFollowUpItems } = load("../../project-follow-up.ts");
const { encryptJson } = load("../crypto.ts");
const admin = process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL;
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
function psql(url, sql) {
  const result = spawnSync("psql", [url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 24e6 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("postgres: criterion scope and original/answer evidence survive encrypted fenced save, history and reload; edits invalidate active coverage", { skip: !admin, timeout: 60_000 }, async () => {
  const databaseName = `criterion_coverage_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(admin);
  target.pathname = `/${databaseName}`;
  const database = target.toString();
  psql(admin, `create database ${databaseName}`);
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY ||= "criterion-coverage-disposable-test-key";
  try {
    psql(database, "set anbud.allow_destructive_schema_rebuild = on;\n" + readFileSync(path.resolve(frontend, "../../database/schema.sql"), "utf8"));
    const projectId = randomUUID(), customerId = randomUUID(), solutionId = randomUUID(), jobId = randomUUID(), leaseToken = randomUUID();
    const criterion = "Kvalitet på overgangsplan";
    const original = `Tildelingskriterium: ${criterion}`;
    const answer = "Overgangen har tre milepæler med godkjenning fra kunden.";
    psql(database, `insert into projects(id,client_name,title) values(${literal(projectId)},'Syntetisk','Kriteriebevis');
      insert into documents(id,project_id,role,raw_text) values
      (${literal(customerId)},${literal(projectId)},'primary_customer_document','syntetisk kundekilde'),
      (${literal(solutionId)},${literal(projectId)},'primary_solution_document','syntetisk svarkilde');
      insert into project_jobs(id,project_id,kind,status,lease_token) values(${literal(jobId)},${literal(projectId)},'solution_evaluation','running',${literal(leaseToken)});`);
    const customer = { id: customerId, project_id: projectId, role: "primary_customer_document", title: "Kriterier", file_name: "criteria.txt", file_format: "txt", file_size_bytes: original.length, raw_text: `[[SIDE:2]]\n${original}`, structure_map: [{ reference: "Tildeling · side 2", page: 2, text: original }], chunk_source_revision: 1 };
    const solution = { ...customer, id: solutionId, role: "primary_solution_document", raw_text: answer, structure_map: [] };
    const coverage = { items: [{ full_reference: "Kriterier · K-1", reference: "K-1", assessment: "Godt" }] };
    // Persist source fixtures with the application's encryption too. This
    // changes project revision, so capture a fresh scope before evaluation.
    psql(database, `update documents set raw_text=${literal(encryptJson(customer.raw_text).payload)}, structure_map=${literal(JSON.stringify(encryptJson(customer.structure_map)))}::jsonb where id=${literal(customerId)};
      update documents set raw_text=${literal(encryptJson(answer).payload)} where id=${literal(solutionId)};`);
    // Capture the actual database revisions after all input writes.
    psql(database, `insert into customer_analyses(project_id,source_document_ids,result_json) values(${literal(projectId)},array[${literal(customerId)}::uuid],${literal(JSON.stringify(encryptJson({ likely_evaluation_criteria: [criterion] })))}::jsonb);`);
    let revision = Number(psql(database, `select source_revision from projects where id=${literal(projectId)}`));
    customer.chunk_source_revision = Number(psql(database, `select chunk_source_revision from documents where id=${literal(customerId)}`));
    solution.chunk_source_revision = Number(psql(database, `select chunk_source_revision from documents where id=${literal(solutionId)}`));
    const currentAnalysisRevision = psql(database, `select revision from customer_analyses where project_id=${literal(projectId)}`);
    const rows = normalizeCriterionCoverage([{ criterion_index: 0, criterion, assessment: "Godt", rationale: "Planen er konkret.", evidence: answer, requirement_references: ["Kriterier · K-1"] }], { criteria: [criterion], coverage, customerDocuments: [customer], solutionDocument: solution, sourceRevision: revision, analysisRevision: currentAnalysisRevision });
    assert.equal(rows[0].origin, "observed");
    const client = {
      async rpc(name, args) {
        try {
          const parameters = Object.entries(args).map(([key, value]) => `${key} => ${literal(typeof value === "object" ? JSON.stringify(value) : value)}${typeof value === "object" ? "::jsonb" : "::uuid"}`).join(",");
          const data = JSON.parse(psql(database, `set role service_role; select coalesce(public.${name}(${parameters})::text,'null');`));
          return { data, error: null };
        } catch (error) { return { data: null, error: { message: error.message } }; }
      },
      from(table) {
        assert.equal(table, "project_result_history");
        const query = { select() { return this; }, eq(key, value) { assert.equal(key, "project_id"); assert.equal(value, projectId); return this; }, order() { return this; }, async limit(count) {
          const data = JSON.parse(psql(database, `set role service_role; select coalesce(jsonb_agg(to_jsonb(h)),'[]') from (select * from project_result_history where project_id=${literal(projectId)} order by archived_at desc,id desc limit ${count}) h;`));
          return { data, error: null };
        } };
        return query;
      },
    };
    setPostgRESTStorePersistenceTestClient(client);
    const context = { signal: new AbortController().signal, lease: { jobId, leaseToken, projectId } };
    const save = result => runWithProjectWorkflowContext(context, () => saveSolutionEvaluation(projectId, { customerDocumentId: customerId, solutionDocumentId: solutionId, expectedSourceRevision: revision, result }));
    const saved = await save({ criterion_coverage: rows, requirement_coverage: coverage });
    assert.deepEqual(saved.criterion_coverage, rows);
    const encrypted = JSON.parse(psql(database, `select result_json from solution_evaluations where project_id=${literal(projectId)}`));
    assert.equal(encrypted.encrypted, true);
    assert.match(encrypted.payload, /^enc:v1:/u);
    assert.ok(!JSON.stringify(encrypted).includes(criterion));
    assert.ok(!JSON.stringify(encrypted).includes(answer));
    assert.deepEqual((await getFreshSolutionEvaluation(projectId)).criterion_coverage, rows);

    const downgraded = reconcileCriterionCoverage(rows, { items: [{ ...coverage.items[0], assessment: "Uklart" }] });
    await save({ criterion_coverage: downgraded, requirement_coverage: coverage });
    const history = await getProjectResultHistory(projectId);
    assert.equal(history[0].reason, "replaced");
    assert.deepEqual(history[0].result_json.criterion_coverage, rows);
    assert.deepEqual((await getFreshSolutionEvaluation(projectId)).criterion_coverage, downgraded);
    const followUp = projectFollowUpItems({ artifacts: [], analysis: { revision: currentAnalysisRevision, likely_evaluation_criteria: [criterion] }, evaluation: await getFreshSolutionEvaluation(projectId) });
    assert.match(followUp[0].description, /^Uklart:/u);
    assert.match(followUp[0].reference, /^Dokumentert/u);

    psql(database, `update customer_analyses set result_json=${literal(JSON.stringify(encryptJson({ likely_evaluation_criteria: [criterion, "Pris"] })))}::jsonb where project_id=${literal(projectId)}`);
    assert.equal(await getFreshSolutionEvaluation(projectId), null, "Manual analysis edits invalidate the active result.");
    const archivedAfterEdit = await getProjectResultHistory(projectId);
    assert.deepEqual(archivedAfterEdit.find(row => row.kind === "solution_evaluations" && row.reason === "source_changed").result_json.criterion_coverage, downgraded);

    revision = Number(psql(database, `select source_revision from projects where id=${literal(projectId)}`));
    await save({ requirement_coverage: coverage });
    const legacy = await getFreshSolutionEvaluation(projectId);
    assert.equal(legacy.criterion_coverage, undefined);
    assert.match(projectFollowUpItems({ artifacts: [], analysis: { likely_evaluation_criteria: [criterion] }, evaluation: legacy })[0].description, /dekningen er ukjent/u);
    const nextAnalysisRevision = psql(database, `select revision from customer_analyses where project_id=${literal(projectId)}`);
    const nextRows = normalizeCriterionCoverage([{ criterion_index: 0, criterion, assessment: "Godt", rationale: "Planen er konkret.", evidence: answer, requirement_references: ["Kriterier · K-1"] }], { criteria: [criterion, "Pris"], coverage, customerDocuments: [customer], solutionDocument: solution, sourceRevision: revision, analysisRevision: nextAnalysisRevision });
    assert.notEqual(nextRows[0].criterion_id, rows[0].criterion_id);
    await save({ criterion_coverage: nextRows, requirement_coverage: coverage });
    psql(database, `update documents set raw_text=${literal(encryptJson("Endret konkurransegrunnlag").payload)} where id=${literal(customerId)}`);
    assert.equal(await getFreshSolutionEvaluation(projectId), null, "Changed source invalidates active coverage.");
    await assert.rejects(save({ criterion_coverage: nextRows }), /PROJECT_SOURCE_REVISION_CHANGED/u);
    const finalHistory = await getProjectResultHistory(projectId);
    assert.deepEqual(finalHistory.find(row => row.kind === "solution_evaluations" && row.reason === "source_changed").result_json.criterion_coverage, nextRows);
    assert.ok(finalHistory.some(row => row.kind === "solution_evaluations" && row.result_json.criterion_coverage === undefined), "Absent legacy metadata remains absent in archived reloads.");
  } finally {
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
    psql(admin, `drop database ${databaseName} with (force)`);
  }
});
