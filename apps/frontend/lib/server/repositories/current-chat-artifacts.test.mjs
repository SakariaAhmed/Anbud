import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "../../..");
const directory = mkdtempSync(path.join(tmpdir(), "current-chat-artifacts-"));
const backend = path.join(directory, "backend.cjs");
writeFileSync(backend, "exports.createServiceClient = () => globalThis.__currentChatArtifactsTest.client;");
const jiti = createJiti(import.meta.url, { alias: {
  "@/lib/server/data-api": backend, "@": root, "server-only": "/dev/null",
} });
const { listCurrentGeneratedArtifactsFresh, listGeneratedArtifactsFresh } = jiti("./artifacts.ts");
test.after(() => { delete globalThis.__currentChatArtifactsTest; rmSync(directory, { recursive: true, force: true }); });

const projectId = "00000000-0000-4000-8000-000000000101";
function row(id, type = "losningsutkast", version = 1, extra = {}) {
  return { id, project_id: projectId, artifact_type: type, artifact_version: version,
    title: id, content_markdown: `Synthetic artifact ${id}`, input_snapshot: {},
    created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-01T10:00:00.000Z",
    input_artifact_source_revision: 2, input_service_library_revision: 1, ...extra };
}
const authorityFor = (...rows) => rows.map(value => ({
  id: value.id, artifact_type: value.artifact_type,
  artifact_version: value.artifact_version, source_is_current: true,
}));
function harness(rows, authority) {
  const state = { rows, authority, bodyQueries: [], authorityQueries: [], bodyOverride: null,
    onBodyRead: null, authorityError: null, bodyError: null };
  state.client = {
    async rpc(name, input) {
      assert.equal(name, "get_artifact_authority_summary");
      state.authorityQueries.push(input);
      return { data: structuredClone(state.authority), error: state.authorityError };
    },
    from(table) {
      assert.equal(table, "generated_artifacts");
      const filters = [], orders = [];
      let limit = Infinity;
      const query = {
        select() { return query; },
        eq(column, value) { filters.push({ column, value }); return query; },
        in(column, values) { filters.push({ column, values }); return query; },
        order(column, options) { orders.push({ column, ...options }); return query; },
        limit(value) { limit = value; return query; },
        then(resolve, reject) {
          state.bodyQueries.push({ filters, limit });
          const selected = state.rows.filter(value => filters.every(filter => filter.values
            ? filter.values.includes(value[filter.column]) : value[filter.column] === filter.value));
          selected.sort((left, right) => {
            for (const order of orders) {
              const compare = String(left[order.column]).localeCompare(String(right[order.column]));
              if (compare) return order.ascending === false ? -compare : compare;
            }
            return 0;
          });
          const data = structuredClone(state.bodyOverride ?? selected.slice(0, limit));
          state.onBodyRead?.();
          return Promise.resolve({ data, error: state.bodyError }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  globalThis.__currentChatArtifactsTest = state;
  return state;
}

test("chat loads an older current artifact even behind more than 250 versions of another type", async () => {
  const history = Array.from({ length: 300 }, (_, index) => row(`recent-${String(index).padStart(3, "0")}`, "losningsutkast", index + 1));
  const relevant = row("older-current", "anbefalt_arkitektur", 1, {
    content_markdown: "Relevant beredskap og geografisk gjenoppretting.", created_at: "2026-10-01T00:00:00.000Z",
  });
  const state = harness([...history, relevant], authorityFor(history.at(-1), relevant));
  const uiHistory = await listGeneratedArtifactsFresh(projectId);
  assert.equal(uiHistory.length, 250);
  assert.equal(uiHistory.some(artifact => artifact.id === relevant.id), false);

  state.bodyQueries = [];
  const current = await listCurrentGeneratedArtifactsFresh(projectId);
  assert.equal(current.length, 2);
  assert.equal(current.find(artifact => artifact.id === relevant.id).content_markdown, relevant.content_markdown);
  assert.ok(current.every(artifact => artifact.is_current && artifact.source_is_current));
  assert.deepEqual(state.bodyQueries[0].filters, [
    { column: "project_id", value: projectId },
    { column: "id", values: [history.at(-1).id, relevant.id] },
  ]);
  assert.equal(state.bodyQueries[0].limit, Infinity);
});

test("chat excludes stale, unlisted, mismatched-version and other-project rows", async () => {
  const current = row("current"), stale = row("stale", "forbedret_kravsvar"), missing = row("missing-manifest", "anbefalt_arkitektur");
  const state = harness([current, stale, missing], [
    ...authorityFor(current), { ...authorityFor(stale)[0], source_is_current: false },
  ]);
  state.bodyOverride = [
    current, stale, missing,
    row("foreign", "tilbudsstrategi", 1, { project_id: "another-project" }),
    row("wrong-version", "losningsutkast", 2),
  ];
  assert.deepEqual((await listCurrentGeneratedArtifactsFresh(projectId)).map(artifact => artifact.id), [current.id]);
  assert.deepEqual(state.bodyQueries[0].filters[1].values, [current.id]);
  for (const malformed of [
    { ...current, project_id: "another-project" },
    { ...current, artifact_version: 2 },
    { ...current, artifact_type: "tilbudsstrategi" },
    { ...current, content_markdown: null },
  ]) {
    state.bodyOverride = [malformed];
    assert.deepEqual(await listCurrentGeneratedArtifactsFresh(projectId), []);
  }
});

test("missing authority never turns an arbitrary history row into a current artifact", async () => {
  const state = harness([row("legacy")], []);
  assert.deepEqual(await listCurrentGeneratedArtifactsFresh(projectId), []);
  assert.deepEqual(state.bodyQueries, []);
});

for (const change of ["new-version", "source-invalidated", "deleted"]) {
  test(`chat drops an artifact when ${change} races its body read`, async () => {
    const original = row("original");
    const replacement = row("replacement", "losningsutkast", 2);
    const state = harness([original, replacement], authorityFor(original));
    state.onBodyRead = () => {
      state.authority = change === "new-version" ? authorityFor(replacement)
        : change === "deleted" ? [] : [{ ...authorityFor(original)[0], source_is_current: false }];
    };
    assert.deepEqual(await listCurrentGeneratedArtifactsFresh(projectId), []);
    assert.equal(state.authorityQueries.length, 2);
    if (change === "new-version") {
      state.onBodyRead = null;
      assert.deepEqual((await listCurrentGeneratedArtifactsFresh(projectId)).map(artifact => artifact.id), [replacement.id]);
    }
  });
}

test("chat does not hide database or malformed-authority errors as an empty knowledge set", async () => {
  const original = row("original");
  const state = harness([original], authorityFor(original));
  state.authorityError = { message: "Synthetic authority lookup failure" };
  await assert.rejects(listCurrentGeneratedArtifactsFresh(projectId), /Synthetic authority lookup failure/u);
  state.authorityError = null;
  state.bodyError = { message: "Synthetic body query failure" };
  await assert.rejects(listCurrentGeneratedArtifactsFresh(projectId), /Synthetic body query failure/u);
  state.bodyError = null;
  state.authority = [{ id: original.id, artifact_type: "losningsutkast", artifact_version: "invalid", source_is_current: true }];
  await assert.rejects(listCurrentGeneratedArtifactsFresh(projectId), /ugyldig autoritetsstatus/u);
});
