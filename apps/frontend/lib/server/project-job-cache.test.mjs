import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "project-job-cache-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot },
});

const {
  evictCachedProjectJob,
  pruneTerminalProjectJobCache,
  readProjectJobAuthoritatively,
  reconcilePersistedProjectJobCachePatch,
  reconcileTerminalProjectJobCache,
} = jiti(path.join(frontendRoot, "lib/server/project-job-cache.ts"));

function job(overrides = {}) {
  return {
    id: "job-1",
    project_id: "project-1",
    kind: "solution_evaluation",
    status: "running",
    message: "Arbeider ...",
    created_at: "2026-07-11T20:00:00.000Z",
    updated_at: "2026-07-11T20:00:01.000Z",
    error: null,
    result: null,
    ...overrides,
  };
}

test("persisted successor state overrides a stale running cache entry", async () => {
  const jobs = new Map([["job-1", job()]]);
  const localJobIds = new Set();
  const locallyManagedPersistedJobIds = new Set();
  const terminal = job({
    status: "failed",
    message: "Ny lease avsluttet jobben.",
    updated_at: "2026-07-11T20:05:00.000Z",
    error: "Kontrollert feil",
  });

  const result = await readProjectJobAuthoritatively({
    jobs,
    localJobIds,
    locallyManagedPersistedJobIds,
    projectId: "project-1",
    jobId: "job-1",
    findPersisted: async () => terminal,
  });

  assert.deepEqual(result, terminal);
  assert.deepEqual(jobs.get("job-1"), terminal);
});

test("authoritative not-found evicts an obsolete cached job", async () => {
  const jobs = new Map([["job-1", job()]]);
  const localJobIds = new Set();
  const locallyManagedPersistedJobIds = new Set();

  const result = await readProjectJobAuthoritatively({
    jobs,
    localJobIds,
    locallyManagedPersistedJobIds,
    projectId: "project-1",
    jobId: "job-1",
    findPersisted: async () => null,
  });

  assert.equal(result, null);
  assert.equal(jobs.has("job-1"), false);
});

test("repository errors use only a same-project cache fallback", async () => {
  const jobs = new Map([["job-1", job()]]);
  const localJobIds = new Set();
  const locallyManagedPersistedJobIds = new Set();
  const unavailable = async () => {
    throw new Error("temporary database outage");
  };

  assert.deepEqual(
    await readProjectJobAuthoritatively({
      jobs,
      localJobIds,
      locallyManagedPersistedJobIds,
      projectId: "project-1",
      jobId: "job-1",
      findPersisted: unavailable,
    }),
    job(),
  );
  assert.equal(
    await readProjectJobAuthoritatively({
      jobs,
      localJobIds,
      locallyManagedPersistedJobIds,
      projectId: "another-project",
      jobId: "job-1",
      findPersisted: unavailable,
    }),
    null,
  );
});

test("local-only jobs bypass persisted lookup and remain readable", async () => {
  const jobs = new Map([["job-1", job({ message: "Lokal jobb" })]]);
  const localJobIds = new Set(["job-1"]);
  const locallyManagedPersistedJobIds = new Set();
  let persistedReads = 0;

  const result = await readProjectJobAuthoritatively({
    jobs,
    localJobIds,
    locallyManagedPersistedJobIds,
    projectId: "project-1",
    jobId: "job-1",
    findPersisted: async () => {
      persistedReads += 1;
      return null;
    },
  });

  assert.equal(result?.message, "Lokal jobb");
  assert.equal(persistedReads, 0);
  assert.equal(jobs.has("job-1"), true);
});

test("a locally managed persisted job uses its live in-process cache", async () => {
  const jobs = new Map([["job-1", job({ message: "Lokal fremdrift" })]]);
  const localJobIds = new Set();
  const locallyManagedPersistedJobIds = new Set(["job-1"]);
  let persistedReads = 0;

  const result = await readProjectJobAuthoritatively({
    jobs,
    localJobIds,
    locallyManagedPersistedJobIds,
    projectId: "project-1",
    jobId: "job-1",
    findPersisted: async () => {
      persistedReads += 1;
      return job({ status: "completed" });
    },
  });

  assert.equal(result?.message, "Lokal fremdrift");
  assert.equal(persistedReads, 0);
});

test("lease-loss eviction removes both job and progress state", () => {
  const jobs = new Map([["job-1", job()]]);
  const progressWrites = new Map([
    ["job-1", { message: "Arbeider ...", writtenAt: 123 }],
  ]);
  const localJobIds = new Set();
  const locallyManagedPersistedJobIds = new Set(["job-1"]);

  evictCachedProjectJob(
    jobs,
    progressWrites,
    localJobIds,
    locallyManagedPersistedJobIds,
    "job-1",
  );

  assert.equal(jobs.has("job-1"), false);
  assert.equal(progressWrites.has("job-1"), false);
  assert.equal(locallyManagedPersistedJobIds.has("job-1"), false);
});

test("a rejected progress write evicts and a late accepted write cannot resurrect", () => {
  const jobs = new Map([["job-1", job()]]);
  const progressWrites = new Map([
    ["job-1", { message: "Arbeider ...", writtenAt: 123 }],
  ]);
  const localJobIds = new Set();
  const locallyManagedPersistedJobIds = new Set(["job-1"]);

  reconcilePersistedProjectJobCachePatch({
    jobs,
    progressWrites,
    localJobIds,
    locallyManagedPersistedJobIds,
    jobId: "job-1",
    patch: { status: "running", message: "Gammel fremdrift" },
    accepted: false,
  });
  reconcilePersistedProjectJobCachePatch({
    jobs,
    progressWrites,
    localJobIds,
    locallyManagedPersistedJobIds,
    jobId: "job-1",
    patch: { status: "running", message: "Forsinket gammel fremdrift" },
    accepted: true,
  });

  assert.equal(jobs.has("job-1"), false);
  assert.equal(progressWrites.has("job-1"), false);
  assert.equal(locallyManagedPersistedJobIds.has("job-1"), false);
});

test("persisted terminal cache drops the result and rejects late progress", () => {
  const jobs = new Map([["job-1", job()]]);
  const progressWrites = new Map();
  const localJobIds = new Set();
  const locallyManagedPersistedJobIds = new Set(["job-1"]);

  reconcileTerminalProjectJobCache({
    jobs,
    progressWrites,
    localJobIds,
    locallyManagedPersistedJobIds,
    jobId: "job-1",
    patch: { status: "completed", message: "Ferdig.", result: { ok: true } },
    persisted: true,
    updatedAt: "2026-07-11T20:06:00.000Z",
  });

  reconcilePersistedProjectJobCachePatch({
    jobs,
    progressWrites,
    localJobIds,
    locallyManagedPersistedJobIds,
    jobId: "job-1",
    patch: { status: "running", message: "Forsinket fremdrift" },
    accepted: true,
  });

  assert.equal(jobs.get("job-1")?.status, "completed");
  assert.equal(jobs.get("job-1")?.message, "Ferdig.");
  assert.equal(jobs.get("job-1")?.result, null);
  assert.equal(locallyManagedPersistedJobIds.has("job-1"), false);
});

test("local-only terminal cache retains its result until bounded eviction", () => {
  const jobs = new Map([["job-1", job()]]);
  const progressWrites = new Map();
  const localJobIds = new Set(["job-1"]);
  const locallyManagedPersistedJobIds = new Set();

  reconcileTerminalProjectJobCache({
    jobs,
    progressWrites,
    localJobIds,
    locallyManagedPersistedJobIds,
    jobId: "job-1",
    patch: { status: "completed", message: "Ferdig.", result: { ok: true } },
    persisted: true,
    updatedAt: new Date().toISOString(),
  });

  assert.deepEqual(jobs.get("job-1")?.result, { ok: true });
});

test("terminal cache applies TTL without evicting active jobs", () => {
  const now = Date.now();
  const jobs = new Map([
    [
      "expired",
      job({
        id: "expired",
        status: "completed",
        updated_at: new Date(now - 60_000).toISOString(),
      }),
    ],
    [
      "fresh",
      job({
        id: "fresh",
        status: "failed",
        updated_at: new Date(now - 1_000).toISOString(),
      }),
    ],
    [
      "running",
      job({
        id: "running",
        status: "running",
        updated_at: new Date(now - 86_400_000).toISOString(),
      }),
    ],
  ]);

  assert.deepEqual(
    pruneTerminalProjectJobCache(jobs, {
      now,
      ttlMs: 10_000,
      maxEntries: 10,
    }),
    ["expired"],
  );
  assert.equal(jobs.has("fresh"), true);
  assert.equal(jobs.has("running"), true);
});

test("terminal cache evicts the least recently used entry at capacity", async () => {
  const now = Date.now();
  const terminal = (id) =>
    job({
      id,
      status: "completed",
      updated_at: new Date(now - 1_000).toISOString(),
    });
  const jobs = new Map([
    ["job-a", terminal("job-a")],
    ["job-b", terminal("job-b")],
  ]);

  await readProjectJobAuthoritatively({
    jobs,
    localJobIds: new Set(["job-a"]),
    locallyManagedPersistedJobIds: new Set(),
    projectId: "project-1",
    jobId: "job-a",
    findPersisted: async () => null,
  });
  jobs.set("job-c", terminal("job-c"));

  assert.deepEqual(
    pruneTerminalProjectJobCache(jobs, {
      now,
      ttlMs: 10_000,
      maxEntries: 2,
    }),
    ["job-b"],
  );
  assert.deepEqual([...jobs.keys()], ["job-a", "job-c"]);
});

test("authoritative terminal read returns the result but does not retain it", async () => {
  const jobs = new Map();
  const persisted = job({
    status: "completed",
    result: { sensitive: "generated proposal" },
    updated_at: new Date().toISOString(),
  });

  const result = await readProjectJobAuthoritatively({
    jobs,
    localJobIds: new Set(),
    locallyManagedPersistedJobIds: new Set(),
    projectId: "project-1",
    jobId: "job-1",
    findPersisted: async () => persisted,
  });

  assert.deepEqual(result?.result, { sensitive: "generated proposal" });
  assert.equal(jobs.get("job-1")?.result, null);
});

test("skipped terminal persistence evicts stale running state", () => {
  const jobs = new Map([["job-1", job()]]);
  const progressWrites = new Map([
    ["job-1", { message: "Arbeider ...", writtenAt: 123 }],
  ]);
  const localJobIds = new Set();
  const locallyManagedPersistedJobIds = new Set(["job-1"]);

  reconcileTerminalProjectJobCache({
    jobs,
    progressWrites,
    localJobIds,
    locallyManagedPersistedJobIds,
    jobId: "job-1",
    patch: { status: "completed", message: "Ferdig." },
    persisted: false,
  });

  assert.equal(jobs.has("job-1"), false);
  assert.equal(progressWrites.has("job-1"), false);
  assert.equal(locallyManagedPersistedJobIds.has("job-1"), false);
});

test("successful terminal persistence retains status but not the result", () => {
  const jobs = new Map([["job-1", job()]]);
  const progressWrites = new Map([
    ["job-1", { message: "Arbeider ...", writtenAt: 123 }],
  ]);
  const localJobIds = new Set();
  const locallyManagedPersistedJobIds = new Set(["job-1"]);

  reconcileTerminalProjectJobCache({
    jobs,
    progressWrites,
    localJobIds,
    locallyManagedPersistedJobIds,
    jobId: "job-1",
    patch: {
      status: "completed",
      message: "Ferdig.",
      result: { ok: true },
    },
    persisted: true,
    updatedAt: "2026-07-11T20:06:00.000Z",
  });

  assert.equal(jobs.get("job-1")?.status, "completed");
  assert.equal(jobs.get("job-1")?.result, null);
  assert.equal(
    jobs.get("job-1")?.updated_at,
    "2026-07-11T20:06:00.000Z",
  );
  assert.equal(progressWrites.has("job-1"), false);
  assert.equal(locallyManagedPersistedJobIds.has("job-1"), false);
});
