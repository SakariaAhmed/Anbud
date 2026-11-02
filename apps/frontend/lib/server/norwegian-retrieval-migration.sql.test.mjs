import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
const adminUrl = process.env.DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL;
const root = path.resolve(import.meta.dirname, "../../../..");
function sql(url, text, file) {
  const result = spawnSync("psql", [url, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", ...(file ? ["-f", file] : [])], { input: text, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || "SQL failed");
  return result.stdout.trim();
}
test("Norwegian migration backfills a populated vector index, preserves sources/grants and resumes idempotently", { skip: !adminUrl, timeout: 180_000 }, () => {
  const name = `anbud_norwegian_upgrade_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  sql(adminUrl, `create database "${name}";`);
  try {
    const url = target.toString();
    sql(url, `create schema extensions; create extension vector with schema extensions;
      create table public.document_chunks (id uuid primary key, source_type text, source_id uuid, project_id uuid, chunk_index int, fts tsvector not null, embedding extensions.vector(1536));
      alter table public.document_chunks enable row level security;
      revoke all on public.document_chunks from anon, authenticated;
      create index old_vector_index on public.document_chunks using hnsw (embedding extensions.vector_cosine_ops);
      create index old_simple_index on public.document_chunks using gin(fts);
      insert into public.document_chunks
      select md5(i::text)::uuid, 'project_document', md5('source')::uuid, md5('project')::uuid, i, to_tsvector('simple', 'Sikkerhetskopier skal gjenopprettes. beta alpha'), array_fill(0.01, array[1536])::extensions.vector from generate_series(1, 1001) i;`);
    const before = sql(url, "select md5(string_agg(id::text || fts::text || embedding::text, '' order by id)) from public.document_chunks;");
    const migration = path.join(root, "database/migrations/20261101210000_norwegian_hybrid_retrieval.sql");
    sql(url, undefined, migration);
    assert.equal(sql(url, "select count(*) from public.document_chunks where fts_norwegian = public.norwegian_document_chunk_fts(fts) and fts_norwegian @@ plainto_tsquery('norwegian','sikkerhetskopi');"), "1001");
    assert.equal(sql(url, "select count(*) from public.document_chunks where fts_norwegian @@ websearch_to_tsquery('norwegian','\"alpha beta\"');"), "0");
    assert.equal(sql(url, "select md5(string_agg(id::text || fts::text || embedding::text, '' order by id)) from public.document_chunks;"), before);
    assert.equal(sql(url, "select has_function_privilege('anon','public.hybrid_match_document_chunks(extensions.vector,text,int,float,uuid,uuid[],int,float,float)','execute'), has_function_privilege('authenticated','public.norwegian_document_chunk_fts(tsvector)','execute'), has_function_privilege('service_role','public.norwegian_document_chunk_fts(tsvector)','execute');"), "f|f|t");
    assert.equal(sql(url, "select indisvalid from pg_index where indexrelid='public.document_chunks_norwegian_fts_idx'::regclass;"), "t");
    sql(url, undefined, migration);
    assert.equal(sql(url, "select count(*) from public.document_chunks;"), "1001");
  } finally { sql(adminUrl, `drop database if exists "${name}" with (force);`); }
});
