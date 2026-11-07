#!/usr/bin/env node
// Shares the serving application's chunk builder, fingerprint and atomic write.
// Configuration is explicit; this command never loads credential files.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = fileURLToPath(new URL("../apps/frontend/", import.meta.url));
const PAGE_SIZE = 100;
const SOURCE_FIELDS = "id,title,file_name,file_format,raw_text,structure_map,chunk_source_revision";

export function parseBackfillOptions(arguments_, environment = process.env) {
  const options = { apply: false, embeddings: false, limit: null };
  for (const argument of arguments_) {
    if (argument === "--apply") options.apply = true;
    else if (argument === "--with-embeddings") options.embeddings = true;
    else if (argument.startsWith("--limit=")) {
      options.limit = Number(argument.slice("--limit=".length));
      if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error("--limit must be a positive integer per source type.");
    } else if (argument.startsWith("--target=")) options.target = argument.slice("--target=".length);
    else throw new Error("Unknown backfill argument. Use --help.");
  }
  if (!environment.DATA_API_URL || !environment.DATA_API_SERVICE_ROLE_KEY || !environment.APP_ENCRYPTION_KEY) {
    throw new Error("Set DATA_API_URL, DATA_API_SERVICE_ROLE_KEY and APP_ENCRYPTION_KEY explicitly.");
  }
  const url = new URL(environment.DATA_API_URL);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("DATA_API_URL must be a credential-free HTTPS or loopback URL.");
  }
  if (options.apply && options.target !== url.origin) throw new Error("--apply requires --target=<exact DATA_API_URL origin>.");
  if (options.embeddings && (!options.apply || !environment.OPENAI_API_KEY)) {
    throw new Error("--with-embeddings requires --apply and an explicit OPENAI_API_KEY.");
  }
  return options;
}

export function loadBackfillRuntime() {
  const require = createRequire(new URL("../apps/frontend/package.json", import.meta.url));
  const { createJiti } = require("jiti");
  const load = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
  return {
    ...load(path.join(frontend, "lib/server/crypto.ts")),
    ...load(path.join(frontend, "lib/server/document-chunks.ts")),
    ...load(path.join(frontend, "lib/server/document-chunk-structure.ts")),
    dataApi: load(path.join(frontend, "lib/server/data-api.ts")).createServiceClient(),
  };
}

export async function backfillDocumentChunks(runtime, options = {}) {
  const { dataApi } = runtime;
  const totals = { dry_run: !options.apply, scanned_documents: 0, skipped_documents: 0, indexed_documents: 0 };
  // Normal requests tolerate absent optional chunk storage; maintenance must
  // fail before claiming it repaired anything.
  const preflight = await dataApi.from("document_chunks").select("id", { head: true }).limit(1);
  if (preflight.error) throw new Error("Chunk storage is unavailable.", { cause: preflight.error });
  for (const table of ["documents", "service_documents"]) {
    let afterId = null;
    let scanned = 0;
    while (options.limit == null || scanned < options.limit) {
      const pageSize = Math.min(PAGE_SIZE, options.limit == null ? PAGE_SIZE : options.limit - scanned);
      let query = dataApi.from(table).select(`${SOURCE_FIELDS},${table === "documents" ? "project_id,role,supporting_subtype,processing_status" : "service_id"}`)
        .order("id", { ascending: true }).limit(pageSize);
      if (afterId) query = query.gt("id", afterId);
      const { data, error } = await query;
      if (error || !Array.isArray(data)) throw new Error("Could not read backfill sources.", { cause: error });
      if (!data.length) break;
      for (const row of data) {
        if (!row || typeof row.id !== "string" || (afterId && row.id <= afterId)) throw new Error("Invalid backfill source order.");
        afterId = row.id;
        scanned += 1;
        totals.scanned_documents += 1;
        const revision = Number(row.chunk_source_revision);
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid backfill source revision.");
        if (table === "documents" && !["basic_ready", "enhanced_ready"].includes(row.processing_status)) {
          totals.skipped_documents += 1;
          continue;
        }
        if (!options.apply) continue;
        const rawText = runtime.decryptString(row.raw_text ?? "");
        const structureMap = runtime.normalizeDocumentChunkStructureMap(runtime.decryptJson(row.structure_map, []));
        if (!rawText.trim() && !structureMap.length) {
          totals.skipped_documents += 1;
          continue;
        }
        const input = { documentId: row.id, title: row.title, fileName: row.file_name,
          fileFormat: row.file_format, rawText, structureMap, sourceRevision: revision };
        if (table === "documents") {
          await runtime.replaceProjectDocumentChunks({ ...input, projectId: row.project_id, role: row.role, supportingSubtype: row.supporting_subtype });
        } else {
          await runtime.replaceServiceDocumentChunks({ ...input, serviceId: row.service_id });
        }
        totals.indexed_documents += 1;
      }
      if (data.length < pageSize) break;
    }
  }
  return totals;
}

export async function runBackfillCommand(arguments_ = process.argv.slice(2)) {
  if (arguments_.includes("--help")) {
    console.log("Dry run by default. Set database/encryption variables explicitly. Use --apply --target=<DATA_API_URL origin> to atomically rebuild current ready sources. --limit=N limits each source type; --with-embeddings explicitly enables paid embedding requests. Without it only lexical chunks are generated. No credential files are loaded.");
    return;
  }
  const options = parseBackfillOptions(arguments_);
  if (!options.embeddings) process.env.OPENAI_API_KEY = "";
  const totals = await backfillDocumentChunks(loadBackfillRuntime(), options);
  console.log(JSON.stringify(totals));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBackfillCommand().catch(() => {
    console.error("Backfill failed; inspect the target and source revision before retrying. Previously committed source indexes remain atomic.");
    process.exitCode = 1;
  });
}
