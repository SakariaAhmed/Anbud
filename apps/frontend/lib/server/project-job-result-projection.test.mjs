import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createJiti } = createRequire(import.meta.url)("jiti");
process.env.APP_ENCRYPTION_KEY ||= "job-result-projection-test-key";
const jiti = createJiti(import.meta.url, { alias: { "@": frontendRoot, "server-only": "/dev/null" } });
const { projectJobDocumentSummary, projectJobResultForRead } = jiti("./project-job-result-projection.ts");
const { encryptJson, decryptJson } = jiti("./crypto.ts");
const { findProjectJob, listRecentProjectJobs, updatePersistedProjectJob } = jiti("./repositories/jobs.ts");
const { effectiveProjectPermissions } = jiti("../access-control.ts");
const secret = Buffer.from("PRIVATE ORIGINAL SOURCE DOCUMENT").toString("base64");
const document = {
  id: "doc-1", project_id: "project-1", title: "Kilde", file_name: "kilde.pdf",
  file_format: "pdf", content_type: "application/pdf", role: "primary_customer_document",
  supporting_subtype: null, file_size_bytes: 32, page_count: 1,
  processing_status: "basic_ready", processing_message: null, processing_error: null,
  parser_used: "pdfjs", indexed_at: null, chunk_source_revision: 1,
  created_at: "2026-09-06T00:00:00Z", updated_at: "2026-09-06T00:00:00Z",
  file_base64: secret, raw_text: "private full text", structure_map: [{ text: "private structure" }],
  file_storage_bucket: "private", file_storage_path: "private/blob", future_private_field: secret,
};
const result = { document, document_id: document.id, status: "basic_ready", parser_used: "pdfjs", project: null, skipped: true };
const row = {
  id: "job-1", project_id: "project-1", kind: "document_docling_enhancement",
  status: "completed", message: "Ferdig", error: null, created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(), result_json: encryptJson(result),
};
function fakeClient() {
  let payload;
  const query = {
    select() { return this; }, eq() { return this; }, order() { return this; },
    update(value) { payload = value; return this; },
    async maybeSingle() { return { data: row, error: null }; },
    async limit() { return { data: [row], error: null }; },
  };
  return { from: () => query, payload: () => payload };
}
function assertSafe(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [secret, "file_base64", "raw_text", "structure_map", "file_storage_", "future_private_field"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
}

test("document projection preserves the complete public DTO and removes hydrated and future private fields", () => {
  const summary = projectJobDocumentSummary(document);
  assertSafe(summary);
  const { file_base64, raw_text, structure_map, file_storage_bucket, file_storage_path, future_private_field, ...expected } = document;
  assert.deepEqual(summary, expected);
  assert.equal(document.file_base64, secret);
  assert.deepEqual(projectJobResultForRead({ artifact: { content: "answer" }, project: null }), { artifact: { content: "answer" }, project: null });
  assert.equal(projectJobResultForRead(null), null);
  assert.equal(projectJobResultForRead({ document: [document] }).document, null);
});

test("historical encrypted results are projected for single and list reads, and new persisted results omit source details", async () => {
  const client = fakeClient();
  const single = await findProjectJob("project-1", "job-1", { client });
  const list = await listRecentProjectJobs("project-1", { client });
  assertSafe(single);
  assertSafe(list);
  assert.equal(single.result.skipped, true);
  assert.equal(single.result.document.title, "Kilde");
  assert.equal(decryptJson(row.result_json, null).document.file_base64, secret, "legacy ciphertext fixture really contains source");
  assert.equal(await updatePersistedProjectJob("job-1", { status: "completed", result }, { leaseToken: "lease" }, { client }), true);
  assertSafe(decryptJson(client.payload().result_json, null));
});

test("restricted-viewer job list, detail and SSE serialize safe historical results", async () => {
  assert(effectiveProjectPermissions(false, "restricted_viewer").includes("job.read"));
  assert(!effectiveProjectPermissions(false, "restricted_viewer").includes("document.download"));
  const directory = mkdtempSync(path.join(tmpdir(), "job-result-api-test-"));
  globalThis.__jobResultProjectionTestClient = fakeClient();
  try {
    writeFileSync(path.join(directory, "data-api.cjs"), "exports.createServiceClient = () => globalThis.__jobResultProjectionTestClient;");
    writeFileSync(path.join(directory, "auth.cjs"), `exports.requireProjectPermission = async (id, permission) => {
      if (!["project.read", "job.read"].includes(permission)) throw new Error("restricted viewer denied");
      return { projectId: id, projectRole: "restricted_viewer" };
    }; exports.authorizationErrorResponse = () => null;`);
    const apiJiti = createJiti(path.join(directory, "test.cjs"), {
      moduleCache: false,
      alias: { "@/lib/server/data-api": path.join(directory, "data-api.cjs"),
        "@/lib/server/auth": path.join(directory, "auth.cjs"),
        "@/lib/server/authorization": path.join(directory, "auth.cjs"),
        "@": frontendRoot, "server-only": "/dev/null" },
    });
    for (const suffix of ["", "/[jobId]", "/[jobId]/events"]) {
      const route = apiJiti(path.join(frontendRoot, `app/api/projects/[id]/jobs${suffix}/route.ts`));
      const response = await route.GET(new Request("http://localhost/api/projects/project-1/jobs/job-1"), { params: Promise.resolve({ id: "project-1", jobId: "job-1" }) });
      assert.equal(response.status, 200);
      const body = await response.text();
      assertSafe(body);
      assert(body.includes("Kilde"), body);
    }
  } finally {
    delete globalThis.__jobResultProjectionTestClient;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docling already-parsed, not-selected, failed, no-improvement and successful workflows return only summaries", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "job-result-workflow-test-"));
  const state = { document, enabled: true, parsed: null, saves: 0, parses: 0 };
  globalThis.__jobResultProjectionWorkflow = state;
  try {
    writeFileSync(path.join(directory, "store.cjs"), `
      exports.getDocumentDetail = async () => globalThis.__jobResultProjectionWorkflow.document;
      exports.getProjectSnapshotAfterCommit = async () => null;
      exports.updateDocumentProcessingState = async () => {};
      exports.saveDocumentIngestionResult = async () => {
        globalThis.__jobResultProjectionWorkflow.saves++;
        return {...globalThis.__jobResultProjectionWorkflow.document, processing_status: "enhanced_ready"};
      };`);
    writeFileSync(path.join(directory, "documents.cjs"), `
      exports.isDoclingEnabled = () => globalThis.__jobResultProjectionWorkflow.enabled;
      exports.canUseDoclingForFormat = () => true;
      exports.extractTextFromBuffer = async () => {
        globalThis.__jobResultProjectionWorkflow.parses++;
        const parsed = globalThis.__jobResultProjectionWorkflow.parsed;
        if (parsed instanceof Error) throw parsed;
        return parsed;
      };`);
    writeFileSync(path.join(directory, "config.cjs"), "exports.isDocumentAnalysisV3Enabled = () => false; exports.isDocumentAnalysisEnabled = () => false;");
    const workflowJiti = createJiti(path.join(directory, "test.cjs"), { moduleCache: false, alias: {
      "@/lib/server/repositories/data-store": path.join(directory, "store.cjs"),
      "@/lib/server/documents": path.join(directory, "documents.cjs"),
      "@/lib/server/document-intelligence/config": path.join(directory, "config.cjs"),
      "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { runProjectWorkflow } = workflowJiti(path.join(frontendRoot, "lib/server/use-cases/project-workflows.ts"));
    for (const scenario of ["already-parsed", "not-selected", "failed", "no-improvement", "success"]) {
      state.document = { ...document, raw_text: "original text ".repeat(300), parser_used: scenario === "already-parsed" ? "docling" : "pdfjs" };
      state.enabled = scenario !== "not-selected";
      state.parsed = scenario === "failed" ? new Error("synthetic parser failure") : {
        parserUsed: "docling", rawText: scenario === "success" ? state.document.raw_text : "short",
        fileName: "kilde.pdf", fileFormat: "pdf", contentType: "application/pdf", sourceMap: [],
      };
      const output = await runProjectWorkflow({ kind: "document_docling_enhancement", projectId: "project-1", documentId: "doc-1" }, { setProgress() {} });
      assertSafe(output);
      assert.equal(output.skipped, scenario !== "success", scenario);
      assert.equal(output.document.id, "doc-1");
    }
    assert.equal(state.parses, 3);
    assert.equal(state.saves, 1);
  } finally {
    delete globalThis.__jobResultProjectionWorkflow;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("historical cleanup defaults to dry run, preserves metadata on apply, and never overwrites concurrent results", async () => {
  const { cleanHistoricalProjectJobResults } = jiti("./project-job-result-cleanup.ts");
  let savedRow = { ...row };
  let conflict = false;
  const client = {
    async rpc(name, params) {
      assert.equal(name, "clean_project_job_result");
      assert.deepEqual(params.p_expected_result, savedRow.result_json);
      assert.equal(params.p_expected_status, "completed");
      assert.equal(params.p_expected_updated_at, row.updated_at);
      if (conflict) return { data: false, error: null };
      savedRow = { ...savedRow, result_json: params.p_result };
      return { data: true, error: null };
    },
    from() {
      let after = false;
      return {
        select() { return this; }, in() { return this; }, not() { return this; },
        order() { return this; }, limit() { return this; },
        gt() { after = true; return this; },
        then(resolve) { return Promise.resolve({ data: after ? [] : [{ ...savedRow }], error: null }).then(resolve); },
      };
    },
  };
  assert.deepEqual(await cleanHistoricalProjectJobResults({ client }), { scanned: 1, affected: 1, updated: 0, conflicts: 0 });
  assert.equal(decryptJson(savedRow.result_json, null).document.file_base64, secret);
  conflict = true;
  assert.equal((await cleanHistoricalProjectJobResults({ client, apply: true })).conflicts, 1);
  assert.equal(decryptJson(savedRow.result_json, null).document.file_base64, secret);
  conflict = false;
  assert.deepEqual(await cleanHistoricalProjectJobResults({ client, apply: true }), { scanned: 1, affected: 1, updated: 1, conflicts: 0 });
  const cleaned = decryptJson(savedRow.result_json, null);
  assertSafe(cleaned);
  assert.equal(cleaned.skipped, true);
  assert.equal(cleaned.document.title, document.title);
  assert.equal(savedRow.status, row.status);
  assert.equal(savedRow.updated_at, row.updated_at);
  assert.equal((await cleanHistoricalProjectJobResults({ client, apply: true })).affected, 0);
});

test("a retained local-only job is projected before detail/SSE consumers receive it", async () => {
  const { getProjectJob } = jiti("./project-jobs.ts");
  const previousJobs = globalThis.__anbudProjectJobs;
  const previousLocal = globalThis.__anbudLocalProjectJobIds;
  try {
    const { result_json, ...record } = row;
    assert(result_json);
    globalThis.__anbudProjectJobs = new Map([[row.id, { ...record, result }]]);
    globalThis.__anbudLocalProjectJobIds = new Set([row.id]);
    const job = await getProjectJob(row.project_id, row.id);
    assertSafe(job);
    assert.equal(job.result.document.title, document.title);
    assert.equal(await getProjectJob("another-project", row.id), null);
  } finally {
    globalThis.__anbudProjectJobs = previousJobs;
    globalThis.__anbudLocalProjectJobIds = previousLocal;
  }
});

test("cleanup sends large historical ciphertext only in POST bodies, keeping request URLs bounded", async () => {
  const { cleanHistoricalProjectJobResults } = jiti("./project-job-result-cleanup.ts");
  const { PostgrestClient } = jiti("./postgrest-client.ts");
  const largeRow = { ...row, result_json: encryptJson({ ...result, document: { ...document, file_base64: "A".repeat(2 * 1024 * 1024) } }) };
  const calls = [];
  const client = new PostgrestClient("http://localhost:54321", { fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(url);
    let data;
    if (parsed.pathname.endsWith("/rpc/clean_project_job_result")) {
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      assert.deepEqual(body.p_expected_result, largeRow.result_json);
      assertSafe(decryptJson(body.p_result, null));
      data = true;
    } else {
      data = parsed.searchParams.has("id") ? [] : [largeRow];
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  assert.equal((await cleanHistoricalProjectJobResults({ client, apply: true })).updated, 1);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert(call.url.length < 512, `Unexpected URL size: ${call.url.length}`);
    assert(!call.url.includes("enc%3Av1"));
    assert(!call.url.includes("result_json=eq"));
  }
});
