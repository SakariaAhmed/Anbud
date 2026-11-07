import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BackfillError, backfillDocumentChunks, parseBackfillOptions, reportBackfillFailure } from "./backfill_document_chunks.mjs";

const environment = { DATA_API_URL: "http://127.0.0.1:59999", DATA_API_SERVICE_ROLE_KEY: "fictional", APP_ENCRYPTION_KEY: "fictional" };
const document = (id, extra = {}) => ({ id: String(id).padStart(6, "0"), project_id: "project", service_id: "service", role: "supporting_document", supporting_subtype: null, title: "Fiktivt dokument", file_name: "eksempel.txt", file_format: "txt", raw_text: "Leverandøren skal dokumentere driftsansvar.", structure_map: [], chunk_source_revision: 3, processing_status: "basic_ready", ...extra });
function sourceClient(tables, { preflightError = null, maxRows = Infinity } = {}) {
  const reads = [];
  const client = { from(table) {
    let cursor = "", size = 100;
    const query = {
      select() { return query; }, order() { return query; }, limit(n) { size = n; return query; },
      gt(column, value) { assert.equal(column, "id"); cursor = value; return query; },
      then(resolve, reject) {
        reads.push({ table, cursor, size });
        return Promise.resolve(table === "document_chunks" ? { data: [], error: preflightError } : { data: (tables[table] ?? []).filter(row => row.id > cursor).slice(0, Math.min(size, maxRows)), error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  return { client, reads };
}
function runtimeFor(tables, controls) {
  const { client, reads } = sourceClient(tables, controls);
  const writes = [];
  return { dataApi: client, reads, writes, decryptString: value => value, decryptJson: value => value,
    normalizeDocumentChunkStructureMap: value => value,
    replaceProjectDocumentChunks: async input => writes.push(["project", input]),
    replaceServiceDocumentChunks: async input => writes.push(["service", input]),
  };
}

test("backfill defaults to read-only explicit configuration and gates target/paid calls", () => {
  assert.equal(parseBackfillOptions([], environment).apply, false);
  assert.throws(() => parseBackfillOptions([], {}), /explicitly/);
  assert.throws(() => parseBackfillOptions(["--apply"], environment), /exact/);
  assert.throws(() => parseBackfillOptions(["--apply", "--target=https://other.test"], environment), /exact/);
  assert.throws(() => parseBackfillOptions(["--with-embeddings"], environment), /explicit/);
  for (const value of ["0", "-1", "abc", "1.5"]) assert.throws(() => parseBackfillOptions([`--limit=${value}`], environment), /positive/);
  assert.equal(parseBackfillOptions(["--apply", `--target=${environment.DATA_API_URL}`], environment).apply, true);
});

test("backfill keyset-pages all sources beyond a server row cap without writes on dry run", async () => {
  for (const maxRows of [Infinity, 50]) {
    const runtime = runtimeFor({ documents: Array.from({ length: 1201 }, (_, i) => document(i + 1)), service_documents: [document(1)] }, { maxRows });
    const totals = await backfillDocumentChunks(runtime);
    assert.equal(totals.scanned_documents, 1202);
    assert.equal(totals.indexed_documents, 0);
    assert.equal(runtime.writes.length, 0);
    assert.equal(runtime.reads.filter(row => row.table === "documents").length, maxRows === 50 ? 26 : 14);
    assert.equal(runtime.reads.filter(row => row.table === "service_documents").length, 2);
    assert.ok(runtime.reads.every(row => row.size <= 100));
  }
});

test("backfill respects per-source limits, readiness and exact source revisions", async () => {
  const runtime = runtimeFor({ documents: [document(1, { processing_status: "processing" }), document(2), document(3)], service_documents: [document(1), document(2), document(3)] });
  const totals = await backfillDocumentChunks(runtime, { apply: true, limit: 2 });
  assert.deepEqual(totals, { dry_run: false, scanned_documents: 4, skipped_documents: 1, indexed_documents: 3 });
  assert.deepEqual(runtime.writes.map(([kind, value]) => [kind, value.documentId, value.sourceRevision]), [["project", "000002", 3], ["service", "000001", 3], ["service", "000002", 3]]);
});

test("failed preflight or atomic replacement never reports successful repair", async () => {
  await assert.rejects(backfillDocumentChunks(runtimeFor({}, { preflightError: { message: "missing" } }), { apply: true }), /unavailable/);
  const runtime = runtimeFor({ documents: [document(1), document(2)] });
  runtime.replaceProjectDocumentChunks = async () => { throw new Error("PROJECT_SOURCE_REVISION_CHANGED"); };
  await assert.rejects(backfillDocumentChunks(runtime, { apply: true }), { code: "SOURCE_REVISION_CHANGED" });
  assert.equal(runtime.writes.length, 0);
});

test("both CLI entrypoints report safe validation/stage details without backend messages", async (t) => {
  const output = [];
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  t.mock.method(console, "error", message => output.push(message));
  for (const args of [["--limit=abc"], ["--apply", "--target=https://wrong.test"]]) {
    try { parseBackfillOptions(args, environment); assert.fail("Expected invalid configuration"); }
    catch (error) { assert.ok(error instanceof BackfillError); reportBackfillFailure(error); }
  }
  await backfillDocumentChunks(runtimeFor({}, { preflightError: { message: "private backend payload" } })).catch(reportBackfillFailure);
  reportBackfillFailure(Object.assign(new Error("secret raw backend message"), { code: "secret raw code" }));
  assert.match(output[0], /CONFIGURATION.*positive/);
  assert.match(output[1], /CONFIGURATION.*exact/);
  assert.match(output[2], /STORAGE_PREFLIGHT.*unavailable/);
  assert.match(output[3], /UNEXPECTED_FAILURE/);
  assert.doesNotMatch(output.join("\n"), /private|secret/);
  assert.equal(process.exitCode, 1);
  for (const relative of ["./backfill_document_chunks.mjs", "../apps/frontend/scripts/backfill_document_chunks.mjs"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(relative, import.meta.url)), "--limit=abc"], { encoding: "utf8", env: environment });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CONFIGURATION.*positive/);
    assert.equal(result.stdout, "");
  }
});

test("backfill publishes through the current shared atomic writer and fingerprint contract", async () => {
  const frontend = fileURLToPath(new URL("../apps/frontend/", import.meta.url));
  const require = createRequire(new URL("../apps/frontend/package.json", import.meta.url));
  const { createJiti } = require("jiti");
  const support = path.join(frontend, "lib/server/document-chunks.test-support.ts");
  const load = createJiti(import.meta.url, { fsCache: false, alias: { "@": frontend, "server-only": "/dev/null", "@/lib/server/data-api": support, openai: support } });
  const chunks = load(path.join(frontend, "lib/server/document-chunks.ts"));
  const controls = load(support);
  controls.resetDocumentChunksTestRuntime();
  const saved = { key: process.env.APP_ENCRYPTION_KEY, openai: process.env.OPENAI_API_KEY };
  process.env.APP_ENCRYPTION_KEY = "synthetic-backfill-test-encryption";
  delete process.env.OPENAI_API_KEY;
  try {
    const runtime = runtimeFor({ documents: [document(1)] });
    const totals = await backfillDocumentChunks({ ...runtime, ...chunks }, { apply: true });
    assert.equal(totals.indexed_documents, 1);
    const manifest = controls.getDocumentChunksTestManifest("project_document", "000001");
    assert.equal(manifest.sourceRevision, 3);
    assert.ok(manifest.rows.length > 0);
    assert.equal(chunks.documentChunkMetadataMatchesSourceFingerprint(manifest.rows[0].metadata, manifest.sourceFingerprint), true);
    assert.equal(controls.getDocumentChunksTestEmbeddingRequestCount(), 0);
    assert.deepEqual(controls.getDocumentChunksTestRpcCalls().filter(call => call.name.includes("replace")).map(call => call.name), ["replace_document_chunks_atomic"]);
  } finally {
    for (const [name, value] of [["APP_ENCRYPTION_KEY", saved.key], ["OPENAI_API_KEY", saved.openai]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
