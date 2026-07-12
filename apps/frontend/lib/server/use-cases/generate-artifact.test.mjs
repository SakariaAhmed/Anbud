import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "generate-artifact-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  artifactSourceSnapshotHash,
  assertCompleteRequirementDocumentScope,
  assertRequirementDocumentsReadyForGeneration,
  buildArtifactProjectDocumentManifests,
  documentLedgerCacheKey,
  hydrateRequirementFileDocuments,
  resolveRequestedSourceDocuments,
  selectRequirementDocumentsForArtifact,
} = jiti(
  path.join(frontendRoot, "lib/server/use-cases/generate-artifact.ts"),
);

test("all-doc scope preserves two ready requirement documents", () => {
  const requirements = [document("requirements-a"), document("requirements-b")];
  assert.doesNotThrow(() =>
    assertCompleteRequirementDocumentScope({
      requestedDocumentIds: requirements.map((item) => item.id),
      requiredFormalDocuments: requirements,
    }),
  );
  assert.throws(
    () =>
      assertCompleteRequirementDocumentScope({
        requestedDocumentIds: [requirements[0].id],
        requiredFormalDocuments: requirements,
      }),
    /alle klassifiserte kravdokumenter.*requirements-b/u,
  );
});

test("explicit ready selection cannot omit a queued formal requirement document", () => {
  const ready = document("ready");
  const queued = { ...document("queued"), processing_status: "queued" };

  assert.throws(
    () =>
      assertCompleteRequirementDocumentScope({
        requestedDocumentIds: [ready.id],
        requiredFormalDocuments: [ready, queued],
      }),
    /alle klassifiserte kravdokumenter.*queued/u,
  );
});

test("requested source resolution keeps 13 IDs and rejects an unknown ID", () => {
  const documents = Array.from({ length: 13 }, (_, index) =>
    document(`requirements-${index + 1}`),
  );
  assert.deepEqual(
    resolveRequestedSourceDocuments({
      requestedDocumentIds: documents.map((item) => item.id),
      projectDocuments: documents,
    }).map((item) => item.id),
    documents.map((item) => item.id),
  );
  assert.throws(
    () =>
      resolveRequestedSourceDocuments({
        requestedDocumentIds: [documents[0].id, "unknown-document"],
        projectDocuments: documents,
      }),
    /ukjente eller utilgjengelige.*unknown-document/u,
  );
});

function document(id, fileFormat = "docx", fileBase64 = "") {
  return {
    id,
    project_id: "project-1",
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: `Kravfil ${id}`,
    file_name: `${id}.${fileFormat}`,
    file_format: fileFormat,
    content_type: "application/octet-stream",
    file_size_bytes: 10,
    page_count: 1,
    file_base64: fileBase64,
    raw_text: `Krav fra ${id}`,
    structure_map: [],
    processing_status: "basic_ready",
    processing_message: null,
    processing_error: null,
    parser_used: "test",
    indexed_at: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
  };
}

test("hydrates every selected requirement file with concurrency capped at three", async () => {
  const documents = [
    ...Array.from({ length: 7 }, (_, index) => document(`doc-${index + 1}`)),
    document("notes", "md"),
  ];
  const documentsById = new Map(documents.map((item) => [item.id, item]));
  const calls = [];
  let active = 0;
  let maxActive = 0;

  const hydrated = await hydrateRequirementFileDocuments({
    projectId: "project-1",
    documents,
    loadDocument: async (projectId, documentId) => {
      assert.equal(projectId, "project-1");
      calls.push(documentId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return {
          ...documentsById.get(documentId),
          file_base64: `base64-${documentId}`,
        };
      } finally {
        active -= 1;
      }
    },
  });

  assert.deepEqual(
    calls.sort(),
    documents.slice(0, 7).map((item) => item.id).sort(),
  );
  assert.equal(maxActive, 3);
  assert.deepEqual(
    hydrated.map((item) => item.id),
    documents.map((item) => item.id),
  );
  assert.ok(hydrated.slice(0, 7).every((item) => item.file_base64));
  assert.equal(hydrated[7].file_base64, "");
});

test("fails closed when a selected requirement file cannot be hydrated", async () => {
  await assert.rejects(
    hydrateRequirementFileDocuments({
      projectId: "project-1",
      documents: [document("doc-failed")],
      loadDocument: async () => {
        throw new Error("storage unavailable");
      },
    }),
    /Kravfilen "Kravfil doc-failed" \(doc-failed\) kunne ikke hydreres: storage unavailable/,
  );

  await assert.rejects(
    hydrateRequirementFileDocuments({
      projectId: "project-1",
      documents: [document("doc-empty")],
      loadDocument: async () => document("doc-empty"),
    }),
    /Kravfilen "Kravfil doc-empty" \(doc-empty\) mangler originalt filinnhold/,
  );
});

test("artifact source snapshot fingerprints hydrated requirement file bytes", () => {
  const listedDocument = document("source-provenance");
  const firstBytes = Buffer.from("first exact requirement file bytes");
  const changedBytes = Buffer.from("changed exact requirement file bytes");
  const manifestFor = (bytes) =>
    buildArtifactProjectDocumentManifests({
      documents: [listedDocument],
      hydratedRequirementDocuments: new Map([
        [
          listedDocument.id,
          {
            ...listedDocument,
            file_base64: bytes.toString("base64"),
          },
        ],
      ]),
    });

  const firstManifest = manifestFor(firstBytes);
  const changedManifest = manifestFor(changedBytes);
  const unhydratedManifest = buildArtifactProjectDocumentManifests({
    documents: [listedDocument],
  });

  assert.equal(
    firstManifest[0].original_file_sha256,
    createHash("sha256").update(firstBytes).digest("hex"),
  );
  assert.equal(unhydratedManifest[0].original_file_sha256, null);
  assert.notEqual(firstManifest[0].content_hash, unhydratedManifest[0].content_hash);
  assert.notEqual(firstManifest[0].content_hash, changedManifest[0].content_hash);
  assert.notEqual(
    artifactSourceSnapshotHash({ project_documents: firstManifest }),
    artifactSourceSnapshotHash({ project_documents: changedManifest }),
  );
});

test("artifact source snapshot binds requested and canonical source scopes separately", () => {
  const canonicalScope = {
    requested_source_document_ids: ["formal"],
    declared_source_document_ids: ["customer", "formal"],
  };
  const changedRequest = {
    ...canonicalScope,
    requested_source_document_ids: ["customer", "formal"],
  };

  assert.notEqual(
    artifactSourceSnapshotHash(canonicalScope),
    artifactSourceSnapshotHash(changedRequest),
  );
});

test("forbedret kravsvar treats an explicit rfp subtype as requirement input", () => {
  const customerDocument = {
    ...document("customer"),
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Kundens beskrivelse",
    file_name: "customer.pdf",
  };
  const rfpDocument = {
    ...document("rfp"),
    supporting_subtype: "rfp",
    title: "Dokument A",
    file_name: "document-a.pdf",
  };

  const selected = selectRequirementDocumentsForArtifact({
    selectedDocumentIds: new Set(),
    selectedRequirementDocuments: [],
    projectDocuments: [customerDocument, rfpDocument],
    customerDocument,
    solutionDocument: null,
    supportingDocuments: [rfpDocument],
  });

  assert.deepEqual(selected.map((item) => item.id), [rfpDocument.id]);
});

test("requirement generation accepts only ready documents with readable content", () => {
  assert.doesNotThrow(() =>
    assertRequirementDocumentsReadyForGeneration([document("ready-text")]),
  );
  assert.doesNotThrow(() =>
    assertRequirementDocumentsReadyForGeneration([
      {
        ...document("ready-structure"),
        raw_text: "",
        structure_map: [
          {
            reference: "Rad 1",
            text: "",
            cells: { Krav: "Leverandøren skal dokumentere kontrollen." },
          },
        ],
      },
    ]),
  );
});

test("requirement generation fails closed while ingestion is incomplete", () => {
  for (const processing_status of ["queued", "processing"]) {
    assert.throws(
      () =>
        assertRequirementDocumentsReadyForGeneration([
          { ...document(processing_status), processing_status },
        ]),
      /ikke ferdig indeksert/i,
    );
  }
});

test("requirement generation rejects failed, empty, and missing selections", () => {
  assert.throws(
    () =>
      assertRequirementDocumentsReadyForGeneration([
        {
          ...document("failed"),
          processing_status: "failed",
          processing_error: "parser failure",
        },
      ]),
    /kunne ikke indekseres.*parser failure/i,
  );
  assert.throws(
    () =>
      assertRequirementDocumentsReadyForGeneration([
        { ...document("empty"), raw_text: "", structure_map: [] },
      ]),
    /mangler lesbar tekst eller struktur/i,
  );
  assert.throws(
    () => assertRequirementDocumentsReadyForGeneration([]),
    /ingen valgte kravdokumenter/i,
  );
});

test("document ledger cache key fingerprints content instead of text length", () => {
  const original = document("same-length");
  const changed = {
    ...original,
    raw_text: original.raw_text.replace("fra", "hos"),
  };
  assert.equal(original.raw_text.length, changed.raw_text.length);

  const originalKey = documentLedgerCacheKey({
    artifactType: "forbedret_kravsvar",
    documents: [original],
  });
  const changedKey = documentLedgerCacheKey({
    artifactType: "forbedret_kravsvar",
    documents: [changed],
  });

  assert.notEqual(originalKey, changedKey);
  assert.equal(
    originalKey,
    documentLedgerCacheKey({
      artifactType: "forbedret_kravsvar",
      documents: [{ ...original, updated_at: "2027-01-01T00:00:00.000Z" }],
    }),
  );
});

test("document ledger cache key fingerprints canonicalized structure content", () => {
  const original = {
    ...document("structured"),
    structure_map: [
      {
        reference: "Rad 1",
        text: "Kravtabell",
        cells: { Krav: "K-1", Beskrivelse: "Kapasitet" },
      },
    ],
  };
  const changed = {
    ...original,
    structure_map: [
      {
        reference: "Rad 1",
        text: "Kravtabell",
        cells: { Krav: "K-1", Beskrivelse: "Sikkerhet" },
      },
    ],
  };
  const reordered = {
    ...original,
    structure_map: [
      {
        cells: { Beskrivelse: "Kapasitet", Krav: "K-1" },
        text: "Kravtabell",
        reference: "Rad 1",
      },
    ],
  };
  const keyFor = (source) =>
    documentLedgerCacheKey({
      artifactType: "forbedret_kravsvar",
      documents: [source],
    });

  assert.notEqual(keyFor(original), keyFor(changed));
  assert.equal(keyFor(original), keyFor(reordered));
});
