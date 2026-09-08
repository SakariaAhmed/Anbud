import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validatedBudgetLimit } from "./budget.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const mode = option("mode", "prepare"), label = option("label", "v1");
assert.ok(["prepare", "baseline", "candidate", "cleanup"].includes(mode));
assert.match(label, /^[a-z0-9]+$/);
const out = path.join(dir, `verification/perfect-workflow-${label}`);
const fixtureFile = path.join(out, "fixture.json");
const frontend = path.join(root, "apps/frontend");
const baselineFrontend = "/tmp/anbud-speed-quality-baseline-3779e6f2/apps/frontend";
const pg = "anbud-speed-quality-db";
const names = Object.fromEntries(["baseline", "candidate"].map((side) => [side, {
  database: `speed_quality_perfect_${label}_${side}`,
  container: `anbud-speed-quality-perfect-${label}-${side}`,
  port: side === "baseline" ? 55447 : 55448,
}]));
const env = JSON.parse(readFileSync(path.join(dir, "local-environment.json")));
assert.equal(env.DATA_API_URL, "http://127.0.0.1:55440");
assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:4319/v1");
assert.equal(env.OPENAI_API_KEY, "local-evaluation-proxy-only");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashValue = (value) => sha(JSON.stringify(value));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const url = new URL(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0].url);
  const permitted = ["http://127.0.0.1:55440", ...Object.values(names).map((n) => `http://127.0.0.1:${n.port}`)];
  if (["baseline", "candidate"].includes(mode)) permitted.push("http://127.0.0.1:4319");
  assert.ok(permitted.includes(url.origin), "Only disposable local databases and the budget proxy are allowed.");
  return originalFetch(...args);
};
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
function loader(directory) {
  return createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@": directory, "server-only": "/dev/null",
    "next/cache": path.join(frontend, "lib/server/repositories/data-store.persistence.test-support.ts"),
  } });
}
function docker(...args) {
  try { return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20e6 }); }
  catch { throw new Error("Disposable Docker operation failed; arguments and output are withheld because they can contain local credentials."); }
}
async function db(base, route, method = "GET", body) {
  const response = await fetch(`${base}/${route}`, { method, headers: { authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}`, "content-type": "application/json", prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `Disposable database operation failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}
const base = (side) => `http://127.0.0.1:${names[side].port}`;
async function snapshot(origin, projectId) {
  const result = {};
  for (const table of ["projects", "documents", "customer_analyses", "solution_evaluations", "generated_artifacts", "project_jobs", "document_chunks"]) {
    const rows = await db(origin, `${table}?${table === "projects" ? "id" : "project_id"}=eq.${projectId}&order=id.asc`);
    result[table] = { count: rows.length, sha256: hashValue(rows) };
  }
  return result;
}
async function startRest(side) {
  const source = JSON.parse(docker("inspect", "anbud-speed-quality-rest"))[0];
  const uri = new URL(source.Config.Env.find((s) => s.startsWith("PGRST_DB_URI=")).slice(13));
  assert.equal(uri.pathname, "/speed_quality"); uri.pathname = `/${names[side].database}`;
  const args = ["run", "--detach", "--name", names[side].container, "--publish", `127.0.0.1:${names[side].port}:3000`];
  for (const value of source.Config.Env.filter((s) => s.startsWith("PGRST_"))) args.push("--env", value.startsWith("PGRST_DB_URI=") ? `PGRST_DB_URI=${uri}` : value);
  docker(...args, source.Config.Image);
  for (let i = 0; i < 40; i++) {
    try { await db(base(side), "projects?select=id&limit=1"); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  throw new Error("Disposable REST did not become ready.");
}

if (mode === "prepare") {
  assert.equal(existsSync(out), false); mkdirSync(out);
  const frozenFile = path.join(dir, "generation-inputs.json");
  const frozen = JSON.parse(readFileSync(frozenFile)).cases.find((c) => c.caseId === "fjord-drift-development");
  const ledgerBefore = sha(readFileSync(path.join(dir, "api-budget.json")));
  const original = await snapshot(env.DATA_API_URL, frozen.projectId);
  const preparation = { at: new Date().toISOString(), completed: false, createdDatabases: [], startedContainers: [], caseId: frozen.caseId, projectId: frozen.projectId, originalSnapshot: original };
  const save = () => writeFileSync(path.join(out, "preparation.json"), JSON.stringify(preparation, null, 2));
  save();
  try {
    const dump = `/tmp/anbud-perfect-${label}.dump`;
    docker("exec", pg, "pg_dump", "-U", "postgres", "-d", "speed_quality", "-Fc", "-f", dump);
    docker("exec", pg, "createdb", "-U", "postgres", names.baseline.database); preparation.createdDatabases.push(names.baseline.database); save();
    docker("exec", pg, "pg_restore", "-U", "postgres", "-d", names.baseline.database, "--exit-on-error", dump);
    await startRest("baseline"); preparation.startedContainers.push(names.baseline.container); save();
    Object.assign(process.env, env, { DATA_API_URL: base("baseline") });
    const prepareLoader = loader(frontend);
    const { encryptJson } = prepareLoader(path.join(frontend, "lib/server/crypto.ts"));
    const { getProjectDetail } = prepareLoader(path.join(frontend, "lib/server/repositories/data-store.ts"));
    const analyses = await db(base("baseline"), `customer_analyses?project_id=eq.${frozen.projectId}`);
    assert.equal(analyses.length, 1);
    assert.deepEqual((await getProjectDetail(frozen.projectId)).customer_analysis, frozen.input.customerAnalysis);
    const evaluationFile = "matrix-baseline16k-fjord-drift-development-solution_evaluation.json";
    const evaluation = JSON.parse(readFileSync(path.join(dir, evaluationFile))).result;
    assert.ok(evaluation.architecture_comparison.system_solution_score < 100);
    const documents = await db(base("baseline"), `documents?project_id=eq.${frozen.projectId}&order=id.asc`);
    const customer = documents.find((d) => d.role === "primary_customer_document");
    const solution = documents.find((d) => d.role === "primary_solution_document");
    assert.ok(customer && solution);
    assert.deepEqual(await db(base("baseline"), `project_jobs?project_id=eq.${frozen.projectId}&status=in.(queued,running)&select=id`), []);
    await db(base("baseline"), `solution_evaluations?project_id=eq.${frozen.projectId}`, "DELETE");
    await db(base("baseline"), "solution_evaluations", "POST", { project_id: frozen.projectId, source_document_ids: documents.map((d) => d.id), customer_document_id: customer.id, solution_document_id: solution.id, analysis_id: analyses[0].id, evaluated_generated_artifact_id: null, evaluation_provenance_mode: "document_only", result_json: encryptJson(evaluation) });
    docker("exec", pg, "pg_dump", "-U", "postgres", "-d", names.baseline.database, "-Fc", "-f", dump);
    docker("exec", pg, "createdb", "-U", "postgres", names.candidate.database); preparation.createdDatabases.push(names.candidate.database); save();
    docker("exec", pg, "pg_restore", "-U", "postgres", "-d", names.candidate.database, "--exit-on-error", dump);
    await startRest("candidate"); preparation.startedContainers.push(names.candidate.container); save();
    docker("exec", pg, "rm", dump);
    const before = await snapshot(base("baseline"), frozen.projectId), after = await snapshot(base("candidate"), frozen.projectId);
    assert.deepEqual(before, after);
    const project = (await db(base("baseline"), `projects?id=eq.${frozen.projectId}`))[0];
    assert.equal(project.source_revision, frozen.sourceRevision);
    assert.deepEqual(await snapshot(env.DATA_API_URL, frozen.projectId), original);
    assert.equal(sha(readFileSync(path.join(dir, "api-budget.json"))), ledgerBefore);
    writeFileSync(fixtureFile, JSON.stringify({ at: new Date().toISOString(), caseId: frozen.caseId, projectId: frozen.projectId, sourceRevision: frozen.sourceRevision, frozenFileSha256: sha(readFileSync(frozenFile)), evaluationFile, evaluationFileSha256: sha(readFileSync(path.join(dir, evaluationFile))), snapshot: before, originalSnapshot: original, names, startingScore: evaluation.architecture_comparison.system_solution_score, scope: "Two disposable full copies of the fictional local database. Only the baseline copy is seeded with the already paid baseline16k evaluation before cloning to candidate. Identical project, analysis, document, chunk, artifact and job snapshots; original fixtures untouched. No model call in preparation." }, null, 2), { flag: "wx" });
    preparation.completed = true; preparation.originalUnchanged = true; preparation.budgetUnchanged = true; save();
  } catch (error) { preparation.failure = error.message; save(); throw error; }
  console.log(JSON.stringify({ fixtureFile, completed: true, paidCalls: 0 }));
} else if (mode === "cleanup") {
  const preparation = JSON.parse(readFileSync(path.join(out, "preparation.json")));
  for (const container of preparation.startedContainers) docker("rm", "--force", container);
  for (const database of preparation.createdDatabases) docker("exec", pg, "dropdb", "-U", "postgres", "--force", database);
  assert.deepEqual(await snapshot(env.DATA_API_URL, preparation.projectId), preparation.originalSnapshot);
  writeFileSync(path.join(out, "cleanup.json"), JSON.stringify({ at: new Date().toISOString(), ownContainersRemoved: true, ownDatabasesRemoved: true, originalProjectUnchanged: true }), { flag: "wx" });
  console.log("Disposable perfect-workflow databases removed; original project unchanged.");
} else {
  const fixture = JSON.parse(readFileSync(fixtureFile));
  const reportFile = path.join(out, `${mode}.json`);
  assert.equal(existsSync(reportFile), false);
  assert.deepEqual(await snapshot(base(mode), fixture.projectId), fixture.snapshot);
  assert.equal(sha(readFileSync(path.join(dir, "generation-inputs.json"))), fixture.frozenFileSha256);
  Object.assign(process.env, env, { DATA_API_URL: base(mode) });
  const codeDirectory = mode === "baseline" ? baselineFrontend : frontend;
  const load = loader(codeDirectory);
  const { queuePerfectSystemSolutionJob, runQueuedProjectJob } = load(path.join(codeDirectory, "lib/server/project-jobs.ts"));
  const { decryptJson } = load(path.join(codeDirectory, "lib/server/crypto.ts"));
  const initialArtifacts = await db(base(mode), `generated_artifacts?project_id=eq.${fixture.projectId}&select=id`);
  const budgetBefore = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
  validatedBudgetLimit(budgetBefore); assert.ok(budgetBefore.remainingUsd >= 1);
  assert.equal(budgetBefore.proxyPhase, "refill-v1-perfect");
  assert.equal(budgetBefore.proxyPhaseBudgetUsd, 4);
  assert.equal(budgetBefore.proxyServiceTier, "default");
  const jobId = randomUUID();
  const codeFiles = execFileSync("rg", ["--files", "lib/server"], { cwd: codeDirectory, encoding: "utf8" }).trim().split("\n").filter((f) => f.endsWith(".ts")).sort();
  const report = { at: new Date().toISOString(), completed: false, code: mode, applicationCommit: mode === "baseline" ? "3779e6f2" : execFileSync("git", ["log", "-1", "--format=%H", "--", "apps/frontend"], { cwd: root, encoding: "utf8" }).trim(), codeSha256: hashValue(codeFiles.map((f) => [f, sha(readFileSync(path.join(codeDirectory, f)))])), fixtureSha256: sha(readFileSync(fixtureFile)), jobId, projectId: fixture.projectId, budgetBefore, scope: "Actual queue, claim, heartbeat, workflow, live models and artifact/evaluation persistence on an isolated identical starting DB. Next cache bypassed and invalidation stubbed; excludes HTTP route authentication, browser, Azure and statistical latency claims. No resumeArtifactId or model/output-limit override." };
  const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2)); save();
  const started = performance.now();
  try {
    const queued = await queuePerfectSystemSolutionJob({ projectId: fixture.projectId }, { autoRun: false, jobId });
    assert.equal(queued.id, jobId); assert.equal(queued.status, "queued");
    report.submitMs = performance.now() - started;
    await runQueuedProjectJob(jobId);
    report.totalMs = performance.now() - started;
    const job = (await db(base(mode), `project_jobs?id=eq.${jobId}`))[0];
    report.finalStatus = job.status; report.result = decryptJson(job.result_json, null); report.errorCode = job.error;
    assert.equal(job.status, "completed"); assert.ok(report.result);
    assert.notEqual(report.result.completion_status, "evaluation_pending");
    const artifacts = (await db(base(mode), `generated_artifacts?project_id=eq.${fixture.projectId}`)).filter((a) => !initialArtifacts.some((old) => old.id === a.id));
    assert.equal(artifacts.length, 1); const artifact = artifacts[0];
    assert.equal(artifact.artifact_type, "losningsutkast"); assert.equal(artifact.generation_job_id, jobId);
    assert.ok(artifact.content_markdown.length > 100);
    const evaluation = (await db(base(mode), `solution_evaluations?project_id=eq.${fixture.projectId}`))[0];
    assert.equal(evaluation.evaluated_generated_artifact_id, artifact.id); assert.equal(evaluation.evaluation_provenance_mode, "generated_artifact");
    const project = (await db(base(mode), `projects?id=eq.${fixture.projectId}`))[0];
    assert.equal(project.source_revision, fixture.sourceRevision);
    report.persistedArtifact = artifact; report.persistedEvaluation = { ...evaluation, result_json: decryptJson(evaluation.result_json, null) };
    assert.equal(report.result.artifact.id, artifact.id); assert.ok(report.result.evaluation);
    report.sourceRevisionUnchanged = true; report.artifactEvaluationLinkVerified = true; report.completed = true;
  } catch (error) { report.failure = error.message; process.exitCode = 1; }
  finally {
    report.totalMs ??= performance.now() - started;
    report.budgetAfter = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
    const previousIds = new Set(budgetBefore.requests.map((r) => r.id));
    report.requests = report.budgetAfter.requests.filter((r) => !previousIds.has(r.id));
    report.allProvidersComplete = report.requests.length > 0 && report.requests.every((r) => r.status === 200 && (r.model.startsWith("text-embedding-") || r.completion?.status === "completed" || r.completion?.finishReasons?.length > 0 && r.completion.finishReasons.every((v) => v === "stop")));
    if (!report.allProvidersComplete) { report.completed = false; process.exitCode = 1; }
    assert.deepEqual(await snapshot(env.DATA_API_URL, fixture.projectId), fixture.originalSnapshot);
    report.originalProjectUnchanged = true; save();
  }
  console.log(JSON.stringify({ reportFile, completed: report.completed, totalMs: report.totalMs, requests: report.requests.length, failure: report.failure }));
}
