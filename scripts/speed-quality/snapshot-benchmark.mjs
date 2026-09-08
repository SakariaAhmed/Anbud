#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const baseline = execFileSync("git", ["show", "3779e6f2:database/schema.sql"], { cwd: root, encoding: "utf8" });
const candidate = readFileSync(path.join(root, "database/schema.sql"), "utf8");
const database = "postgresql://postgres:speed-quality-local-only@127.0.0.1:55439/speed_quality";
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const artifactChars = Number(option("artifact-chars", "18"));
const dependencyMode = option("dependencies", "all");
const empty = process.argv.includes("--empty");
const stale = process.argv.includes("--stale");
if (!Number.isSafeInteger(artifactChars) || artifactChars < 1 || artifactChars > 2e6 || !["all", "some", "none"].includes(dependencyMode)) throw new Error("Invalid benchmark configuration.");
const functions = ["artifact_base_knowledge_candidates", "artifact_base_knowledge_manifest", "artifact_cross_type_knowledge_is_current", "get_current_project_derived_snapshot", "get_artifact_authority_summary"];
const definitions = [];
for (const name of functions) {
  for (const [version, source] of [["before", baseline], ["after", candidate]]) {
    const start = source.lastIndexOf(`create or replace function public.${name}(`);
    const end = source.indexOf("\n$$;", start) + 4;
    if (start < 0 || end < start) throw new Error(`Missing ${name}`);
    let definition = source.slice(start, end).replace(`public.${name}(`, `pg_temp.${name}_${version}(`);
    for (const dependency of functions) definition = definition.replaceAll(`public.${dependency}(`, `pg_temp.${dependency}_${version}(`);
    // --experiment measures the proposed query boundary before touching schema.
    if (version === "after" && process.argv.includes("--experiment")) definition = definition.replace("with current_dependency as (", "with current_dependency as materialized (").replace("), authority as (", "), authority as materialized (");
    definitions.push({ name, version, definition });
  }
}
const sql = `
begin;
set local track_functions = 'all';
create temp table cases(id uuid, chars integer);
create temp table timings(function_name text, chars integer, version text, sample integer, elapsed_ms float);
create temp table traces(function_name text, version text, point text, calls jsonb);
${definitions.map((d) => d.definition).join("\n")}
do $bench$
declare p uuid; payload jsonb; artifact_text text; e public.solution_evaluations%rowtype; c record; n text; v text; sample integer; started timestamptz; a jsonb; b jsonb;
begin
  foreach sample in array array[5000,80000,800000] loop
    p := gen_random_uuid();
    insert into cases values(p,sample);
    insert into public.projects(id,client_name,title) values(p,'Fiktiv ytelsesfixture','Fiktiv ytelsesfixture');
    if ${empty} then continue; end if;
    select jsonb_build_object('encrypted',true,'payload', string_agg(md5(i::text),'') ) into payload from generate_series(1,sample/32) i;
    insert into public.solution_evaluations(project_id,result_json,evaluation_provenance_mode) values(p,payload,'document_only') returning * into e;
    insert into public.executive_summaries(project_id,result_json,provenance_verified,input_solution_evaluation_id,input_solution_evaluation_updated_at,input_solution_evaluation_hash)
      values(p,'{"summary":"synthetic"}',true,e.id,e.updated_at,public.raw_artifact_solution_evaluation_dependency(p)->>'content_hash');
    select left(string_agg(md5(i::text),''),${artifactChars}) into artifact_text from generate_series(1,1+${artifactChars}/32) i;
    insert into public.generated_artifacts(project_id,artifact_type,title,content_markdown,artifact_version,input_artifact_source_revision,input_service_library_revision,used_solution_evaluation,input_solution_evaluation_id,input_solution_evaluation_updated_at,input_solution_evaluation_hash)
      select p,t,'Syntetisk artefakt',artifact_text,1,${stale ? 999 : 0},(select service_library_revision from public.artifact_source_state where singleton),${dependencyMode === "all" ? "true" : dependencyMode === "none" ? "false" : "t='losningsutkast'"},e.id,e.updated_at,public.raw_artifact_solution_evaluation_dependency(p)->>'content_hash'
      from unnest(array['losningsutkast','bilag1_rekonstruksjon','forbedret_kravsvar','tilbudsstrategi','verdiargumentasjon','anbefalt_arkitektur','gjennomforing_og_risiko']) t;
  end loop;
  for c in select * from cases loop
    foreach n in array array['get_current_project_derived_snapshot','get_artifact_authority_summary'] loop
      execute format('select pg_temp.%I($1)', n||'_before') into a using c.id;
      execute format('select pg_temp.%I($1)', n||'_after') into b using c.id;
      if a is distinct from b then raise exception 'Snapshot outputs differ'; end if;
      if a is null and not ${empty} then raise exception 'Fixture is unexpectedly stale'; end if;
      for sample in 1..30 loop
        foreach v in array case when sample%2=0 then array['before','after'] else array['after','before'] end loop
          if sample=1 and c.chars=800000 then insert into traces select n,v,'before',jsonb_object_agg(funcname,calls) from pg_stat_xact_user_functions; end if;
          started := clock_timestamp();
          execute format('select pg_temp.%I($1)',n||'_'||v) into a using c.id;
          insert into timings values(n,c.chars,v,sample,extract(epoch from clock_timestamp()-started)*1000);
          if sample=1 and c.chars=800000 then insert into traces select n,v,'after',jsonb_object_agg(funcname,calls) from pg_stat_xact_user_functions; end if;
        end loop;
      end loop;
    end loop;
  end loop;
end $bench$;
select jsonb_build_object('traces',(select jsonb_agg(to_jsonb(traces)) from traces),'rows',(select jsonb_agg(to_jsonb(t)) from (select function_name,chars,version,count(*) as samples,percentile_cont(0.5) within group(order by elapsed_ms) as p50_ms,percentile_cont(0.95) within group(order by elapsed_ms) as p95_ms,jsonb_agg(elapsed_ms order by sample) as raw_ms from timings group by function_name,chars,version order by function_name,chars,version) t));
rollback;
`;
const output = execFileSync("psql", [database, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 10e6 });
const { rows, traces } = JSON.parse(output.trim());
const result = { at: new Date().toISOString(), node: process.version, database: "disposable local PostgreSQL 17/pgvector", baseline: "3779e6f2", fixture: { artifactChars, dependencyMode, empty, stale }, experiment: process.argv.includes("--experiment"), definitionHashes: definitions.map(({ name, version, definition }) => ({ name, version, sha256: createHash("sha256").update(definition).digest("hex") })), outputIdentical: true, measurement: "SQL execution in one warm connection; alternating paired calls; synthetic uncompressible evaluation/artifact payloads; transaction rolled back", rows, traces };
const file = process.argv.find((arg) => arg.endsWith(".json"));
if (file) writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(rows.map(({ raw_ms, ...row }) => row), null, 2));
