import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
const adminUrl = process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL;
const root = path.resolve(import.meta.dirname, "../../../..");
function sql(url, statement, expected = 0) {
  const result = spawnSync("psql", [url, "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], { input: statement, encoding: "utf8", timeout: 60_000 });
  if (expected === 0) assert.equal(result.status, 0, result.stderr || result.error?.message || "SQL failed");
  else assert.notEqual(result.status, 0);
  return expected === 0 ? result.stdout.trim() : result.stderr;
}
test("selected regeneration is fenced against a manual version and its successful publication remains idempotent", { skip: !adminUrl, timeout: 60_000 }, () => {
  const name = `anbud_selected_regeneration_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  sql(adminUrl, `create database "${name}";`);
  try {
    const url = target.toString();
    sql(url, `set anbud.allow_destructive_schema_rebuild=on;\n${readFileSync(path.join(root, "database/schema.sql"), "utf8")}`);
    // Exercise the additive migration as a rerunnable replacement too.
    sql(url, readFileSync(path.join(root, "database/migrations/20261101220000_selected_requirement_regeneration.sql"), "utf8"));
    const project = randomUUID(), parent = randomUUID(), job = randomUUID(), lease = randomUUID();
    sql(url, `insert into public.projects(id,client_name,title) values('${project}','Fiktiv','Fiktiv');
      insert into public.generated_artifacts(id,project_id,artifact_type,title,content_markdown,input_artifact_source_revision,input_service_library_revision,origin,generator_revision,source_snapshot_hash)
      values('${parent}','${project}','forbedret_kravsvar','Krav','Opprinnelig',0,(select service_library_revision from artifact_source_state), 'generated','test',repeat('a',64));
      insert into public.project_jobs(id,project_id,kind,status,lease_token,input_json) values('${job}','${project}','artifact_generation','running','${lease}',jsonb_build_object('artifactType','forbedret_kravsvar','regenerateRequirements',jsonb_build_object('artifactId','${parent}','artifactVersion',1,'rows','[]'::jsonb)));`);
    const payload = `jsonb_build_object('artifact_type','forbedret_kravsvar','title','Utvalgte svar','content_markdown','Nytt svar','input_snapshot','{}'::jsonb,'expected_artifact_source_revision',0,'expected_service_library_revision',(select service_library_revision from artifact_source_state),'knowledge_artifact_manifest',public.artifact_knowledge_manifest('${project}','forbedret_kravsvar'),'generator_revision','test','source_snapshot_hash',repeat('b',64),'used_solution_evaluation',false,'last_activity_at',now())`;
    const save = `select public.lease_fenced_save_generated_artifact('${job}','${lease}','${project}',${payload});`;
    const manual = sql(url, `select public.create_manual_artifact_version('${project}','${parent}',jsonb_build_object('title','Manuelt','content_markdown','Manuelt bevart svar','input_snapshot','{}'::jsonb,'expected_artifact_source_revision',0,'expected_service_library_revision',(select service_library_revision from artifact_source_state),'generator_revision','manual-edit-v2'))->>'id';`);
    assert.match(sql(url, save, 1), /REQUIREMENT_REGENERATION_PARENT_CHANGED/u);
    assert.equal(sql(url, `select count(*) from public.generated_artifacts where project_id='${project}';`), "2");
    assert.equal(sql(url, `select content_markdown from public.generated_artifacts where id='${manual}';`), "Manuelt bevart svar");
    sql(url, `update public.project_jobs set input_json=jsonb_set(jsonb_set(input_json,'{regenerateRequirements,artifactId}',to_jsonb('${manual}'::text)),'{regenerateRequirements,artifactVersion}','2'::jsonb) where id='${job}';`);
    const first = JSON.parse(sql(url, save));
    assert.equal(first.parent_artifact_id, manual); assert.equal(first.artifact_version, 3);
    assert.equal(JSON.parse(sql(url, save)).id, first.id);
    assert.equal(sql(url, `select count(*) from public.generated_artifacts where project_id='${project}';`), "3");
    // Reproduce capturing new source revisions after reading an old parent:
    // the parent ID/version still matches, but preserved answers are stale.
    const nextJob = randomUUID(), nextLease = randomUUID();
    sql(url, `update public.projects set description='Nytt løsningsgrunnlag' where id='${project}';
      insert into public.project_jobs(id,project_id,kind,status,lease_token,input_json) values('${nextJob}','${project}','artifact_generation','running','${nextLease}',jsonb_build_object('artifactType','forbedret_kravsvar','regenerateRequirements',jsonb_build_object('artifactId','${first.id}','artifactVersion',3,'rows','[]'::jsonb)));`);
    const currentPayload = payload.replace("'expected_artifact_source_revision',0", "'expected_artifact_source_revision',(select artifact_source_revision from public.projects where id='" + project + "')");
    const saveNext = `select public.lease_fenced_save_generated_artifact('${nextJob}','${nextLease}','${project}',${currentPayload});`;
    assert.match(sql(url, saveNext, 1), /REQUIREMENT_REGENERATION_PARENT_STALE/u);
    sql(url, `update public.generated_artifacts set input_artifact_source_revision=(select artifact_source_revision from public.projects where id='${project}') where id='${first.id}'; update public.artifact_source_state set service_library_revision=service_library_revision+1;`);
    assert.match(sql(url, saveNext, 1), /REQUIREMENT_REGENERATION_PARENT_STALE/u);
    assert.equal(sql(url, `select content_markdown from public.generated_artifacts where id='${first.id}';`), "Nytt svar");

    assert.equal(sql(url, "select has_function_privilege('anon','public.lease_fenced_save_generated_artifact(uuid,uuid,uuid,jsonb)','execute'),has_function_privilege('authenticated','public.lease_fenced_save_generated_artifact(uuid,uuid,uuid,jsonb)','execute'),has_function_privilege('service_role','public.lease_fenced_save_generated_artifact(uuid,uuid,uuid,jsonb)','execute');"), "f|f|t");
  } finally { sql(adminUrl, `drop database if exists "${name}" with (force);`); }
});
