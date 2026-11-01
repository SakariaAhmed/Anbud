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
    "@/lib/server/data-api": testSupportPath,
    openai: testSupportPath,
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});
const {
  buildKeywordSearchQuery,
  documentChunkMetadataMatchesSourceFingerprint,
  documentSourceKeysForMemoryFallback,
  ensureProjectDocumentChunks,
  isDocumentChunkReplacementLockConflict,
  projectDocumentChunkSourceFingerprint,
  replaceProjectDocumentChunks,
  retrieveDocumentSnippetsWithMetadata,
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
  getDocumentChunksTestRpcCalls,
  resetDocumentChunksTestRuntime,
  setDocumentChunksTestRetrievalRows,
} = jiti(testSupportPath);
const { encryptString } = jiti(path.join(frontendRoot, "lib/server/crypto.ts"));

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

test("prompt-covered chunks do not consume retrieval slots or hide other source identities", async () => {
  resetDocumentChunksTestRuntime();
  const text = "K-1 Leverandøren skal dokumentere sikkerhet og kapasitet – inklu\u0000dert i tjenesten.";
  const first = projectDocument({ raw_text: text, structure_map: [] });
  const second = projectDocument({ id: "project-document-2", raw_text: text, structure_map: [] });
  const service = serviceDocument({ id: first.id, raw_text: text, structure_map: [] });
  const input = { query: "sikkerhet kapasitet", documents: [first, second], serviceDocuments: [service], limit: 3 };
  const baseline = await retrieveDocumentSnippetsWithMetadata(input);
  assert.equal(baseline.snippets.length, 3);
  const covered = baseline.snippets.find((snippet) => snippet.sourceType === "project_document" && snippet.sourceId === first.id);
  assert.ok(covered);
  assert.match(covered.text, /kapasitet - inkludert/u);
  const result = await retrieveDocumentSnippetsWithMetadata({ ...input, limit: 2,
    promptDocumentText: new Map([[first.id, first.raw_text.replace(/ /gu, "  ")]]) });
  assert.equal(result.snippets.length, 2, "filtering runs before the final result limit");
  assert.ok(result.snippets.some((snippet) => snippet.sourceType === "project_document" && snippet.sourceId === second.id));
  assert.ok(result.snippets.some((snippet) => snippet.sourceType === "service_document" && snippet.sourceId === first.id));
  const partial = await retrieveDocumentSnippetsWithMetadata({ ...input,
    promptDocumentText: new Map([[first.id, covered.text.slice(0, 25)]]) });
  assert.ok(partial.snippets.some((snippet) => snippet.sourceType === "project_document" && snippet.sourceId === first.id && snippet.text === covered.text),
    "a chunk crossing the covered boundary retains its full evidence");
  assert.equal(first.raw_text, text, "coverage comparison does not change original source text");
});

function storedSnippetRow(document, text, reference, id) {
  return { id, source_type: "project_document", source_id: document.id, document_title: document.title,
    kind: "requirement", reference, heading_path: [], page_start: null, page_end: null,
    text_encrypted: encryptString(text), metadata: withDocumentChunkSourceFingerprint({}, projectDocumentChunkSourceFingerprint(document)) };
}

test("a bounded stored search refills uncovered evidence after most hits are prompt-covered", async () => {
  resetDocumentChunksTestRuntime();
  try {
    const coveredParagraphs = Array.from({ length: 11 }, (_, index) => `Leverandøren skal dokumentere sikkerhet for dekket område nummer ${index + 1}.`);
    const first = projectDocument({ id: "covered", title: "Dekket", raw_text: coveredParagraphs.join("\n\n"),
      structure_map: coveredParagraphs.map((text, index) => ({ reference: `A-${index}`, text })) });
    const secondText = "Leverandøren skal dokumentere sikkerhet for avdeling B.";
    const thirdText = "Leverandøren skal dokumentere sikkerhet for avdeling C og eksterne brukere.";
    const second = projectDocument({ id: "uncovered-b", title: "B", raw_text: secondText, structure_map: [{ reference: "B-1", text: secondText }] });
    const third = projectDocument({ id: "uncovered-c", title: "C", raw_text: thirdText, structure_map: [{ reference: "C-1", text: thirdText }] });
    setDocumentChunksTestRetrievalRows([
      ...coveredParagraphs.map((text, index) => storedSnippetRow(first, text, `A-${index}`, `a-${index}`)),
      storedSnippetRow(second, secondText, "B-1", "b-1"), storedSnippetRow(third, thirdText, "C-1", "c-1"),
    ]);
    // limit 2 asks the stored search for its bounded minimum of 12 hits:
    // eleven covered passages and one uncovered passage. C is outside it.
    const result = await retrieveDocumentSnippetsWithMetadata({ query: "sikkerhet", documents: [first, second, third], limit: 2,
      promptDocumentText: new Map([[first.id, first.raw_text]]) });
    assert.equal(result.telemetry.usedHybridSearch, true);
    assert.equal(result.snippets.length, 2);
    assert.deepEqual(new Set(result.snippets.map((snippet) => snippet.sourceId)), new Set([second.id, third.id]));
    assert.ok(result.snippets.some((snippet) => snippet.text.includes("eksterne brukere")));
  } finally { resetDocumentChunksTestRuntime(); }
});

test("coverage retains stored chunks when their source occurrence is ambiguous or inside another value", async () => {
  const repeated = "Leverandøren skal dokumentere et særskilt sikkerhetskrav.";
  for (const fixture of [
    { source: "Rammen er 130%.\n\nSatsen er 30%.", prefix: "Rammen er 130%.", text: "30%" },
    { source: "Rammen er 130%.", prefix: "Rammen er 130%.", text: "30%" },
    { source: `${repeated}\n\nEt annet kapittel\n\n${repeated}`, prefix: repeated, text: repeated },
  ]) {
    resetDocumentChunksTestRuntime();
    try {
      const document = projectDocument({ id: "ambiguous", raw_text: fixture.source,
        structure_map: [{ reference: "Særskilt sted", text: fixture.text }] });
      setDocumentChunksTestRetrievalRows([storedSnippetRow(document, fixture.text, "Særskilt sted", "ambiguous-row")]);
      const result = await retrieveDocumentSnippetsWithMetadata({ query: "sikkerhet ramme", documents: [document], limit: 1,
        promptDocumentText: new Map([[document.id, fixture.prefix]]) });
      assert.equal(result.snippets[0]?.text, fixture.text);
      assert.equal(result.snippets[0]?.reference, "Særskilt sted");
    } finally { resetDocumentChunksTestRuntime(); }
  }
});

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

test("a transient missing-storage error does not disable chunk storage for the process", async () => {
  resetDocumentChunksTestRuntime();
  // PostgREST reports the table as missing while it reloads its schema cache.
  assert.equal(
    shouldReuseChunksAfterCompletenessQueryError({
      message: "Could not find the table 'public.document_chunks' in the schema cache",
    }),
    true,
  );
  const document = projectDocument({ id: "00000000-0000-4000-8000-000000000077" });
  await replaceProjectDocumentChunks({
    documentId: document.id,
    projectId: document.project_id,
    role: document.role,
    supportingSubtype: document.supporting_subtype,
    title: document.title,
    fileName: document.file_name,
    fileFormat: document.file_format,
    rawText: document.raw_text,
    structureMap: document.structure_map,
    sourceRevision: document.chunk_source_revision,
  });
  assert.notEqual(getDocumentChunksTestManifest("project_document", document.id), null);
});

test("the keyword query lists content words, inflections and exact terms as alternatives", () => {
  const query = buildKeywordSearchQuery(
    "Hva sier kravgrunnlaget om responstid for tjenestene?\n- or \"K-2.1\"",
    ["K-2.1", "\"SLA\"", "krav"],
  );
  const terms = query.split(" or ");
  assert.ok(terms.every((term) => /^"[^"]+"$/u.test(term)), query);
  assert.ok(terms.includes("\"k-2.1\"") && terms.includes("\"sla\""));
  for (const form of ["responstid", "responstiden", "tjenesten", "tjeneste", "tjenester"]) {
    assert.ok(terms.includes(`"${form}"`), form);
  }
  for (const word of ["hva", "sier", "om", "for", "or", "krav", "kravgrunnlaget"]) {
    assert.ok(!terms.includes(`"${word}"`), word);
  }
  assert.equal(buildKeywordSearchQuery("Hva sier de om det?"), "");
});

test("an uninflected word that ends like a suffix keeps its own inflections", () => {
  const terms = buildKeywordSearchQuery("sikkerhet kapasitet ansvar").split(" or ");
  for (const form of ["sikkerhet", "sikkerheten", "kapasiteten", "ansvar", "ansvaret"]) {
    assert.ok(terms.includes(`"${form}"`), form);
  }
});

test("hybrid search sends the keyword query, not the whole question", async () => {
  resetDocumentChunksTestRuntime();
  try {
    const document = projectDocument();
    setDocumentChunksTestRetrievalRows([storedSnippetRow(document, document.raw_text, "Side 1", "row-1")]);
    await retrieveDocumentSnippetsWithMetadata({ query: "Hva sier kravet om kapasitet?", documents: [document], exactTerms: ["K-1"] });
    const call = getDocumentChunksTestRpcCalls().find((item) => item.name === "hybrid_match_document_chunks");
    assert.equal(call?.args.query_text, buildKeywordSearchQuery("Hva sier kravet om kapasitet?", ["K-1"]));
  } finally { resetDocumentChunksTestRuntime(); }
});

function longSection() {
  const paragraphs = Array.from({ length: 9 }, (_, index) =>
    `Avsnitt ${index + 1}. ${"Leverandøren beskriver driftsrutiner og rapportering for tjenesten. ".repeat(4).trim()}`);
  paragraphs[6] = "Avsnitt 7. Responstid for kritiske hendelser er 30 minutter hele døgnet, også i helger.";
  return paragraphs.join("\n\n");
}

test("a matched small part returns its surrounding section once", async () => {
  resetDocumentChunksTestRuntime();
  const text = longSection();
  const document = projectDocument({ raw_text: text, structure_map: [{ reference: "Kapittel 4 Drift", text }] });
  const result = await retrieveDocumentSnippetsWithMetadata({ query: "responstid kritiske hendelser rapportering", documents: [document], limit: 8, surroundingSections: true });
  const sections = result.snippets.filter((snippet) => snippet.reference.startsWith("Kapittel 4 Drift"));
  assert.equal(sections.length, 1, "parts of one section are not sent twice");
  assert.ok(text.length > 1600 && text.length <= 4800);
  assert.equal(sections[0].text, text, "the whole section fits and is returned");
});

test("without surrounding sections the matched part leads the snippet for callers that cut snippets", async () => {
  resetDocumentChunksTestRuntime();
  const text = longSection();
  const document = projectDocument({ raw_text: text, structure_map: [{ reference: "Kapittel 4 Drift", text }] });
  const [snippet] = (await retrieveDocumentSnippetsWithMetadata({ query: "responstid kritiske hendelser", documents: [document], limit: 1 })).snippets;
  assert.ok(snippet.text.length <= 1600, String(snippet.text.length));
  // Requirement and artifact prompts keep only the first 700–1 200 characters.
  assert.ok(snippet.text.indexOf("Responstid for kritiske hendelser") < 700, snippet.text.slice(0, 120));
});

test("sections with identical text under different references are each returned", async () => {
  resetDocumentChunksTestRuntime();
  const text = "Leverandøren skal ha responstid på 30 minutter for kritiske hendelser.";
  const document = projectDocument({ raw_text: `${text}\n\n${text}`, structure_map: [
    { reference: "K-1", text }, { reference: "K-2", text },
  ] });
  const result = await retrieveDocumentSnippetsWithMetadata({ query: "responstid kritiske hendelser", documents: [document], limit: 4, surroundingSections: true });
  assert.deepEqual(result.snippets.map((snippet) => snippet.reference).sort(), ["K-1", "K-2"]);
  assert.equal(result.telemetry.quality.sourceCount, 2);
});

test("a stored chunk that differs from the rebuilt part is returned as stored", async () => {
  resetDocumentChunksTestRuntime();
  try {
    const text = longSection();
    const document = projectDocument({ raw_text: text, structure_map: [{ reference: "Kapittel 4 Drift", text }] });
    const stored = { ...storedSnippetRow(document, text, "Kapittel 4 Drift", "old-size-row"), chunk_index: 0 };
    setDocumentChunksTestRetrievalRows([stored]);
    const result = await retrieveDocumentSnippetsWithMetadata({ query: "responstid", documents: [document], limit: 1, surroundingSections: true });
    assert.equal(result.snippets[0]?.text, text);
    assert.equal(result.snippets[0]?.chunkIndex, 0);
  } finally { resetDocumentChunksTestRuntime(); }
});

test("weak results search once more with the broader query", async () => {
  resetDocumentChunksTestRuntime();
  const document = projectDocument({ raw_text: "Beredskap: vakttelefon er bemannet hele døgnet.",
    structure_map: [{ reference: "Beredskap", text: "Beredskap: vakttelefon er bemannet hele døgnet." }] });
  const narrow = { query: "Omskrevet: eskaleringsmatrise", documents: [document], exactTerms: ["eskaleringsmatrise"] };
  const first = await retrieveDocumentSnippetsWithMetadata(narrow);
  assert.equal(first.snippets.length, 0);
  assert.equal(first.telemetry.usedBroadenedSearch, false);
  const broadened = await retrieveDocumentSnippetsWithMetadata({ ...narrow, broaderQuery: "Hvordan er beredskap og vakttelefon organisert?", broaderExactTerms: [] });
  assert.equal(broadened.telemetry.usedBroadenedSearch, true);
  assert.equal(broadened.snippets[0]?.reference, "Beredskap");
  // The broader pass has no exact terms; the first pass term is still missing,
  // so chat keeps its raw-text fallback.
  assert.equal(broadened.telemetry.quality.sufficient, false);
  assert.equal(broadened.telemetry.quality.exactTermCoverage, 0);
  const strong = await retrieveDocumentSnippetsWithMetadata({ query: "vakttelefon beredskap døgnet", documents: [document], broaderQuery: "noe annet" });
  if (strong.telemetry.quality.sufficient) assert.equal(strong.telemetry.usedBroadenedSearch, false);
});

test("the broader retry is decided on the returned sections, not on parts of one section", async () => {
  resetDocumentChunksTestRuntime();
  const text = longSection();
  const section = projectDocument({ raw_text: text, structure_map: [{ reference: "Kapittel 4 Drift", text }] });
  const other = projectDocument({ id: "00000000-0000-4000-8000-000000000099", title: "Bilag 3",
    raw_text: "Beredskap: vakttelefon er bemannet hele døgnet.",
    structure_map: [{ reference: "Beredskap", text: "Beredskap: vakttelefon er bemannet hele døgnet." }] });
  const input = { query: "rapportering tjenesten", documents: [section, other], limit: 8,
    broaderQuery: "Hvordan er beredskap og vakttelefon organisert?", broaderExactTerms: [] };
  const parts = await retrieveDocumentSnippetsWithMetadata(input);
  assert.ok(parts.snippets.filter((snippet) => snippet.sourceId === section.id).length > 1, "the section has several matching parts");
  const sections = await retrieveDocumentSnippetsWithMetadata({ ...input, surroundingSections: true });
  assert.equal(sections.snippets.filter((snippet) => snippet.sourceId === section.id).length, 1);
  assert.equal(sections.telemetry.usedBroadenedSearch, true, "one returned section is too narrow");
  assert.ok(sections.snippets.some((snippet) => snippet.reference === "Beredskap"));
});

test("a reranker reorders the candidate pool; invalid or missing answers keep the heuristic order", async () => {
  resetDocumentChunksTestRuntime();
  const entries = ["Sikkerhet A gjelder logging.", "Sikkerhet B gjelder kryptering.", "Sikkerhet C gjelder tilgang."];
  const document = projectDocument({ raw_text: entries.join("\n\n"),
    structure_map: entries.map((text, index) => ({ reference: `S-${index + 1}`, text })) });
  const input = { query: "sikkerhet", documents: [document], limit: 3 };
  const heuristic = (await retrieveDocumentSnippetsWithMetadata(input)).snippets.map((snippet) => snippet.reference);
  const seen = [];
  const reordered = await retrieveDocumentSnippetsWithMetadata({ ...input, rerank: async ({ candidates }) => {
    seen.push(candidates.length);
    return [2, 2, 99, -1, 1.5];
  } });
  assert.deepEqual(seen, [3]);
  assert.equal(reordered.telemetry.usedModelRerank, true);
  assert.deepEqual(reordered.snippets.map((snippet) => snippet.reference),
    [heuristic[2], heuristic[0], heuristic[1]]);
  const kept = await retrieveDocumentSnippetsWithMetadata({ ...input, rerank: async () => null });
  assert.equal(kept.telemetry.usedModelRerank, false);
  assert.deepEqual(kept.snippets.map((snippet) => snippet.reference), heuristic);
});

test("a section longer than the window returns a bounded window around the matched part", async () => {
  resetDocumentChunksTestRuntime();
  const filler = (label) => Array.from({ length: 40 }, (_, index) => `${label} ${index + 1} beskriver ordinære driftsrutiner.`).join(" ");
  const hit = "Responstid for kritiske hendelser er 30 minutter.";
  const text = `${filler("Innledning")}\n\n${filler("Bakgrunn")}\n\n${hit}\n\n${filler("Oppfølging")}\n\n${filler("Avslutning")}`;
  assert.ok(text.length > 7000);
  const document = projectDocument({ raw_text: text, structure_map: [{ reference: "Kapittel 9", text }] });
  const [snippet] = (await retrieveDocumentSnippetsWithMetadata({ query: "responstid kritiske hendelser", documents: [document], limit: 1, surroundingSections: true })).snippets;
  assert.ok(snippet.text.includes(hit));
  assert.ok(snippet.text.length <= 4800 && snippet.text.length > 1600, String(snippet.text.length));
  assert.ok(text.includes(snippet.text), "the window is an unchanged slice of the section");
  assert.match(snippet.text, /^\S/u);
  assert.match(snippet.text, /\S$/u);
  assert.equal(snippet.reference, "Kapittel 9", "a window over several parts cites the section");
  const start = text.indexOf(snippet.text);
  assert.ok(start === 0 || /\s/u.test(text[start - 1]), "the window starts at a word boundary");
  const end = start + snippet.text.length;
  assert.ok(end === text.length || /\s/u.test(text[end]), "the window ends at a word boundary");
});
