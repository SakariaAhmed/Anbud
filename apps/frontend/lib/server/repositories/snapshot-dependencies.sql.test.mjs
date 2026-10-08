import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../../../..");
const admin = process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL;
const names = ["artifact_base_knowledge_candidates", "artifact_base_knowledge_manifest", "artifact_cross_type_knowledge_is_current", "get_current_project_derived_snapshot", "get_artifact_authority_summary"];
const migration = readFileSync(path.join(root, "database/migrations/20260908100000_materialize_snapshot_dependencies.sql"), "utf8");
function psql(url, sql) {
  const result = spawnSync("psql", [url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 20e6 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("snapshot optimization preserves currentness, exact dependencies, missing data and service-role-only access after additive upgrade", { skip: !admin }, () => {
  const databaseName = `snapshot_perf_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(admin);
  url.pathname = `/${databaseName}`;
  const database = url.toString();
  psql(admin, `create database ${databaseName};`);
  try {
    const original = readFileSync(path.join(import.meta.dirname, "fixtures/snapshot-dependencies-before.sql"), "utf8");
    const schema = readFileSync(path.join(root, "database/schema.sql"), "utf8");
    psql(database, `set anbud.allow_destructive_schema_rebuild=on;\n${schema}\n${original}`);
    psql(database, "grant usage on schema extensions to service_role;");
    // Upgrade an already populated database, then prove a second application is safe.
    psql(database, "insert into projects(id,client_name,title) values('00000000-0000-4000-8000-000000000808','Syntetisk','Syntetisk');");
    psql(database, migration);
    psql(database, migration);
    const originals = names.map((name) => {
      const start = original.lastIndexOf(`create or replace function public.${name}(`);
      const end = original.indexOf("\n$$;", start) + 4;
      assert.ok(start >= 0 && end > start);
      let definition = original.slice(start, end);
      for (const dependency of names) definition = definition.replaceAll(`public.${dependency}(`, `pg_temp.${dependency}_before(`);
      return definition;
    });
    const output = psql(database, `
      begin;
      set local track_functions = 'all';
      ${originals.join("\n")}
      create function pg_temp.assert_same(p uuid) returns void language plpgsql as $body$
      begin
        if public.get_current_project_derived_snapshot(p) is distinct from pg_temp.get_current_project_derived_snapshot_before(p) then raise exception 'Derived snapshot changed'; end if;
        if public.get_artifact_authority_summary(p) is distinct from pg_temp.get_artifact_authority_summary_before(p) then raise exception 'Artifact currentness changed'; end if;
        if (select jsonb_agg(to_jsonb(c)) from public.artifact_base_knowledge_candidates(p,'losningsutkast') c) is distinct from (select jsonb_agg(to_jsonb(c)) from pg_temp.artifact_base_knowledge_candidates_before(p,'losningsutkast') c) then raise exception 'Knowledge candidates changed'; end if;
      end $body$;
      create function pg_temp.assert_no_unneeded_hash(p uuid) returns void language plpgsql as $body$
      declare calls_before bigint; calls_after bigint;
      begin
        select coalesce(sum(calls), 0) into calls_before from pg_stat_xact_user_functions
          where funcid = 'public.raw_artifact_solution_evaluation_dependency(uuid)'::regprocedure;
        perform public.get_artifact_authority_summary(p);
        perform * from public.artifact_base_knowledge_candidates(p, 'losningsutkast');
        select coalesce(sum(calls), 0) into calls_after from pg_stat_xact_user_functions
          where funcid = 'public.raw_artifact_solution_evaluation_dependency(uuid)'::regprocedure;
        if calls_after <> calls_before then raise exception 'Hashed evaluation despite no eligible artifact'; end if;
      end $body$;
      do $cases$
      declare p uuid := '00000000-0000-4000-8000-000000000808'; e public.solution_evaluations%rowtype; artifact_id uuid;
      begin
        perform pg_temp.assert_same(gen_random_uuid());
        perform pg_temp.assert_same(p);
        insert into solution_evaluations(project_id,result_json,evaluation_provenance_mode) values(p,jsonb_build_object('encrypted',true,'payload',repeat('encrypted-synthetic-payload-',10000)),'document_only') returning * into e;
        perform pg_temp.assert_same(p);
        perform pg_temp.assert_no_unneeded_hash(p);
        insert into executive_summaries(project_id,result_json,provenance_verified,input_solution_evaluation_id,input_solution_evaluation_updated_at,input_solution_evaluation_hash) values(p,'{"summary":"Bevar"}',true,e.id,e.updated_at,public.raw_artifact_solution_evaluation_dependency(p)->>'content_hash');
        perform pg_temp.assert_same(p);
        set local role service_role;
        perform pg_temp.assert_same(p);
        reset role;
        insert into generated_artifacts(project_id,artifact_type,title,content_markdown,artifact_version,input_artifact_source_revision,input_service_library_revision)
          select p,t,'Syntetisk','Bevar manuell tekst',1,0,(select service_library_revision from artifact_source_state where singleton) from unnest(array['losningsutkast','forbedret_kravsvar','tilbudsstrategi']) t;
        perform pg_temp.assert_same(p);
        update generated_artifacts set used_solution_evaluation=true,input_solution_evaluation_id=e.id,input_solution_evaluation_updated_at=e.updated_at,input_solution_evaluation_hash=public.raw_artifact_solution_evaluation_dependency(p)->>'content_hash' where project_id=p;
        perform pg_temp.assert_same(p);
        update generated_artifacts set input_solution_evaluation_hash='changed' where project_id=p and artifact_type='tilbudsstrategi';
        perform pg_temp.assert_same(p);
        update executive_summaries set input_solution_evaluation_hash='stale' where project_id=p;
        perform pg_temp.assert_same(p);
        select id into artifact_id from generated_artifacts where project_id=p and artifact_type='losningsutkast';
        update solution_evaluations set evaluated_generated_artifact_id=artifact_id,evaluation_provenance_mode='generated_artifact' where project_id=p;
        perform pg_temp.assert_same(p);
        update projects set artifact_source_revision=artifact_source_revision+1 where id=p;
        perform pg_temp.assert_same(p);
        perform pg_temp.assert_no_unneeded_hash(p);
        update generated_artifacts set input_artifact_source_revision=(select artifact_source_revision from projects where id=p),input_service_library_revision=-1 where project_id=p;
        perform pg_temp.assert_same(p);
        perform pg_temp.assert_no_unneeded_hash(p);
        update solution_evaluations set evaluation_provenance_mode='legacy_unknown' where project_id=p;
        perform pg_temp.assert_same(p);
        delete from solution_evaluations where project_id=p;
        perform pg_temp.assert_same(p);
        if exists(select 1 from generated_artifacts where project_id=p and content_markdown<>'Bevar manuell tekst') then raise exception 'Manual content changed'; end if;
        if has_function_privilege('anon','public.get_current_project_derived_snapshot(uuid)','execute') or has_function_privilege('authenticated','public.artifact_base_knowledge_candidates(uuid,text)','execute') or has_function_privilege('anon','public.get_artifact_authority_summary(uuid)','execute') then raise exception 'RPC access broadened'; end if;
        if not has_function_privilege('service_role','public.get_current_project_derived_snapshot(uuid)','execute') then raise exception 'Service role access missing'; end if;
      end $cases$;
      set local role service_role;
      select public.get_current_project_derived_snapshot('00000000-0000-4000-8000-000000000808') is null;
      rollback;
    `);
    assert.equal(output, "t");
  } finally { psql(admin, `drop database ${databaseName} with (force);`); }
});
