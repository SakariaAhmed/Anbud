import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const testSupportPath = path.join(
  frontendRoot,
  "lib/server/document-chunks.test-support.ts",
);
process.env.OPENAI_API_KEY = "document-chunks-test-key";
process.env.APP_ENCRYPTION_KEY = "document-chunks-test-encryption-key";
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "document-chunks-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@/lib/server/supabase": testSupportPath,
    openai: testSupportPath,
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});
const {
  documentChunkMetadataMatchesSourceFingerprint,
  documentSourceKeysForMemoryFallback,
  ensureProjectDocumentChunks,
  isDocumentChunkReplacementLockConflict,
  projectDocumentChunkSourceFingerprint,
  replaceProjectDocumentChunks,
  serviceDocumentChunkSourceFingerprint,
  shouldReuseChunksAfterCompletenessQueryError,
  storedChunkMatchesCurrentSourceFingerprint,
  withDocumentChunkSourceFingerprint,
} = jiti(path.join(frontendRoot, "lib/server/document-chunks.ts"));
const { normalizeDocumentChunkStructureMap } = jiti(
  path.join(frontendRoot, "lib/server/document-chunk-structure.ts"),
);
const {
  getDocumentChunksTestEmbeddingRequestCount,
  getDocumentChunksTestManifest,
  resetDocumentChunksTestRuntime,
} = jiti(testSupportPath);

function projectDocument(overrides = {}) {
  return {
    id: "project-document-1",
    project_id: "project-1",
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: "Kravspesifikasjon",
    file_name: "krav.pdf",
    file_format: "pdf",
    raw_text: "K-1 Leverandøren skal dokumentere kapasitet.",
    structure_map: [
      {
        reference: "Side 1",
        text: "K-1 Leverandøren skal dokumentere kapasitet.",
        cells: { Krav: "K-1", Beskrivelse: "Kapasitet" },
      },
    ],
    ...overrides,
  };
}

function serviceDocument(overrides = {}) {
  return {
    id: "service-document-1",
    service_id: "service-1",
    title: "Driftstjeneste",
    file_name: "drift.md",
    file_format: "md",
    raw_text: "Tjenesten overvåkes hele døgnet.",
    structure_map: [
      {
        reference: "Overvåking",
        text: "Tjenesten overvåkes hele døgnet.",
      },
    ],
    ...overrides,
  };
}

test("project chunk fingerprint changes for same-length source content", () => {
  const original = projectDocument();
  const changed = {
    ...original,
    raw_text: original.raw_text.replace("kapasitet", "sikkerhet"),
  };
  assert.equal(original.raw_text.length, changed.raw_text.length);
  assert.notEqual(
    projectDocumentChunkSourceFingerprint(original),
    projectDocumentChunkSourceFingerprint(changed),
  );
});

test("service chunk fingerprint changes when structured source changes", () => {
  const original = serviceDocument();
  const changed = serviceDocument({
    structure_map: [
      {
        reference: "Overvåking",
        text: "Tjenesten varsles hele døgnet.",
      },
    ],
  });
  assert.notEqual(
    serviceDocumentChunkSourceFingerprint(original),
    serviceDocumentChunkSourceFingerprint(changed),
  );
});

test("chunk source fingerprint is stable across object key order", () => {
  const original = projectDocument();
  const reordered = projectDocument({
    structure_map: [
      {
        cells: { Beskrivelse: "Kapasitet", Krav: "K-1" },
        text: "K-1 Leverandøren skal dokumentere kapasitet.",
        reference: "Side 1",
      },
    ],
  });
  assert.equal(
    projectDocumentChunkSourceFingerprint(original),
    projectDocumentChunkSourceFingerprint(reordered),
  );
});

test("ingestion and hydrated ensure share one geometry-preserving fingerprint", async () => {
  resetDocumentChunksTestRuntime();
  const structureMap = [
    {
      reference: "Kravrad for kapasitet",
      text: "K-1 Leverandøren skal dokumentere kapasitet.",
      kind: "docling_table_row",
      parser: "docling",
      page: 7,
      table_index: 2,
      row_index: 4,
      columns: ["Krav-ID", "Krav"],
      cells: {
        "Krav-ID": "K-1",
        Krav: "Leverandøren skal dokumentere kapasitet.",
      },
      docling_ref: "#/tables/2/rows/4",
    },
  ];
  const hydratedDocument = projectDocument({
    chunk_source_revision: 3,
    structure_map: structureMap,
  });

  await replaceProjectDocumentChunks({
    documentId: hydratedDocument.id,
    projectId: hydratedDocument.project_id,
    role: hydratedDocument.role,
    supportingSubtype: hydratedDocument.supporting_subtype,
    title: hydratedDocument.title,
    fileName: hydratedDocument.file_name,
    fileFormat: hydratedDocument.file_format,
    rawText: hydratedDocument.raw_text,
    structureMap: normalizeDocumentChunkStructureMap(structureMap),
    sourceRevision: hydratedDocument.chunk_source_revision,
  });

  const manifest = getDocumentChunksTestManifest(
    "project_document",
    hydratedDocument.id,
  );
  assert.ok(manifest);
  assert.equal(
    manifest.sourceFingerprint,
    projectDocumentChunkSourceFingerprint(hydratedDocument),
  );
  assert.equal(manifest.rows.length, 1);
  assert.equal(manifest.rows[0].page_start, 7);
  assert.equal(manifest.rows[0].page_end, 7);
  assert.deepEqual(
    {
      structure_kind: manifest.rows[0].metadata.structure_kind,
      structure_parser: manifest.rows[0].metadata.structure_parser,
      structure_page: manifest.rows[0].metadata.structure_page,
      structure_table_index:
        manifest.rows[0].metadata.structure_table_index,
      structure_row_index: manifest.rows[0].metadata.structure_row_index,
      structure_docling_ref:
        manifest.rows[0].metadata.structure_docling_ref,
    },
    {
      structure_kind: "docling_table_row",
      structure_parser: "docling",
      structure_page: 7,
      structure_table_index: 2,
      structure_row_index: 4,
      structure_docling_ref: "#/tables/2/rows/4",
    },
  );

  const embeddingCallsAfterIngestion =
    getDocumentChunksTestEmbeddingRequestCount();
  assert.equal(embeddingCallsAfterIngestion, 1);
  await ensureProjectDocumentChunks({ document: hydratedDocument });
  await ensureProjectDocumentChunks({ document: hydratedDocument });
  assert.equal(
    getDocumentChunksTestEmbeddingRequestCount(),
    embeddingCallsAfterIngestion,
  );
});

test("project and service chunks rebuild when stored source fingerprint is stale", () => {
  const projectFingerprint = projectDocumentChunkSourceFingerprint(
    projectDocument(),
  );
  const serviceFingerprint = serviceDocumentChunkSourceFingerprint(
    serviceDocument(),
  );

  for (const fingerprint of [projectFingerprint, serviceFingerprint]) {
    const storedMetadata = withDocumentChunkSourceFingerprint(
      { content_hash: "chunk-content" },
      fingerprint,
    );
    assert.deepEqual(storedMetadata, {
      content_hash: "chunk-content",
      source_fingerprint: fingerprint,
      source_fingerprint_version: 1,
    });
    assert.equal(
      documentChunkMetadataMatchesSourceFingerprint(
        storedMetadata,
        fingerprint,
      ),
      true,
    );
    assert.equal(
      documentChunkMetadataMatchesSourceFingerprint(
        {
          source_fingerprint: "stale-fingerprint",
          source_fingerprint_version: 1,
        },
        fingerprint,
      ),
      false,
    );
    assert.equal(
      documentChunkMetadataMatchesSourceFingerprint({}, fingerprint),
      false,
    );
  }
});

test("chunk completeness query errors fail closed except absent legacy storage", () => {
  assert.equal(
    shouldReuseChunksAfterCompletenessQueryError({
      message: 'relation "document_chunks" does not exist',
    }),
    true,
  );
  assert.equal(
    shouldReuseChunksAfterCompletenessQueryError({
      message: "fetch failed while reading document chunks",
    }),
    false,
  );
  assert.equal(
    shouldReuseChunksAfterCompletenessQueryError({
      message: "permission denied for table document_chunks",
    }),
    false,
  );
});

test("stored retrieval rejects stale or missing source fingerprints", () => {
  const document = projectDocument();
  const fingerprint = projectDocumentChunkSourceFingerprint(document);
  const expected = new Map([[`project_document:${document.id}`, fingerprint]]);
  const row = {
    source_type: "project_document",
    source_id: document.id,
    metadata: withDocumentChunkSourceFingerprint(
      { content_hash: "current" },
      fingerprint,
    ),
  };

  assert.equal(storedChunkMatchesCurrentSourceFingerprint(row, expected), true);
  assert.equal(
    storedChunkMatchesCurrentSourceFingerprint(
      {
        ...row,
        metadata: withDocumentChunkSourceFingerprint(
          { content_hash: "stale" },
          "f".repeat(64),
        ),
      },
      expected,
    ),
    false,
  );
  assert.equal(
    storedChunkMatchesCurrentSourceFingerprint(
      { ...row, metadata: {} },
      expected,
    ),
    false,
  );
  assert.equal(
    storedChunkMatchesCurrentSourceFingerprint(row, new Map()),
    false,
  );
});

test("one current stored source cannot suppress memory fallback for a stale source", () => {
  const missing = documentSourceKeysForMemoryFallback(
    ["project_document:source-a", "project_document:source-b"],
    1,
    new Set(["project_document:source-a"]),
  );
  assert.deepEqual([...missing], ["project_document:source-a"]);
});

test("top-N retrieval does not memory-reparse 99 fresh omitted sources", () => {
  const requested = Array.from(
    { length: 100 },
    (_, index) => `project_document:source-${index + 1}`,
  );
  assert.deepEqual(
    [...documentSourceKeysForMemoryFallback(requested, 1, new Set())],
    [],
  );
  assert.equal(
    documentSourceKeysForMemoryFallback(requested, 0, new Set()).size,
    100,
  );
});

test("chunk replacement retries only lock/deadlock conflicts", () => {
  assert.equal(
    isDocumentChunkReplacementLockConflict({ code: "55P03" }),
    true,
  );
  assert.equal(
    isDocumentChunkReplacementLockConflict({ code: "40P01" }),
    true,
  );
  assert.equal(
    isDocumentChunkReplacementLockConflict({
      message: "deadlock detected while replacing chunks",
    }),
    true,
  );
  assert.equal(
    isDocumentChunkReplacementLockConflict({
      code: "23514",
      message: "source manifest mismatch",
    }),
    false,
  );
});
