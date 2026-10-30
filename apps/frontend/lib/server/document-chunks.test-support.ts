type StoredChunkManifest = {
  sourceFingerprint: string;
  sourceRevision: number;
  rows: Array<Record<string, unknown>>;
};

const manifests = new Map<string, StoredChunkManifest>();
let embeddingRequestCount = 0;
let retrievalRows: Array<Record<string, unknown>> | null = null;

function sourceKey(sourceType: string, sourceId: string) {
  return `${sourceType}:${sourceId}`;
}

export function resetDocumentChunksTestRuntime() {
  manifests.clear();
  embeddingRequestCount = 0;
  retrievalRows = null;
}

export function setDocumentChunksTestRetrievalRows(rows: Array<Record<string, unknown>>) {
  retrievalRows = structuredClone(rows);
}

export function getDocumentChunksTestEmbeddingRequestCount() {
  return embeddingRequestCount;
}

export function getDocumentChunksTestManifest(
  sourceType: string,
  sourceId: string,
) {
  return structuredClone(manifests.get(sourceKey(sourceType, sourceId)) ?? null);
}

export default class OpenAITestDouble {
  embeddings = {
    create: async (input: { input: string[] | string }) => {
      embeddingRequestCount += 1;
      const values = Array.isArray(input.input) ? input.input : [input.input];
      return {
        data: values.map((_, index) => ({
          index,
          embedding: [index + 0.1, index + 0.2],
        })),
      };
    },
  };
}

export function createServiceClient() {
  return {
    from(table: string) {
      if (table !== "document_chunks") {
        throw new Error(`Unexpected document-chunk test table: ${table}`);
      }
      return {
        select() {
          return {
            async limit() {
              return { data: [], error: null };
            },
            async in(_column: string, ids: string[]) {
              return { data: (retrievalRows ?? []).filter((row) => ids.includes(String(row.id))), error: null };
            },
          };
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (retrievalRows && (name === "hybrid_match_document_chunks" || name === "match_document_chunks")) {
        return { data: retrievalRows.slice(0, Number(args.match_count)).map((row, index) => ({
          id: row.id, similarity: 0.9, keyword_rank: index + 1, semantic_rank: index + 1, rrf_score: 1 / (60 + index),
        })), error: null };
      }
      if (name === "replace_document_chunks_atomic") {
        const sourceType = String(args.p_source_type);
        const sourceId = String(args.p_source_id);
        const rows = Array.isArray(args.p_rows)
          ? (args.p_rows as Array<Record<string, unknown>>)
          : [];
        manifests.set(sourceKey(sourceType, sourceId), {
          sourceFingerprint: String(args.p_source_fingerprint),
          sourceRevision: Number(args.p_expected_source_revision),
          rows: structuredClone(rows),
        });
        return { data: rows.length, error: null };
      }

      if (name === "document_chunks_are_complete") {
        const manifest = manifests.get(
          sourceKey(
            String(args.p_source_type),
            String(args.p_source_id),
          ),
        );
        const complete = Boolean(
          manifest &&
            manifest.sourceFingerprint === args.p_source_fingerprint &&
            manifest.sourceRevision ===
              Number(args.p_expected_source_revision) &&
            manifest.rows.length === Number(args.p_expected_chunk_count),
        );
        return {
          data: complete,
          error: null,
        };
      }

      throw new Error(`Unexpected document-chunk test RPC: ${name}`);
    },
  };
}
