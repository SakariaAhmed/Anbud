import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "../..");
const directory = mkdtempSync(path.join(tmpdir(), "document-job-tracker-"));
const backend = path.join(directory, "backend.cjs");
writeFileSync(backend, `exports.watchProjectJob = input => globalThis.__documentJobTrackerTest.watch(input);
exports.fetchProjectState = (...args) => globalThis.__documentJobTrackerTest.refresh(...args);`);
const jiti = createJiti(import.meta.url, {
  alias: { "@/lib/client/project-api": backend, "@": root },
});
const { trackDocumentProcessing, DocumentProcessingFailure } = jiti("./document-job-tracker.ts");
test.after(() => { delete globalThis.__documentJobTrackerTest; rmSync(directory, { recursive: true, force: true }); });

const document = { id: "document", processing_status: "enhanced_ready" };
const completed = { id: "ingestion", status: "completed", result: { document } };
function harness(watch, refresh = async () => ({ id: "project", documents: [document] })) {
  const statuses = [], projects = [], enhancements = [], watched = [], refreshed = [];
  globalThis.__documentJobTrackerTest = {
    watch: input => { watched.push(input.jobId); return watch(input); },
    refresh: (...args) => { refreshed.push(args); return refresh(...args); },
  };
  const controller = new AbortController();
  return { controller, statuses, projects, enhancements, watched, refreshed,
    run: (signal = controller.signal) => trackDocumentProcessing({
      projectId: "project", job: { id: "ingestion", kind: "document_ingestion" }, signal,
      onStatus: status => statuses.push(status), onEnhancement: () => enhancements.push(true),
      onProject: project => projects.push(project),
    }),
  };
}

test("completed ingestion and enhancement refresh the persisted project once", async () => {
  const h = harness(async ({ jobId, onStatus }) => {
    onStatus({ id: jobId, status: "completed" });
    return jobId === "ingestion"
      ? { ...completed, result: { docling_enhancement_job_id: "enhancement" } } : completed;
  });
  assert.deepEqual(await h.run(), document);
  assert.deepEqual(h.watched, ["ingestion", "enhancement"]);
  assert.equal(h.enhancements.length, 1);
  assert.equal(h.projects.length, 1);
  assert.equal(h.refreshed.length, 1);
});

for (const failedPhase of ["ingestion", "enhancement"]) {
  test(`${failedPhase} terminal failure is a safe server error and reloads persisted status`, async () => {
    const failedProject = { id: "project", documents: [{ id: "document", processing_status: "failed" }] };
    const h = harness(async ({ jobId, onStatus }) => {
      if (jobId === failedPhase) {
        onStatus({ id: jobId, status: "failed", error: "private backend response" });
        throw new Error("private backend response");
      }
      return { ...completed, result: { docling_enhancement_job_id: "enhancement" } };
    }, async () => failedProject);
    await assert.rejects(h.run(), error => {
      assert.ok(error instanceof DocumentProcessingFailure);
      assert.equal(error.kind, "server");
      assert.doesNotMatch(error.message, /private backend/);
      return true;
    });
    assert.deepEqual(h.projects, [failedProject]);
    assert.equal(h.refreshed.length, 1);
  });
}

test("failure to refresh never turns a terminal failure into a connection notice", async () => {
  const h = harness(async ({ onStatus }) => {
    onStatus({ status: "failed" });
    throw new Error("private job failure");
  }, async () => { throw new Error("private refresh failure"); });
  await assert.rejects(h.run(), { kind: "server" });
  assert.deepEqual(h.projects, []);
});

test("transport failure preserves persisted state and has no backend details", async () => {
  const h = harness(async () => { throw new Error("private network detail"); });
  await assert.rejects(h.run(), error => {
    assert.equal(error.kind, "connection");
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.projects, []);
});

test("cancellation suppresses late statuses and does not refresh or publish a project", async () => {
  let resolveWatch, status;
  const h = harness(({ onStatus }) => {
    status = onStatus;
    return new Promise(resolve => { resolveWatch = resolve; });
  });
  const waiting = h.run();
  h.controller.abort();
  assert.throws(() => status({ status: "failed" }), { name: "AbortError" });
  resolveWatch(completed);
  await assert.rejects(waiting, { name: "AbortError" });
  assert.deepEqual(h.statuses, []);
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.projects, []);
});

test("cancelling one document tracker does not cancel another subscriber", async () => {
  const watchers = [];
  const h = harness(({ signal }) => new Promise((resolve, reject) => {
    watchers.push({ signal, resolve });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const other = new AbortController();
  const first = h.run(), second = h.run(other.signal);
  h.controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(watchers[1].signal.aborted, false);
  watchers[1].resolve(completed);
  assert.deepEqual(await second, document);
  assert.equal(h.projects.length, 1);
});
