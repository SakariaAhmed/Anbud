import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = path.resolve(frontendRoot, "../..");
process.env.OPENAI_API_KEY = "keyword-search-test-key";
process.env.APP_ENCRYPTION_KEY = "keyword-search-test-encryption-key";
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "keyword-search-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { buildKeywordSearchQuery } = jiti(path.join(frontendRoot, "lib/server/document-chunks.ts"));

// The deployed definition is the one in the latest migration that replaces it.
const retrievalMigration = readFileSync(
  path.join(repositoryRoot, "database/migrations/20261101210000_norwegian_hybrid_retrieval.sql"),
  "utf8",
);
const hybridFunction = retrievalMigration.match(
  /create or replace function public\.hybrid_match_document_chunks\([\s\S]*?\n\$\$;/u,
)?.[0];
const norwegianSetup = retrievalMigration.slice(retrievalMigration.indexOf("-- Derive"), retrievalMigration.indexOf("create or replace function public.hybrid_match"));

function runPsql(databaseUrl, sql) {
  return spawnSync("psql", [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql], { encoding: "utf8" });
}

function psqlOutput(databaseUrl, sql, label) {
  const result = runPsql(databaseUrl, sql);
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const liveDatabaseUrl = process.env.DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL;

test("keyword half of hybrid search finds passages for a full chat question", { skip: !liveDatabaseUrl, timeout: 30_000 }, () => {
  assert.ok(hybridFunction, "hybrid_match_document_chunks definition is missing");
  const databaseName = `anbud_keyword_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(liveDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  psqlOutput(liveDatabaseUrl, `create database "${databaseName}"`, "create disposable database");
  try {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const chunks = [
      ["00000000-0000-4000-8000-000000000101", "K-2.1 Tjenesten skal ha beredskapen bemannet hele døgnet. Responstiden er fire timer."],
      ["00000000-0000-4000-8000-000000000102", "K-2.10 Leverandøren skal levere månedlige rapporter."],
      ["00000000-0000-4000-8000-000000000103", "Bilag 3 beskriver priser og fakturering."],
    ];
    psqlOutput(databaseUrl.toString(), `
      create schema extensions;
      create extension vector with schema extensions;
      create table public.document_chunks (
        id uuid primary key,
        source_type text not null,
        source_id uuid not null,
        project_id uuid,
        chunk_index integer not null,
        fts tsvector not null,
        embedding extensions.vector(1536)
      );
      ${norwegianSetup}
      ${hybridFunction}
      insert into public.document_chunks (id, source_type, source_id, project_id, chunk_index, fts)
      values ${chunks.map(([id, text], index) =>
        `(${literal(id)}, 'project_document', ${literal(id)}, ${literal(projectId)}, ${index}, to_tsvector('simple', ${literal(text)}))`).join(", ")};
    `, "create retrieval fixture");

    const keywordMatches = (queryText) => psqlOutput(databaseUrl.toString(), `
      select coalesce(string_agg(id::text || ':' || keyword_rank, ',' order by keyword_rank), '')
      from public.hybrid_match_document_chunks(
        array_fill(0.01, array[1536])::extensions.vector, ${literal(queryText)}, 12, 0.15, ${literal(projectId)}::uuid
      ) where keyword_rank is not null;
    `, "hybrid search");

    const question = "Hva sier kravgrunnlaget om responstid og beredskap for tjenestene i K-2.1?";
    assert.equal(keywordMatches(question), "", "the whole question requires every word and finds nothing");
    const matches = keywordMatches(buildKeywordSearchQuery(question, ["K-2.1"])).split(",");
    assert.deepEqual(matches, [`${chunks[0][0]}:1`], "inflected words and the exact ID find only the K-2.1 passage");
    assert.match(keywordMatches("månedlig"), new RegExp(chunks[1][0]), "Norwegian stemming matches inflection without hand-written variants");
    psqlOutput(databaseUrl.toString(), `update public.document_chunks set fts = to_tsvector('simple', 'hendelser') where id = '${chunks[1][0]}';`, "update lexical source");
    assert.equal(keywordMatches("månedlig"), "", "updating FTS removes obsolete Norwegian stems");
    assert.match(keywordMatches("hendelse"), new RegExp(chunks[1][0]));
    psqlOutput(databaseUrl.toString(), `update public.document_chunks set fts_norwegian = ''::tsvector; ${norwegianSetup}`, "backfill existing lexemes");
    assert.match(keywordMatches("hendelse"), new RegExp(chunks[1][0]), "explicit backfill repairs existing rows");
  } finally {
    runPsql(liveDatabaseUrl, `drop database if exists "${databaseName}" with (force)`);
  }
});
