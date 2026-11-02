import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");
const support = path.join(import.meta.dirname, "data-store.persistence.test-support.ts");
const load = createJiti(import.meta.url, { alias: {
  "@": frontend, "server-only": "/dev/null", "next/cache": support,
  "@/lib/server/data-api": support, "@/lib/server/document-chunks": support,
} });
const { saveGeneratedArtifact, updateGeneratedArtifact, listGeneratedArtifactsFresh, listCurrentGeneratedArtifactsFresh, getArtifactSourceRevisions } = load("./artifacts.ts");
const { setPostgRESTStorePersistenceTestClient } = load(support);
const { runWithProjectWorkflowContext } = load("../project-workflow-cancellation.ts");
const { buildImmutableRequirementRowManifest } = load("../artifact-validation.ts");
const { reviewRequirementRowOutputEvidence } = load("../output-source-evidence.ts");
const { requirementReviewRows, editRequirementReviewRow } = load("../../requirement-review.ts");
const { mergeRegeneratedRequirementRows } = load("../ai/requirement-response-regeneration.ts");
const { encryptJson } = load("../crypto.ts");
const admin = process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL;
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
function psql(url, sql) {
  const result = spawnSync("psql", [url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 24e6 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Only PostgREST transport and cache are injected. Repository mapping,
// encryption, publication fencing, history rows and manual validation are real.
function sqlTransport(database) {
  return {
    async rpc(name, args) {
      assert.ok(["lease_fenced_save_generated_artifact", "get_artifact_source_revisions", "get_artifact_authority_summary", "create_manual_artifact_version"].includes(name), name);
      try {
        const parameters = Object.entries(args).map(([key, value]) => `${key} => ${literal(typeof value === "object" ? JSON.stringify(value) : value)}${typeof value === "object" ? "::jsonb" : "::uuid"}`).join(",");
        return { data: JSON.parse(psql(database, `set role service_role; select coalesce(public.${name}(${parameters})::text,'null');`)), error: null };
      } catch (error) { return { data: null, error: { message: error.message } }; }
    },
    from(table) {
      assert.ok(["generated_artifacts", "documents", "projects"].includes(table), table);
      const filters = [], orders = [];
      let count;
      const query = {
        select() { return this; },
        eq(key, value) { assert.match(key, /^[a-z_]+$/u); filters.push(`${key}=${literal(value)}`); return this; },
        in(key, values) { assert.equal(key, "id"); filters.push(`id in (${values.map(literal).join(",")})`); return this; },
        order(key, options) { assert.match(key, /^[a-z_]+$/u); orders.push(`${key} ${options?.ascending ? "asc" : "desc"}`); return this; },
        limit(value) { assert.ok(Number.isSafeInteger(value)); count = value; return this; },
        async single() { const result = await this; return { ...result, data: result.data?.[0] ?? null }; },
        then(resolve, reject) {
          try {
            const sql = `select * from ${table}${filters.length ? ` where ${filters.join(" and ")}` : ""}${orders.length ? ` order by ${orders.join(",")}` : ""}${count ? ` limit ${count}` : ""}`;
            resolve({ data: JSON.parse(psql(database, `set role service_role; select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (${sql}) t;`)), error: null });
          } catch (error) { reject(error); }
        },
      };
      return query;
    },
  };
}

test("postgres: per-answer confidence survives encrypted artifact history/reload, selected regeneration and manual edits without crossing repeated IDs or source authority", { skip: !admin, timeout: 60_000 }, async () => {
  const databaseName = `answer_confidence_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(admin); target.pathname = `/${databaseName}`;
  const database = target.toString();
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY ||= "answer-confidence-disposable-test-key";
  const temporary = mkdtempSync(path.join(tmpdir(), "answer-confidence-route-"));
  psql(admin, `create database ${databaseName}`);
  try {
    psql(database, "set anbud.allow_destructive_schema_rebuild = on;\n" + readFileSync(path.resolve(frontend, "../../database/schema.sql"), "utf8"));
    setPostgRESTStorePersistenceTestClient(sqlTransport(database));
    const projectId = randomUUID(), foreignProjectId = randomUUID(), sourceId = randomUUID(), foreignSourceId = randomUUID();
    const sourceText = "[[SIDE:2]]\nK-1 Leverandøren skal dokumentere logging.\n[[SIDE:5]]\nK-1 Leverandøren skal dokumentere backup.";
    psql(database, `insert into projects(id,client_name,title) values (${literal(projectId)},'Syntetisk','Svarbevis'),(${literal(foreignProjectId)},'Syntetisk','Annet prosjekt');
      insert into documents(id,project_id,role,title,raw_text) values
      (${literal(sourceId)},${literal(projectId)},'primary_customer_document','Krav',${literal(encryptJson(sourceText).payload)}),
      (${literal(foreignSourceId)},${literal(foreignProjectId)},'primary_customer_document','Annen kilde',${literal(encryptJson(sourceText).payload)});`);
    const sourceRevision = Number(psql(database, `select chunk_source_revision from documents where id=${literal(sourceId)}`));
    const source = { sourceType: "project_document", document: { id: sourceId, project_id: projectId, role: "primary_customer_document", title: "Krav", raw_text: sourceText, chunk_source_revision: sourceRevision, structure_map: [] } };
    const immutable = [
      { ref: "K-1", requirementText: "Leverandøren skal dokumentere logging.", sourceLocator: "Krav · side 2", sourceDocumentId: sourceId },
      { ref: "K-1", requirementText: "Leverandøren skal dokumentere backup.", sourceLocator: "Krav · side 5", sourceDocumentId: sourceId },
    ];
    const metadata = entries => ({ requirement_response: { total_requirements: entries.length, requirement_refs: entries.map(row => row.ref), deterministic_fallback_answers_after_handoff: 0, coverage_enforced: true, source_evidence_enforced: true, immutable_row_manifest: buildImmutableRequirementRowManifest(entries) } });
    const table = entries => "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |\n| --- | --- | --- | --- | --- |\n" + entries.map((entry, index) => `| ${entry.ref} | ${entry.requirementText} | Vi dokumenterer ${index ? "backup" : "logging"} i leveransen. | «${entry.requirementText}» | ${entry.sourceLocator} |`).join("\n");
    const content = table(immutable).replace("«Leverandøren skal dokumentere backup.»", "Tilbudsgrunnlaget kompletteres."), generation_metadata = metadata(immutable);
    const initialRows = requirementReviewRows(content, { generation_metadata });
    assert.notEqual(initialRows[0].rowHash, initialRows[1].rowHash);
    const evidence = reviewRequirementRowOutputEvidence({ documents: [source], rows: initialRows }).evidence;
    assert.deepEqual(evidence.row_confidence.map(row => row.level), ["documented_excerpt", "unknown"]);
    const revisions = await getArtifactSourceRevisions(projectId);
    async function save(contentMarkdown, inputSnapshot, selection, writeProjectId = projectId) {
      const jobId = randomUUID(), leaseToken = randomUUID();
      psql(database, `insert into project_jobs(id,project_id,kind,status,lease_token,input_json) values(${literal(jobId)},${literal(writeProjectId)},'artifact_generation','running',${literal(leaseToken)},${literal(JSON.stringify({ artifactType: "forbedret_kravsvar", ...(selection ? { regenerateRequirements: selection } : {}) }))}::jsonb);`);
      return runWithProjectWorkflowContext({ signal: new AbortController().signal, lease: { jobId, leaseToken, projectId: writeProjectId } }, () => saveGeneratedArtifact(projectId, "forbedret_kravsvar", "Kravbesvarelse", contentMarkdown, inputSnapshot, {
        expectedArtifactSourceRevision: revisions.artifactSourceRevision, expectedServiceLibraryRevision: revisions.serviceLibraryRevision,
        knowledgeArtifactManifest: [], generatorRevision: "confidence-contract-v2", sourceSnapshotHash: createHash("sha256").update(sourceText).digest("hex"), usedSolutionEvaluation: false, solutionEvaluationDependency: null,
      }));
    }
    const first = await save(content, { generation_metadata, source_evidence: evidence });
    const stored = JSON.parse(psql(database, `select input_snapshot from generated_artifacts where id=${literal(first.id)}`));
    assert.equal(stored.encrypted, true); assert.match(stored.payload, /^enc:v1:/u);
    assert.ok(!JSON.stringify(stored).includes("row_confidence"));
    const readCurrent = async () => (await listCurrentGeneratedArtifactsFresh(projectId))[0];
    const rowsOf = artifact => requirementReviewRows(artifact.content_markdown, artifact.input_snapshot);
    assert.deepEqual((await readCurrent()).input_snapshot.source_evidence, evidence);
    assert.deepEqual(rowsOf(await readCurrent()).map(row => row.confidence.level), ["documented_excerpt", "unknown"]);

    const selection = { artifactId: first.id, artifactVersion: first.artifact_version, rows: [{ index: 1, rowHash: initialRows[1].rowHash }] };
    const subsetContent = table([immutable[1]]).replace("Vi dokumenterer logging i leveransen.", "Vi leverer en revidert backupplan.");
    const merged = mergeRegeneratedRequirementRows(await readCurrent(), selection, { title: "Kravbesvarelse", content_markdown: subsetContent, generation_metadata: metadata([immutable[1]]) }, []);
    const regeneratedRows = requirementReviewRows(merged.content_markdown, { generation_metadata: merged.generation_metadata });
    const regeneratedEvidence = reviewRequirementRowOutputEvidence({ documents: [source], rows: regeneratedRows, parentRows: initialRows, parentEvidence: evidence, regeneratedIndexes: new Set([1]) }).evidence;
    const regenerated = await save(merged.content_markdown, { generation_metadata: merged.generation_metadata, source_evidence: regeneratedEvidence }, selection);
    const loaded = await readCurrent(), loadedRows = rowsOf(loaded);
    assert.equal(regenerated.parent_artifact_id, first.id);
    assert.deepEqual(loadedRows[0], rowsOf(first)[0], "Selected regeneration leaves the other repeated-ID row and confidence unchanged.");
    assert.equal(loadedRows[1].answer, "Vi leverer en revidert backupplan.");
    assert.equal(loadedRows[1].confidence.level, "documented_excerpt", "Only the selected row gains new documented-excerpt confidence.");
    assert.deepEqual(loaded.input_snapshot.source_evidence.row_confidence.find(row => row.index === 0), evidence.row_confidence[0]);

    const editedContent = editRequirementReviewRow(loaded.content_markdown, loadedRows[0], { answer: "Manuelt utformet svar med ny leveransebeskrivelse.", evidence: loadedRows[0].evidence });
    const manual = await updateGeneratedArtifact({ projectId, artifactId: loaded.id, title: loaded.title, contentMarkdown: editedContent });
    const manualReload = await readCurrent();
    assert.equal(manualReload.id, manual.id); assert.equal(manualReload.origin, "manual_edit");
    assert.deepEqual(rowsOf(manualReload).map(row => row.confidence.level), ["unknown", "documented_excerpt"]);
    assert.deepEqual(manualReload.input_snapshot.source_evidence.row_confidence.map(row => row.index), [1]);
    const history = await listGeneratedArtifactsFresh(projectId);
    assert.equal(history.length, 3);
    assert.deepEqual(history.find(row => row.id === first.id).input_snapshot.source_evidence, evidence);
    assert.deepEqual(rowsOf(history.find(row => row.id === regenerated.id)).map(row => row.confidence.level), ["documented_excerpt", "documented_excerpt"]);
    assert.equal(history.find(row => row.id === first.id).is_current, false);

    // Parser identity checks run on repository-decrypted history, not invented JSON.
    const swapped = structuredClone(loaded.input_snapshot);
    swapped.source_evidence.row_confidence.forEach(row => { row.row_hash = initialRows[1 - row.index].rowHash; });
    assert.deepEqual(requirementReviewRows(loaded.content_markdown, swapped).map(row => row.confidence.level), ["unknown", "unknown"]);
    const wrongIndexes = structuredClone(loaded.input_snapshot);
    wrongIndexes.source_evidence.row_confidence.forEach(row => { row.index = 1 - row.index; });
    assert.deepEqual(requirementReviewRows(loaded.content_markdown, wrongIndexes).map(row => row.confidence.level), ["unknown", "unknown"]);
    await save(loaded.content_markdown, swapped);
    assert.deepEqual(rowsOf(await readCurrent()).map(row => row.confidence.level), ["unknown", "unknown"], "Mismatched hashes cannot transfer confidence after encrypted reload.");
    await save(loaded.content_markdown, wrongIndexes);
    assert.deepEqual(rowsOf(await readCurrent()).map(row => row.confidence.level), ["unknown", "unknown"], "Mismatched indexes cannot transfer confidence after encrypted reload.");

    const legacy = await save(content, { generation_metadata });
    assert.equal((await readCurrent()).input_snapshot.source_evidence, undefined);
    assert.deepEqual(rowsOf(await readCurrent()).map(row => row.confidence.level), ["unknown", "unknown"]);
    const withLegacyHistory = await listGeneratedArtifactsFresh(projectId);
    assert.equal(withLegacyHistory.find(row => row.id === legacy.id).input_snapshot.source_evidence, undefined);
    assert.deepEqual(rowsOf(withLegacyHistory.find(row => row.id === manual.id)).map(row => row.confidence.level), ["unknown", "documented_excerpt"]);

    // Recheck a persisted reference through the real route and repository reads.
    const dependencies = path.join(temporary, "route.cjs");
    writeFileSync(dependencies, `exports.requireProjectPermission=async()=>({principal:{id:"test"},permissions:["document.download"]}); exports.enforceRateLimit=async()=>null; exports.routeErrorResponse=error=>{throw error;};`);
    const routeLoad = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null", "next/cache": support, "@/lib/server/data-api": support, "@/lib/server/document-chunks": support, "@/lib/server/authorization": dependencies, "@/lib/server/api-responses": dependencies } });
    const { POST } = await routeLoad.import(path.join(frontend, "app/api/projects/[id]/source-evidence/route.ts"));
    const savedReference = history.find(row => row.id === first.id).input_snapshot.source_evidence.references[0].source;
    const verify = overrides => POST(new Request("http://localhost/api/projects/test/source-evidence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentId: savedReference.source_id, quote: savedReference.original_quote, sourceRevision: savedReference.source_revision, ...overrides }) }), { params: Promise.resolve({ id: projectId }) });
    assert.equal((await verify({})).status, 200);
    assert.equal((await verify({ documentId: foreignSourceId })).status, 404, "Identical text in a foreign source never becomes project evidence.");
    await assert.rejects(save(content, { generation_metadata, source_evidence: evidence }, undefined, foreignProjectId), /annet prosjekt|lease/iu);
    psql(database, `update documents set raw_text=${literal(encryptJson("Endret kildegrunnlag uten det gamle sitatet.").payload)} where id=${literal(sourceId)}`);
    assert.equal((await verify({})).status, 409, "Historical confidence cannot validate a changed source revision.");
    assert.deepEqual(await listCurrentGeneratedArtifactsFresh(projectId), [], "Source changes remove artifact authority.");
    assert.ok((await listGeneratedArtifactsFresh(projectId)).every(row => !row.source_is_current));
    await assert.rejects(save(content, { generation_metadata, source_evidence: evidence }), /ARTIFACT_SOURCE_REVISION_CHANGED/u);
    const archived = (await listGeneratedArtifactsFresh(projectId)).find(row => row.id === first.id);
    assert.deepEqual(archived.input_snapshot.source_evidence, evidence, "History retains the original confidence as historical metadata.");
  } finally {
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = previousKey;
    rmSync(temporary, { recursive: true, force: true });
    psql(admin, `drop database ${databaseName} with (force)`);
  }
});
