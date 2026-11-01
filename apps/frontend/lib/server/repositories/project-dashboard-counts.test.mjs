import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

const frontend = path.resolve(import.meta.dirname, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { fetchProjectDashboardCounts, parseProjectDashboardCounts, parseProjectEvaluationCurrentness } =
  jiti("./project-dashboard-counts.ts");
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const P3 = "00000000-0000-4000-8000-000000000003";
const counts = (project_id, overrides = {}) => ({ project_id, document_count: 0, supporting_document_count: 0, artifact_count: 0, ...overrides });

test("count payloads preserve complete, uneven and empty project totals", () => {
  assert.deepEqual(parseProjectDashboardCounts([
    counts(P1, { document_count: "5010", supporting_document_count: "5008", artifact_count: "10010" }),
    counts(P2, { document_count: 1, supporting_document_count: 1, artifact_count: 1 }),
    counts(P3),
  ], [P1, P2, P3]), new Map([
    [P1, { document_count: 5010, supporting_document_count: 5008, artifact_count: 10010 }],
    [P2, { document_count: 1, supporting_document_count: 1, artifact_count: 1 }],
    [P3, { document_count: 0, supporting_document_count: 0, artifact_count: 0 }],
  ]));
});

test("missing, duplicated, unrelated or invalid count data never becomes zero", () => {
  for (const value of [null, {}, [], [counts(P1), counts(P1)], [counts(P2)], [counts(P1), counts(P2)],
    ...[-1, 1.2, "", " 0 ", false, "9007199254740992", null].map(document_count => [counts(P1, { document_count })]),
    [counts(P1, { supporting_document_count: 1 })],
  ]) assert.throws(() => parseProjectDashboardCounts(value, [P1]), /gyldige prosjekttellinger/u);
  assert.throws(() => parseProjectDashboardCounts([counts(P1)], [P1, P1]));
});

test("count query errors propagate and empty pages do not call the database", async () => {
  let called = false;
  const client = { rpc: async () => { called = true; return { data: null, error: { message: "private backend detail" } }; } };
  assert.deepEqual(await fetchProjectDashboardCounts(client, []), new Map());
  assert.equal(called, false);
  await assert.rejects(fetchProjectDashboardCounts(client, [P1]), error => {
    assert.equal(error.message, "Kunne ikke hente prosjekttellingene.");
    return true;
  });
});

test("evaluation currentness requires an exact boolean result for every selected project", () => {
  assert.deepEqual(parseProjectEvaluationCurrentness({ [P1]: false, [P2]: true }, [P1, P2]), { [P1]: false, [P2]: true });
  for (const value of [null, [], {}, { [P1]: "true" }, { [P1]: false, [P2]: true }]) {
    assert.throws(() => parseProjectEvaluationCurrentness(value, [P1]));
  }
});

// Execute the current repository function with I/O injected, matching the
// existing SQL audit harness. No copied listing or counting implementation.
function actual(file, names, dependencies) {
  const source = ts.createSourceFile(file, readFileSync(path.join(frontend, file), "utf8"), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length);
  const code = ts.transpileModule(functions.map(node => node.getText(source).replace(/^export\s+/u, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn {${names.join(",")}};`)(...Object.values(dependencies));
}
const { fromUnknownProjectRow } = actual("lib/server/repositories/project-rows.ts", ["fromUnknownProjectRow"], {});
const { mapProjectStatus } = actual("lib/server/repositories/data-store.ts", ["mapProjectStatus"], {});
const { mapProjectSummary } = actual("lib/server/repositories/data-store.ts", ["mapProjectSummary"], { mapProjectStatus });

function listing({ accessible = null, projects = [{ id: P1 }, { id: P2 }], countRows, countError = null, projectError = null, currentness, ignoreScope = false, deletedAfterPage = [], existenceError = null, existenceCount } = {}) {
  const calls = [];
  let aggregated = false;
  const client = {
    from(table) {
      const filters = [];
      // Also model the old row-fetching implementation so the large-count
      // regression fails because its real limits truncate data, not because
      // its former dependencies are missing from this harness.
      const tableRows = () => table === "projects" ? projects.filter(row => !aggregated || !deletedAfterPage.includes(row.id)) : (countRows ?? []).flatMap(row =>
        Array.from({ length: Number(table === "documents" ? row.document_count : row.artifact_count) }, (_, index) => ({
          id: `${row.project_id}-${index}`, project_id: row.project_id,
          role: index < Number(row.supporting_document_count) ? "supporting_document" : "primary_customer_document",
        })),
      );
      let limit = Infinity;
      let head = false;
      const query = {
        select: (_columns, options) => { head = options?.head === true; return query; }, order: () => query,
        in: (column, values) => { filters.push({ column, values }); return query; },
        limit: count => { limit = count; return query; },
        then(resolve, reject) {
          const rows = tableRows().filter(row => ignoreScope || filters.every(filter => filter.values.includes(row[filter.column]))).slice(0, limit);
          calls.push({ table, head, filters, rows: rows.map(row => row.id) });
          const error = head ? existenceError : table === "projects" ? projectError : table === "generated_artifacts" ? countError : null;
          return Promise.resolve({ data: error || head ? null : rows, error, count: head ? (existenceCount === undefined ? rows.length : existenceCount) : null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "get_project_dashboard_counts") {
        aggregated = true;
        return { data: countRows ?? args.p_project_ids.map(id => counts(id)), error: countError };
      }
      assert.equal(name, "get_solution_evaluation_currentness");
      return { data: currentness ?? Object.fromEntries(args.p_project_ids.map(id => [id, false])), error: null };
    },
  };
  const { listProjects } = actual("lib/server/repositories/data-store.ts", ["listProjects"], {
    listAccessibleProjectIds: async (_principal, options) => options?.admin ? null : accessible,
    unstable_cache: callback => callback, createServiceClient: () => client,
    PROJECT_LIST_LIMIT: 500, PROJECTS_LIST_TAG: "projects", fromUnknownProjectRow,
    mapProjectSummary, fetchProjectDashboardCounts, parseProjectEvaluationCurrentness,
    fetchDocumentSummaryRows: async build => (await build("id,project_id,role")).data,
  });
  return { listProjects, calls };
}

test("dashboard aggregates only its authorized page and preserves project status", async () => {
  const { listProjects, calls } = listing({ accessible: [P2], projects: [{ id: P1 }, { id: P2, title: "Visible", customer_analysis_generated: true }],
    countRows: [counts(P2, { document_count: 5010, supporting_document_count: 5008, artifact_count: 10010 })], currentness: { [P2]: true } });
  const rows = await listProjects("non-admin");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, P2);
  assert.equal(rows[0].name, "Visible");
  assert.equal(rows[0].status, "Kundeanalyse klar");
  assert.equal(rows[0].solution_evaluation_generated, true);
  assert.deepEqual([rows[0].document_count, rows[0].supporting_document_count, rows[0].artifact_count], [5010, 5008, 10010]);
  assert.deepEqual(calls.find(call => call.name === "get_project_dashboard_counts").args.p_project_ids, [P2]);
});

test("administrator listing covers the complete page without a project grant", async () => {
  const { listProjects, calls } = listing({ accessible: [] });
  assert.equal((await listProjects("admin", { admin: true })).length, 2);
  assert.deepEqual(calls.find(call => call.name === "get_project_dashboard_counts").args.p_project_ids, [P1, P2]);
});

test("no grants or an empty project page require no aggregate or status queries", async () => {
  for (const scenario of [{ accessible: [] }, { projects: [] }]) {
    const { listProjects, calls } = listing(scenario);
    assert.deepEqual(await listProjects("non-admin"), []);
    assert.equal(calls.some(call => call.name), false);
  }
});

test("dashboard rejects failed counts and malformed currentness instead of caching valid-looking zeros", async () => {
  for (const scenario of [{ countError: { message: "database unavailable" } }, { countRows: [] }, { currentness: {} }]) {
    await assert.rejects(listing(scenario).listProjects("user"));
  }
});


test("a backend project row outside the authorization scope is rejected before aggregation", async () => {
  const { listProjects, calls } = listing({ accessible: [P2], ignoreScope: true });
  await assert.rejects(listProjects("non-admin"), /prosjektlisten/u);
  assert.equal(calls.some(call => call.name), false);
});

test("a project query failure prevents all downstream count and status calls", async () => {
  const { listProjects, calls } = listing({ projectError: { message: "Synthetic project query failure" } });
  await assert.rejects(listProjects("user"), /Synthetic project query failure/u);
  assert.equal(calls.some(call => call.name), false);
});


test("a project deleted between page and aggregate reads is independently confirmed and omitted", async () => {
  const { listProjects, calls } = listing({ countRows: [counts(P1)], deletedAfterPage: [P2] });
  const result = await listProjects("user");
  assert.deepEqual(result.map(project => project.id), [P1]);
  const checks = calls.filter(call => call.head);
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].filters, [{ column: "id", values: [P2] }]);
  assert.deepEqual(calls.find(call => call.name === "get_solution_evaluation_currentness").args.p_project_ids, [P1]);
});

test("missing counts for a surviving project fail after one existence check", async () => {
  const { listProjects, calls } = listing({ countRows: [counts(P1)] });
  await assert.rejects(listProjects("user"), /gyldige prosjekttellinger/u);
  assert.equal(calls.filter(call => call.head).length, 1);
  assert.equal(calls.filter(call => call.name === "get_project_dashboard_counts").length, 1);
});

test("an entirely deleted page returns no projects and performs no currentness lookup", async () => {
  const { listProjects, calls } = listing({ countRows: [], deletedAfterPage: [P1, P2] });
  assert.deepEqual(await listProjects("user"), []);
  assert.equal(calls.filter(call => call.head).length, 1);
  assert.equal(calls.some(call => call.name === "get_solution_evaluation_currentness"), false);
});

test("an unconfirmed deletion or malformed aggregate cannot be mistaken for a deleted project", async () => {
  for (const scenario of [
    { countRows: [counts(P1)], deletedAfterPage: [P2], existenceError: { message: "Synthetic outage" } },
    { countRows: [counts(P1)], deletedAfterPage: [P2], existenceCount: null },
    { countRows: [counts(P1, { artifact_count: -1 })], deletedAfterPage: [P2] },
    { countRows: [counts(P1), counts(P1)], deletedAfterPage: [P2] },
  ]) {
    const { listProjects } = listing(scenario);
    await assert.rejects(listProjects("user"));
  }
});
