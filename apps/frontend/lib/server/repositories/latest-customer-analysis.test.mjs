import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const support = path.join(root, "lib/server/repositories/data-store.persistence.test-support.ts");
const jiti = createJiti(import.meta.url, { alias: {
  "next/cache": support, "@/lib/server/data-api": support,
  "@/lib/server/file-storage-azure": support, "@/lib/server/document-chunks": support,
  "@/lib/server/repositories/lease-fenced-persistence": support,
  "@/lib/server/project-workflow-cancellation": support,
  "@": root, "server-only": "/dev/null",
} });
process.env.APP_ENCRYPTION_KEY ||= "latest-analysis-test-encryption-key";
const { setPostgRESTStorePersistenceTestClient } = jiti(support);
const { encryptJson } = jiti(path.join(root, "lib/server/crypto.ts"));
const { getProjectResultHistory } = jiti("./data-store.ts");

function configureHistory(rows, error = null) {
  setPostgRESTStorePersistenceTestClient({ from(table) {
    assert.equal(table, "project_result_history");
    const filters = [];
    const order = [];
    let limit = Infinity;
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      order(key, { ascending }) { order.push([key, ascending ? 1 : -1]); return query; },
      limit(value) { limit = value; return query; },
      then(resolve, reject) {
        const data = rows.filter(row => filters.every(filter => filter(row))).sort((a,b) => {
          for (const [key, direction] of order) {
            const difference = String(a[key]).localeCompare(String(b[key])) * direction;
            if (difference) return difference;
          }
          return 0;
        }).slice(0, limit);
        return Promise.resolve({ data, error }).then(resolve, reject);
      },
    };
    return query;
  } });
}
function entry(id, archivedAt, overrides = {}) {
  return { id, project_id: "project-a", kind: "customer_analyses", archived_at: archivedAt,
    reason: "source_changed", result_json: encryptJson({ customer_profile_summary: id }), ...overrides };
}

test("latest display finds the newest customer analysis beyond 30 unrelated results and excludes other projects", async () => {
  configureHistory([
    entry("older", "2026-09-01T00:00:00Z"),
    entry("latest", "2026-09-02T00:00:00Z"),
    entry("private", "2026-09-09T00:00:00Z", { project_id: "project-b" }),
    ...Array.from({length:35}, (_, i) => entry(`evaluation-${i}`, "2026-09-08T00:00:00Z", {kind:"solution_evaluations"})),
  ]);
  const latest = await getProjectResultHistory("project-a", true);
  assert.deepEqual(latest.map(row => row.id), ["latest"]);
  assert.equal(latest[0].result_json.customer_profile_summary, "latest");
  assert.equal((await getProjectResultHistory("project-a")).length, 30);
});

test("latest display has a deterministic tie break and does not invent an analysis for a new project", async () => {
  configureHistory([entry("a", "2026-09-01T00:00:00Z"), entry("b", "2026-09-01T00:00:00Z")]);
  assert.deepEqual((await getProjectResultHistory("project-a", true)).map(row => row.id), ["b"]);
  assert.deepEqual(await getProjectResultHistory("new-project", true), []);
});

test("a failed history read is an error, never an empty successful analysis", async () => {
  configureHistory([], {message:"Backend unavailable"});
  await assert.rejects(getProjectResultHistory("project-a", true), /Backend unavailable/);
});
