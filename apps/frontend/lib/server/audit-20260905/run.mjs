#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(folder, '../../..');
const root = path.resolve(frontend, '../..');
const output = path.join(root, 'output/remediation-2026-09-05');
mkdirSync(output, { recursive: true });
const container = `anbud-audit-${randomUUID().slice(0, 8)}`;
let started = false;
function run(command, args, options = {}) {
  const { log, ...spawnOptions } = options;
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 120_000, ...spawnOptions });
  if (log) writeFileSync(path.join(output, log), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error || result.status !== 0) throw new Error(`${command} failed; ${log ? `see ${log}` : result.stderr ?? result.error}`);
  return result.stdout.trim();
}
try {
  run('docker', ['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=audit-local-only', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.1-pg17-bookworm']);
  started = true;
  const port = run('docker', ['port', container, '5432/tcp']).split(':').at(-1);
  const adminUrl = `postgresql://postgres:audit-local-only@127.0.0.1:${port}/postgres`;
  const databaseUrl = `postgresql://postgres:audit-local-only@127.0.0.1:${port}/audit0532`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spawnSync('psql', [adminUrl, '-X', '-Atqc', 'select 1'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  run('psql', [adminUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'create role anon; create role authenticated; create role service_role bypassrls;', '-c', 'create database audit0532;']);
  run('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1'], {
    input: `set anbud.allow_destructive_schema_rebuild=on;\n${readFileSync(path.join(root, 'database/schema.sql'), 'utf8')}`,
    log: 'db-setup.log',
  });
  console.log('Verifying additive upgrade on the previous populated schema...');
  const upgradeUrl = databaseUrl.replace('/audit0532','/upgrade0532');
  run('psql',[adminUrl,'-X','-v','ON_ERROR_STOP=1','-c','create database upgrade0532;']);
  // Fixed parent schema keeps this upgrade test useful after the release is committed.
  const oldSchema = run('git',['show','0ba4e687cb310fcd7bee152f2841125c0aea3b66:database/schema.sql'],{cwd:root});
  run('psql',[upgradeUrl,'-X','-v','ON_ERROR_STOP=1'],{input:`set anbud.allow_destructive_schema_rebuild=on;\n${oldSchema}`,log:'upgrade-baseline.log'});
  const seed = `insert into projects(id,client_name,title) values ('00000000-0000-4000-8000-000000005340','Upgrade','Upgrade'); insert into customer_analyses(project_id,result_json) values ('00000000-0000-4000-8000-000000005340','{"executive_summary":"preserve upgrade fixture"}');`;
  run('psql',[upgradeUrl,'-X','-v','ON_ERROR_STOP=1','-c',seed]);
  const migration = readFileSync(path.join(root,'database/migrations/20260905020000_workflow_consistency.sql'),'utf8');
  run('psql',[upgradeUrl,'-X','-v','ON_ERROR_STOP=1'],{input:migration+'\n'+migration,log:'upgrade-migration.log'});
  const preserved = run('psql',[upgradeUrl,'-X','-Atqc',"select result_json->>'executive_summary' from customer_analyses where project_id='00000000-0000-4000-8000-000000005340'"]);
  if (preserved !== 'preserve upgrade fixture') throw new Error('Upgrade changed existing analysis data');
  writeFileSync(path.join(output,'upgrade-result.json'),JSON.stringify({appliedTwice:true,existingAnalysisPreserved:true}));
  const env = { ...process.env, ANBUD_AUDIT_DATABASE_URL: databaseUrl };
  for (const key of ['PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL','PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL','DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL','SERVICE_DOCUMENT_SQL_TEST_DATABASE_URL']) env[key] = adminUrl;
  writeFileSync(path.join(output, 'test-environment.json'), JSON.stringify({
    commit: run('git', ['rev-parse', 'HEAD'], { cwd: root }), node: process.version,
    postgres: run('psql', [databaseUrl, '-X', '-Atqc', 'select version()']),
    vector: run('psql', [databaseUrl, '-X', '-Atqc', "select extversion from pg_extension where extname='vector'"]),
    image: 'pgvector/pgvector:0.8.1-pg17-bookworm', timestamp: new Date().toISOString(),
    fullSuite: process.argv.includes('--full'),
  }, null, 2));
  if (process.argv.includes('--full')) {
    console.log('Running existing tests against disposable PostgreSQL...');
    run('npm', ['test'], { cwd: frontend, env, log: 'existing-tests.log' });
    run(process.execPath, ['--test', 'scripts/validate_project_jobs_schema.test.mjs', 'scripts/azure_containerapp_rollout.test.mjs', 'scripts/async_worker_boundaries.test.mjs', 'scripts/azure_migration_guardrails.test.mjs'], { cwd: root, env, log: 'contracts-tests.log' });
  }
  console.log('Running audit reproductions and regression controls...');
  run(process.execPath, ['--test', path.join(folder, 'reproduction.test.mjs')], { cwd: root, env, log: 'reproduction-tests.log' });
  console.log(`Passed. Logs: ${output}`);
} finally {
  if (started) run('docker', ['rm', '-f', container]);
}
