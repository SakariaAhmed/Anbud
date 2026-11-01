// Data API double for `scripts/rag_retrieval_eval.mjs --embeddings=live`.
// Chunk rows go into a disposable PostgreSQL database and searches run the
// deployed match functions there, so retrieval exercises real hybrid search
// over real embeddings. RAG_EVAL_STORE_URL names the disposable database.
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const store = (globalThis.__ragEvalChunkStore ??= { rows: new Map(), manifests: new Map() });

function psql(sql) {
  const url = process.env.RAG_EVAL_STORE_URL;
  if (!url) throw new Error("RAG_EVAL_STORE_URL is not set");
  const result = spawnSync("psql", [url, "-X", "-v", "ON_ERROR_STOP=1", "-Atq"], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout.trim();
}

const literal = (value) => (value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`);
const vector = (values) => (Array.isArray(values) ? `${literal(`[${values.join(",")}]`)}::extensions.vector` : "null");
const uuidArray = (ids) => (Array.isArray(ids) && ids.length ? `array[${ids.map(literal).join(",")}]::uuid[]` : "null::uuid[]");
const number = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const sourceKey = (type, id) => `${type}:${id}`;

function matches(sql) {
  return { data: JSON.parse(psql(`select coalesce(json_agg(m), '[]'::json) from ${sql} m;`)), error: null };
}

exports.createServiceClient = () => ({
  from(table) {
    if (table === "document_intelligence_artifacts") {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }) };
      return query;
    }
    if (table !== "document_chunks") throw new Error(`Unexpected eval table: ${table}`);
    return {
      select: () => ({
        limit: async () => ({ data: [], error: null }),
        in: async (_column, ids) => ({ data: ids.map((id) => store.rows.get(id)).filter(Boolean), error: null }),
      }),
    };
  },
  async rpc(name, args) {
    if (name === "replace_document_chunks_atomic") {
      const key = sourceKey(args.p_source_type, args.p_source_id);
      for (const [id, row] of store.rows) {
        if (sourceKey(row.source_type, row.source_id) === key) store.rows.delete(id);
      }
      const rows = (args.p_rows ?? []).map((row) => ({ ...row, id: randomUUID() }));
      psql(`delete from public.document_chunks where source_type = ${literal(args.p_source_type)} and source_id = ${literal(args.p_source_id)};
        ${rows.length ? `insert into public.document_chunks (id, source_type, source_id, project_id, chunk_index, fts, embedding) values
        ${rows.map((row) => `(${literal(row.id)}, ${literal(row.source_type)}, ${literal(row.source_id)}, ${literal(row.project_id)}, ${row.chunk_index},
          to_tsvector('simple', left(${literal(row.search_text ?? "")}, 200000)), ${vector(row.embedding)})`).join(",\n")};` : ""}`);
      for (const row of rows) store.rows.set(row.id, row);
      store.manifests.set(key, {
        fingerprint: args.p_source_fingerprint,
        revision: Number(args.p_expected_source_revision),
        count: rows.length,
      });
      return { data: rows.length, error: null };
    }
    if (name === "document_chunks_are_complete") {
      const manifest = store.manifests.get(sourceKey(args.p_source_type, args.p_source_id));
      return {
        data: Boolean(manifest
          && manifest.fingerprint === args.p_source_fingerprint
          && manifest.revision === Number(args.p_expected_source_revision)
          && manifest.count === Number(args.p_expected_chunk_count)),
        error: null,
      };
    }
    if (name === "hybrid_match_document_chunks") {
      return matches(`public.hybrid_match_document_chunks(${vector(args.query_embedding)}, ${literal(args.query_text ?? "")},
        ${number(args.match_count, 12)}, ${number(args.match_threshold, 0.15)}, ${literal(args.project_filter)}::uuid,
        ${uuidArray(args.source_id_filter)}, ${number(args.rrf_k, 50)}, ${number(args.full_text_weight, 1)}, ${number(args.semantic_weight, 1)})`);
    }
    if (name === "match_document_chunks") {
      return matches(`public.match_document_chunks(${vector(args.query_embedding)}, ${number(args.match_count, 12)},
        ${number(args.match_threshold, 0.15)}, ${literal(args.project_filter)}::uuid, ${uuidArray(args.source_id_filter)})`);
    }
    throw new Error(`Unexpected eval RPC: ${name}`);
  },
});
