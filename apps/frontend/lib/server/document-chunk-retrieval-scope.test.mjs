import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const sqlContracts = [
  ["supabase/schema.sql", 3],
  ["supabase/document_chunks_and_embeddings.sql", 3],
  ["supabase/hybrid_document_retrieval.sql", 2],
  [
    "supabase/migrations/20260711124500_selected_service_document_retrieval.sql",
    3,
  ],
];

const explicitSelectedServiceGuard =
  /project_filter is null\s+or document_chunks\.project_id = project_filter\s+or \(\s+source_id_filter is not null\s+and document_chunks\.source_type = 'service_document'\s+and document_chunks\.project_id is null\s+and document_chunks\.source_id = any\(source_id_filter\)\s+\)/gu;
const explicitSourceFilter =
  /and \(source_id_filter is null or document_chunks\.source_id = any\(source_id_filter\)\)/gu;

test("all vector and hybrid SQL paths admit only explicitly selected service chunks", () => {
  for (const [relativePath, expectedPathCount] of sqlContracts) {
    const sql = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    assert.equal(
      sql.match(explicitSelectedServiceGuard)?.length ?? 0,
      expectedPathCount,
      `${relativePath} må beskytte alle retrieval-paths med service-scope`,
    );
    assert.equal(
      sql.match(explicitSourceFilter)?.length ?? 0,
      expectedPathCount,
      `${relativePath} må beholde eksplisitt source_id-filter`,
    );
  }
});

function matchesSqlRetrievalScope(row, projectFilter, sourceIdFilter) {
  const explicitlySelected =
    sourceIdFilter === null || sourceIdFilter.includes(row.sourceId);
  const inProjectOrSelectedService =
    projectFilter === null ||
    row.projectId === projectFilter ||
    (sourceIdFilter !== null &&
      row.sourceType === "service_document" &&
      row.projectId === null &&
      sourceIdFilter.includes(row.sourceId));
  return explicitlySelected && inProjectOrSelectedService;
}

test("retrieval scope returns own project and selected service chunks without global leakage", () => {
  const rows = [
    {
      id: "own-project",
      sourceType: "project_document",
      sourceId: "project-document-1",
      projectId: "project-1",
    },
    {
      id: "own-project-unselected",
      sourceType: "project_document",
      sourceId: "project-document-2",
      projectId: "project-1",
    },
    {
      id: "selected-service",
      sourceType: "service_document",
      sourceId: "service-document-1",
      projectId: null,
    },
    {
      id: "unselected-service",
      sourceType: "service_document",
      sourceId: "service-document-2",
      projectId: null,
    },
    {
      id: "other-project",
      sourceType: "project_document",
      sourceId: "other-project-document",
      projectId: "project-2",
    },
  ];
  const selectedIds = [
    "project-document-1",
    "service-document-1",
    "other-project-document",
  ];

  assert.deepEqual(
    rows
      .filter((row) => matchesSqlRetrievalScope(row, "project-1", selectedIds))
      .map((row) => row.id),
    ["own-project", "selected-service"],
  );
  assert.deepEqual(
    rows
      .filter((row) => matchesSqlRetrievalScope(row, "project-1", null))
      .map((row) => row.id),
    ["own-project", "own-project-unselected"],
  );
});
