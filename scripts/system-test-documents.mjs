#!/usr/bin/env node
// Real multipart PDF/OCR ingestion and enhancement recovery through the owned
// local stack: HTTP route, queue, parser, SQL, PostgREST and Azurite. No model
// is called. Its only injection is the Docling command failing, which is
// separate from the automatic-analysis state fixtures. Timings are one local
// synthetic sample and say nothing about production latency.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { assertOwnedSystemTestStack, isolatedApplicationEnvironment, systemTestStatusPath } from "./system-test-runtime.mjs";

const scenarios = (process.argv.find(argument => argument.startsWith("--scenario="))?.slice("--scenario=".length) ?? "all").split(",");
const wants = name => scenarios.includes("all") || scenarios.includes(name);
const leaveFailedForBrowser = process.argv.includes("--leave-failed-document");
const root = path.resolve(import.meta.dirname, "..");
const frontend = path.join(root, "apps/frontend");
const status = JSON.parse(readFileSync(systemTestStatusPath(), "utf8"));
const runtime = JSON.parse(readFileSync(path.join(status.directory, "environment.json"), "utf8"));
assertOwnedSystemTestStack(status, runtime);
assert.equal(runtime.env.OPENAI_API_KEY, "", "This harness never calls a model; use a stack without a model endpoint.");
assert.ok(status.docling?.image, "Start the stack with --docling-image=<local runner-docling image>.");
const marker = runtime.env.ANBUD_SYSTEM_TEST_DOCLING_FAILURE_MARKER;
assert.ok(marker?.startsWith(status.directory), "The failure marker must belong to this stack.");
rmSync(marker, { force: true });

const base = status.baseUrl;
const checks = [], measurements = {};
const check = name => { checks.push(name); console.error(`ok - ${name}`); };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = relative => readFileSync(path.join(root, relative));

async function dataApi(route, options = {}) {
  const response = await fetch(`${runtime.env.DATA_API_URL}${route}`, { ...options, headers: { authorization: `Bearer ${runtime.env.DATA_API_SERVICE_ROLE_KEY}`, "content-type": "application/json", ...options.headers } });
  assert.ok(response.ok, `Owned data API ${route}: ${response.status}`);
  return response;
}
await dataApi("/app_rate_limits", { method: "DELETE" });

let cookie;
async function request(route, { as = cookie, expected = 200, ...options } = {}) {
  const response = await fetch(`${base}${route}`, { ...options, redirect: "manual", signal: AbortSignal.timeout(280_000), headers: { origin: base, ...(as ? { cookie: as } : {}), ...options.headers } });
  assert.equal(response.status, expected, `${options.method ?? "GET"} ${route}: expected ${expected}, got ${response.status}`);
  return response;
}
const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function signIn() {
  const response = await request("/api/auth/login", { ...json("POST", { password: runtime.adminPassword }), as: null });
  const value = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(value?.startsWith("bidsite_session="));
  return value;
}
cookie = await signIn();

function runWorker() {
  // Only the worker process claims enhancement here; it may outlast one fetch.
  void fetch(`${base}/api/project-jobs/worker`, { ...json("POST", { limit: 10 }), headers: { "content-type": "application/json", origin: base, "x-worker-token": runtime.env.PROJECT_JOB_WORKER_TOKEN } }).then(response => response.text()).catch(() => undefined);
}
async function finishJob(projectId, jobId, timeoutMs = 600_000) {
  const startedAt = performance.now(), progress = [];
  let lastWorker = 0;
  while (performance.now() - startedAt < timeoutMs) {
    if (performance.now() - lastWorker > 10_000) { runWorker(); lastWorker = performance.now(); }
    const { job } = await (await request(`/api/projects/${projectId}/jobs/${jobId}`)).json();
    if (progress.at(-1)?.message !== job.message) progress.push({ at_ms: Math.round(performance.now() - startedAt), status: job.status, message: job.message });
    if (job.status === "completed" || job.status === "failed") return { job, progress, duration_ms: Math.round(performance.now() - startedAt) };
    await pause(400);
  }
  throw new Error(`Job ${jobId} did not reach a terminal state.`);
}
async function upload(projectId, relative, { title, role = "supporting_document", subtype = "kravdokument" }) {
  const bytes = fixture(relative);
  const form = new FormData();
  form.set("file", new File([bytes], path.basename(relative), { type: "application/pdf" }));
  form.set("title", title); form.set("role", role); form.set("role_source", "explicit");
  if (subtype) form.set("supporting_subtype", subtype);
  const startedAt = performance.now();
  const accepted = await (await request(`/api/projects/${projectId}/documents`, { method: "POST", body: form, expected: 201 })).json();
  const finished = await finishJob(projectId, accepted.job.id);
  assert.equal(finished.job.status, "completed", `${title}: ${finished.job.error ?? "no safe detail"}`);
  return { accepted, bytes, ingestion: finished, upload_to_ready_ms: Math.round(performance.now() - startedAt) };
}
const newProject = async name => (await (await request("/api/projects", { ...json("POST", { name, customer_name: "Fiktiv kommune" }), expected: 201 })).json());
const projectDocument = async (projectId, documentId, as = cookie) => {
  const project = await (await request(`/api/projects/${projectId}`, { as })).json();
  return (project.project?.documents ?? project.documents).find(item => item.id === documentId);
};
const registerOf = async (projectId, documentId) => (await (await request(`/api/projects/${projectId}/requirement-register`)).json()).documents.find(item => item.id === documentId);
const chunkCount = async (projectId, documentId) => (await (await dataApi(`/document_chunks?project_id=eq.${projectId}&source_id=eq.${documentId}&select=id`)).json()).length;
const download = async (projectId, documentId, as = cookie) => Buffer.from(await (await request(`/api/projects/${projectId}/documents/${documentId}`, { as })).arrayBuffer());
const evidence = async (projectId, documentId, quote, sourceRevision) => {
  const response = await fetch(`${base}/api/projects/${projectId}/source-evidence`, { ...json("POST", { documentId, quote, sourceRevision }), headers: { "content-type": "application/json", origin: base, cookie } });
  return { status: response.status, source: (await response.json()).source };
};
const assertReadyAndIndexed = async (projectId, documentId, label) => {
  const document = await projectDocument(projectId, documentId);
  assert.ok(["basic_ready", "enhanced_ready"].includes(document.processing_status), `${label}: ${document.processing_status}`);
  assert.ok(document.indexed_at, `${label}: readiness needs a persisted index.`);
  const chunks = await chunkCount(projectId, documentId);
  assert.ok(chunks > 0, `${label}: readiness needs persisted chunks.`);
  return { document, chunks };
};
async function restrictedViewer(projectId) {
  const invitation = await (await request("/api/admin/users", { ...json("POST", { email: `system-test-${randomUUID()}@example.invalid`, displayName: "Fiktiv innsynsbruker", guestDescription: "Lokal sikkerhetstest", projectId, role: "restricted_viewer" }), expected: 201 })).json();
  const response = await request("/api/auth/guest", { ...json("POST", { code: invitation.guestCode }), as: null });
  return response.headers.get("set-cookie").split(";")[0];
}

async function textPdfScenario() {
  const project = await newProject("Fiktiv PDF-systemtest");
  const relative = "test-data/tenders/halandsvik-2026/documents/02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf";
  const expected = JSON.parse(fixture("test-data/tenders/halandsvik-2026/fasit.json"));
  const uploaded = await upload(project.id, relative, { title: "Bilag 1 Kravspesifikasjon" });
  const documentId = uploaded.accepted.document.id;
  const basic = await assertReadyAndIndexed(project.id, documentId, "Tekst-PDF");
  assert.equal(basic.document.file_format, "pdf");
  check("actual multipart text PDF reaches persisted readiness with chunks");
  assert.equal(sha256(await download(project.id, documentId)), sha256(uploaded.bytes));
  check("text PDF download returns the original bytes");

  const verifyRegister = async stage => {
    const register = await registerOf(project.id, documentId);
    assert.ok(register?.register_available, `${stage}: register must be persisted.`);
    assert.deepEqual(register.rows.map(row => row.id).sort(), expected.requirements.map(row => row.id).sort(), `${stage}: IDs must match the frozen answer key.`);
    assert.ok(register.rows.every(row => row.id_origin === "source" && row.pages.length > 0), `${stage}: every row needs an observed ID and a page.`);
    const normalize = value => value.replace(/\s+/gu, " ").trim();
    const wrong = expected.requirements.filter(row => normalize(register.rows.find(item => item.id === row.id).text) !== normalize(row.verbatim_text)).map(row => row.id);
    const originsOf = origin => register.rows.filter(row => row.text_origin === origin).map(row => row.id);
    return { rows: register.rows.length, wording_differences: wrong, observed_rows: originsOf("observed").length, reconstructed_rows: originsOf("reconstructed"), pages: Object.fromEntries(register.rows.map(row => [row.id, row.pages])) };
  };
  const basicRegister = await verifyRegister("Grunnversjon");
  check(`register has all ${basicRegister.rows} frozen Halandsvik IDs with observed origin and pages (basic version)`);
  assert.deepEqual(basicRegister.wording_differences, [], "A row read directly from the text layer shows the frozen original wording.");
  check("every basic register row shows the original wording of the frozen answer key");
  const sample = expected.requirements[0];
  const verified = await evidence(project.id, documentId, sample.verbatim_text, basic.document.chunk_source_revision);
  assert.equal(verified.status, 200, "A verbatim requirement must verify against the stored source.");
  assert.equal(verified.source.classification, "documented");
  assert.ok(basicRegister.pages[sample.id].includes(verified.source.page_start), "Source page must agree with the register.");
  check("verbatim requirement verifies against the stored source at its current revision");

  const enhancementId = uploaded.ingestion.job.result?.docling_enhancement_job_id;
  const result = { document_id: documentId, upload_to_ready_ms: uploaded.upload_to_ready_ms, ingestion_progress: uploaded.ingestion.progress, parser: basic.document.parser_used, chunks: basic.chunks, wording_differences_basic: basicRegister.wording_differences, observed_rows_basic: basicRegister.observed_rows, reconstructed_rows_basic: basicRegister.reconstructed_rows, enhancement: "not requested" };
  if (typeof enhancementId === "string") {
    const enhancement = await finishJob(project.id, enhancementId);
    assert.equal(enhancement.job.status, "completed", enhancement.job.error ?? "");
    const enhanced = await assertReadyAndIndexed(project.id, documentId, "Forbedret tekst-PDF");
    const enhancedRegister = await verifyRegister("Forbedret versjon");
    check(`real Docling enhancement of the PDF keeps all ${enhancedRegister.rows} IDs and their pages`);
    Object.assign(result, { enhancement: { skipped: enhancement.job.result?.skipped, parser: enhanced.document.parser_used, status: enhanced.document.processing_status, revision_before: basic.document.chunk_source_revision, revision_after: enhanced.document.chunk_source_revision, chunks: enhanced.chunks, duration_ms: enhancement.duration_ms, progress: enhancement.progress, wording_differences: enhancedRegister.wording_differences, observed_rows: enhancedRegister.observed_rows, reconstructed_rows: enhancedRegister.reconstructed_rows } });
  }
  return result;
}

async function ocrScenario() {
  const project = await newProject("Fiktiv OCR-systemtest");
  const results = [];
  for (const expected of JSON.parse(fixture("test-data/ocr/expected.json"))) {
    const uploaded = await upload(project.id, `test-data/ocr/${expected.file}`, { title: `Bilag 1 Skannet ${expected.file}` });
    assert.equal(sha256(uploaded.bytes), expected.sha256, "The frozen OCR fixture changed.");
    const documentId = uploaded.accepted.document.id;
    const { document, chunks } = await assertReadyAndIndexed(project.id, documentId, expected.file);
    assert.equal(document.parser_used, "docling", "An image-only PDF can only become readable through OCR.");
    assert.equal(document.page_count, expected.pages.length);
    assert.equal(sha256(await download(project.id, documentId)), expected.sha256);
    const lines = [];
    for (const [index, page] of expected.pages.entries()) for (const line of page) {
      const verified = await evidence(project.id, documentId, line, document.chunk_source_revision);
      lines.push({ expected_page: index + 1, line, status: verified.status, classification: verified.source?.classification ?? null, page_start: verified.source?.page_start ?? null });
    }
    assert.deepEqual(lines.filter(line => line.status !== 200 || line.classification !== "documented"), [], "Every frozen OCR line must verify, including Norwegian letters.");
    // A quote spanning several parser items states no page. It must never state a wrong one.
    assert.deepEqual(lines.filter(line => line.page_start !== null && line.page_start !== line.expected_page), [], "A stated page must be the true page.");
    const withoutPage = lines.filter(line => line.page_start === null).map(line => line.line);
    assert.ok(withoutPage.length <= 1, "Page provenance must hold for the frozen lines that stay in one parser item.");
    const register = await registerOf(project.id, documentId);
    assert.equal(register?.register_available, true);
    // Required rows come from the frozen answer lines; a missing row fails here.
    const requiredRows = expected.pages.flatMap((page, index) => page.flatMap(line => {
      const labelled = /^Krav (\S+): (.+)$/u.exec(line);
      return labelled ? [{ id: labelled[1], text: labelled[2], pages: [index + 1], id_origin: "source", text_origin: "observed", original_text: labelled[2] }] : [];
    }));
    assert.ok(requiredRows.length > 0, `${expected.file}: the frozen answer must name a labelled requirement.`);
    assert.deepEqual(register.rows.map(({ id, text, pages, id_origin, text_origin, original_text }) => ({ id, text, pages, id_origin, text_origin, original_text })), requiredRows, `${expected.file}: scanned requirements must reach the register with their pages and observed wording.`);
    results.push({ file: expected.file, document_id: documentId, upload_to_ready_ms: uploaded.upload_to_ready_ms, progress: uploaded.ingestion.progress, chunks, parser: document.parser_used, pages: document.page_count, verified_lines: lines.length, lines_without_stated_page: withoutPage, register_rows: register.rows.map(row => ({ id: row.id, text: row.text, pages: row.pages, text_origin: row.text_origin })) });
    check(`${expected.file}: multipart scan read by offline OCR before readiness; ${lines.length} frozen lines verify, ${lines.length - withoutPage.length} state their true page, none a wrong one; original bytes kept`);
  }
  const first = results[0];
  const viewer = await restrictedViewer(project.id);
  await request(`/api/projects/${project.id}/documents/${first.document_id}`, { as: viewer, expected: 404 });
  const document = await projectDocument(project.id, first.document_id);
  const allowed = await fetch(`${base}/api/projects/${project.id}/source-evidence`, { ...json("POST", { documentId: first.document_id, quote: "Dette dokumentet inneholder kun testdata.", sourceRevision: document.chunk_source_revision }), headers: { "content-type": "application/json", origin: base, cookie: viewer } });
  assert.equal(allowed.status, 200, "A restricted viewer may verify an excerpt it already has.");
  check("restricted viewer verifies an excerpt but cannot open the scanned source");
  return results;
}

async function complexPdfScenario() {
  const project = await newProject("Fiktiv kompleks PDF-systemtest");
  const results = [];
  // Fjordvik marks four requirements. The Nordic tender is narrative with no marked
  // IDs: an empty register there is correct, and any row would be an invented ID.
  for (const [relative, title, expectedIds] of [["apps/frontend/lib/server/requirements/fixtures/fjordvik-docling-narrative.pdf", "Bilag 1 Fjordvik", ["KRAV-01", "KRAV-02", "KRAV-03", "KRAV-04"]], ["test-data/tenders/tender_nordic_hybrid_cloud_2026.pdf", "Konkurransegrunnlag Nordic Hybrid Cloud", []]]) {
    const uploaded = await upload(project.id, relative, { title });
    const documentId = uploaded.accepted.document.id;
    const enhancementId = uploaded.ingestion.job.result?.docling_enhancement_job_id;
    const enhancement = typeof enhancementId === "string" ? await finishJob(project.id, enhancementId) : null;
    if (enhancement) assert.equal(enhancement.job.status, "completed", enhancement.job.error ?? "");
    const { document, chunks } = await assertReadyAndIndexed(project.id, documentId, title);
    const register = await registerOf(project.id, documentId);
    assert.equal(register?.register_available, true, title);
    assert.deepEqual(register.rows.map(row => row.id), expectedIds, `${title}: register IDs`);
    assert.ok(register.rows.every(row => row.pages.length > 0), `${title}: register rows need pages.`);
    assert.equal(sha256(await download(project.id, documentId)), sha256(uploaded.bytes));
    results.push({ file: path.basename(relative), parser: document.parser_used, status: document.processing_status, pages: document.page_count, chunks, register_rows: register.rows.length, rows_with_pages: register.rows.filter(row => row.pages.length).length, upload_to_ready_ms: uploaded.upload_to_ready_ms, enhancement_ms: enhancement?.duration_ms ?? null, enhancement_skipped: enhancement?.job.result?.skipped ?? null });
  }
  check("complex PDFs reach persisted readiness with chunks, exact register IDs and original bytes");
  return results;
}

async function manualArtifactFixture(projectId) {
  // Paid generation is out of scope here, so the base row is an encrypted fixture.
  // The manual edit itself goes through the real route and its authority checks.
  const { createJiti } = createRequire(path.join(frontend, "package.json"))("jiti");
  Object.assign(process.env, { APP_ENCRYPTION_KEY: runtime.env.APP_ENCRYPTION_KEY });
  const app = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
  const { encryptJson } = await app.import(path.join(frontend, "lib/server/crypto.ts"));
  const revisions = await (await dataApi("/rpc/get_artifact_source_revisions", { method: "POST", body: JSON.stringify({ p_project_id: projectId }) })).json();
  const [row] = await (await dataApi("/generated_artifacts", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify({ project_id: projectId, artifact_type: "losningsutkast", title: "Manuelt utkast", content_markdown: "Fiktivt utgangspunkt.", input_snapshot: encryptJson({ manual_fixture: true }), origin: "generated", input_artifact_source_revision: revisions.artifact_source_revision, input_service_library_revision: revisions.service_library_revision }) })).json();
  const manualText = `Manuelt redigert tekst som må overleve. ${randomUUID()}`;
  // A manual edit publishes a new authoritative version.
  const saved = await (await request(`/api/projects/${projectId}/generate`, json("PATCH", { artifact_id: row.id, title: row.title, content_markdown: manualText }))).json();
  assert.equal(saved.artifact.origin, "manual_edit");
  assert.equal(saved.artifact.source_is_current, true, "The manual version starts current against this source.");
  return { id: saved.artifact.id, manualText };
}
const artifactState = async (projectId, id) => {
  const { artifacts } = await (await request(`/api/projects/${projectId}/generate?artifact_type=losningsutkast`)).json();
  return artifacts.find(item => item.id === id);
};

async function enhancementFailureScenario({ leaveFailed = false } = {}) {
  const project = await newProject(leaveFailed ? "Fiktiv forbedringsfeil (nettlesertest)" : "Fiktiv forbedringsfeil");
  const relative = "test-data/tenders/halandsvik-2026/documents/02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf";
  // Arm failure before ingestion can enqueue/dispatch its enhancement.
  writeFileSync(marker, "");
  try {
  const uploaded = await upload(project.id, relative, { title: "Bilag 1 Kravspesifikasjon" });
  const documentId = uploaded.accepted.document.id;
  const enhancementId = uploaded.ingestion.job.result?.docling_enhancement_job_id;
  assert.equal(typeof enhancementId, "string", "This requirement PDF must queue an enhancement after its basic version.");
  const before = await assertReadyAndIndexed(project.id, documentId, "Grunnversjon");
  const rowsBefore = JSON.stringify((await registerOf(project.id, documentId)).rows);
  const hasArtifact = !leaveFailed;
  const artifact = hasArtifact ? await manualArtifactFixture(project.id) : null;
  const artifactBefore = artifact ? await artifactState(project.id, artifact.id) : null;

    const failed = await finishJob(project.id, enhancementId);
    assert.equal(failed.job.status, "completed", "The usable basic version must not turn enhancement into a failed document.");
    assert.equal(failed.job.result.document.processing_error?.length > 0, true, "The job result must carry the recorded failure.");
    assert.equal(failed.job.message, "Dokumentforbedringen feilet. Grunnversjonen er lagret.", "The job trail must not read as a plain success.");
    const sessionAfterReload = await signIn();
    const reloaded = await projectDocument(project.id, documentId, sessionAfterReload);
    assert.equal(reloaded.processing_status, before.document.processing_status);
    assert.ok(reloaded.processing_error, "A new session must read the persisted failure.");
    assert.equal(reloaded.parser_used, before.document.parser_used);
    assert.equal(reloaded.chunk_source_revision, before.document.chunk_source_revision, "A failed enhancement must not advance the source revision.");
    check("Docling failure in enhancement alone persists on the usable basic document across a new session");
    assert.equal(await chunkCount(project.id, documentId), before.chunks);
    assert.equal(JSON.stringify((await registerOf(project.id, documentId)).rows), rowsBefore);
    assert.equal(sha256(await download(project.id, documentId)), sha256(uploaded.bytes));
    check("failed enhancement leaves chunks, register rows and original bytes unchanged");
    if (artifact) {
      const after = await artifactState(project.id, artifact.id);
      assert.equal(after.content_markdown, artifact.manualText);
      assert.equal(after.source_is_current, artifactBefore.source_is_current, "A failed enhancement must not change source freshness.");
      check("failed enhancement leaves manual work and its freshness unchanged");
    }
    await pause(1_500);
    const activity = await (await request(`/api/projects/${project.id}/jobs`)).json();
    const enhancementJobs = () => activity.jobs.filter(job => job.kind === "document_docling_enhancement");
    assert.equal(enhancementJobs().length, 1, "A failure must not retry itself.");
    assert.ok(!activity.jobs.some(job => job.status === "queued" || job.status === "running"));
    check("no automatic retry runs after the failure");

    if (leaveFailed) return { project_id: project.id, document_id: documentId, left_failed_for_browser: true };

    const retryBody = revision => json("PATCH", { action: "retry_enhancement", source_revision: revision });
    const route = `/api/projects/${project.id}/documents/${documentId}`;
    await request(route, { ...retryBody(reloaded.chunk_source_revision + 1), expected: 409 });
    await request(route, { ...retryBody(undefined), expected: 409 });
    await request(route, { ...json("PATCH", { action: "made_up" }), expected: 400 });
    await request(route, { ...retryBody(reloaded.chunk_source_revision), as: await restrictedViewer(project.id), expected: 404 });
    await request(route, { ...retryBody(reloaded.chunk_source_revision), as: null, expected: 401 });
    check("retry refuses a stale revision, unknown action, restricted viewer and anonymous caller");

    const stillFailing = await (await request(route, { ...retryBody(reloaded.chunk_source_revision), expected: 202 })).json();
    assert.equal(stillFailing.job.kind, "document_docling_enhancement");
    const failedAgain = await finishJob(project.id, stillFailing.job.id);
    assert.ok(failedAgain.job.result.document.processing_error, "A retry that fails records the failure again.");
    assert.equal((await projectDocument(project.id, documentId)).chunk_source_revision, reloaded.chunk_source_revision);
    check("an explicit retry that fails again keeps the basic version and the recorded failure");

    rmSync(marker, { force: true });
    const accepted = await (await request(route, { ...retryBody(reloaded.chunk_source_revision), expected: 202 })).json();
    const queued = await projectDocument(project.id, documentId);
    assert.equal(queued.processing_error, null, "Every reader must see the retry, not the old failure.");
    await request(route, { ...retryBody(reloaded.chunk_source_revision), expected: 409 });
    const queuedJobs = (await (await request(`/api/projects/${project.id}/jobs`)).json()).jobs.filter(job => job.kind === "document_docling_enhancement" && ["queued", "running"].includes(job.status));
    assert.deepEqual(queuedJobs.map(job => job.id), [accepted.job.id], "A repeated click must not add work.");
    check("a queued retry replaces the persisted failure and a repeated click adds no work");
    const recovered = await finishJob(project.id, accepted.job.id);
    assert.equal(recovered.job.status, "completed", recovered.job.error ?? "");
    const after = await assertReadyAndIndexed(project.id, documentId, "Gjenopprettet dokument");
    assert.equal(after.document.processing_status, "enhanced_ready");
    assert.equal(after.document.parser_used, "docling");
    assert.equal(after.document.processing_error, null);
    assert.ok(after.document.chunk_source_revision > reloaded.chunk_source_revision, "A replaced source must advance its revision.");
    assert.equal(sha256(await download(project.id, documentId)), sha256(uploaded.bytes));
    assert.deepEqual((await registerOf(project.id, documentId)).rows.map(row => row.id).sort(), JSON.parse(rowsBefore).map(row => row.id).sort());
    check("explicit recovery publishes the Docling version with a new revision, same IDs and original bytes");
    const recoveredArtifact = await artifactState(project.id, artifact.id);
    assert.equal(recoveredArtifact.content_markdown, artifact.manualText, "Recovery must not touch manual text.");
    assert.equal(recoveredArtifact.source_is_current, false, "Work based on the older source must read as stale.");
    check("recovery keeps manual text byte for byte and marks it stale against the new source");
    await request(route, { ...retryBody(after.document.chunk_source_revision), expected: 409 });
    check("a recovered document has nothing left to retry");
    const finalActivity = await (await request(`/api/projects/${project.id}/jobs`)).json();
    return { project_id: project.id, document_id: documentId, revision_before: reloaded.chunk_source_revision, revision_after: after.document.chunk_source_revision, chunks_before: before.chunks, chunks_after: after.chunks, enhancement_jobs: finalActivity.jobs.filter(job => job.kind === "document_docling_enhancement").map(job => job.status), recovery_ms: recovered.duration_ms, recovery_progress: recovered.progress };
  } finally {
    rmSync(marker, { force: true });
  }
}

const DEADLINE_MS = 60_000, PARSER_RETURNS_AFTER_MS = 75_000;
async function enhancementDeadlineScenario() {
  const project = await newProject("Fiktiv forbedringsfrist");
  const relative = "test-data/tenders/halandsvik-2026/documents/02_Bilag_1_Kravspesifikasjon_Halandsvik_kommune.pdf";
  writeFileSync(marker, "");
  let uploaded, documentId, route, artifact;
  try {
    uploaded = await upload(project.id, relative, { title: "Bilag 1 Kravspesifikasjon" });
    documentId = uploaded.accepted.document.id;
    route = `/api/projects/${project.id}/documents/${documentId}`;
    artifact = await manualArtifactFixture(project.id);
    assert.equal((await finishJob(project.id, uploaded.ingestion.job.result.docling_enhancement_job_id)).job.status, "completed");
  } finally { rmSync(marker, { force: true }); }
  const before = await assertReadyAndIndexed(project.id, documentId, "Grunnversjon");
  const rowsBefore = JSON.stringify((await registerOf(project.id, documentId)).rows);
  const artifactBefore = await artifactState(project.id, artifact.id);
  const { job } = await (await request(route, { ...json("PATCH", { action: "retry_enhancement", source_revision: before.document.chunk_source_revision }), expected: 202 })).json();

  const stub = path.join(status.directory, "next-cache-stub.cjs"), parser = path.join(status.directory, "slow-docling.mjs"), parserRan = path.join(status.directory, "slow-docling-returned");
  rmSync(parserRan, { force: true });
  writeFileSync(stub, "exports.revalidatePath = () => {}; exports.revalidateTag = () => {};");
  writeFileSync(parser, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
await new Promise(resolve => setTimeout(resolve, ${PARSER_RETURNS_AFTER_MS}));
writeFileSync(${JSON.stringify(parserRan)}, "");
writeFileSync(path.join(output, "source.md"), "Sen tekst som aldri skal publiseres. ".repeat(4000));
`, { mode: 0o700 });
  const startedAt = performance.now();
  const exited = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/system-test-enhancement-deadline-run.mjs"), job.id, stub, String(PARSER_RETURNS_AFTER_MS - DEADLINE_MS + 10_000)], { cwd: frontend, stdio: ["ignore", "ignore", "inherit"],
      env: isolatedApplicationEnvironment(frontend, { ...runtime.env, DOCLING_CLI_COMMAND: parser, PROJECT_JOB_DOCUMENT_DOCLING_ENHANCEMENT_TIMEOUT_MS: String(DEADLINE_MS) }) });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`The deadline run exited with ${code}.`)));
  });
  // The running state is what a deadline used to leave behind for good.
  let running = await projectDocument(project.id, documentId);
  for (let wait = 0; wait < 60 && !/pågår/u.test(running.processing_message ?? ""); wait++) { await pause(500); running = await projectDocument(project.id, documentId); }
  assert.match(running.processing_message, /pågår/u);
  assert.equal(running.processing_error, null);
  // A development server may reset one poll while it recompiles; only the outcome counts.
  const readJob = () => request(`/api/projects/${project.id}/jobs/${job.id}`).then(response => response.json()).catch(error => { if (error instanceof TypeError) return { job: { status: "unreadable" } }; throw error; });
  let finished = await readJob();
  while (finished.job.status !== "failed" && performance.now() - startedAt < DEADLINE_MS + 30_000) { await pause(1_000); finished = await readJob(); }
  assert.equal(finished.job.status, "failed", "The worker must fail the job at its real deadline.");
  assert.match(finished.job.message, /totalfristen/u);
  const atDeadline = await projectDocument(project.id, documentId, await signIn());
  assert.ok(atDeadline.processing_error, "A new session must read the failure the moment the job ended.");
  assert.equal(atDeadline.processing_status, before.document.processing_status);
  assert.equal(atDeadline.parser_used, before.document.parser_used);
  assert.equal(atDeadline.chunk_source_revision, before.document.chunk_source_revision);
  check(`a parser passing a real ${DEADLINE_MS / 1000} s job deadline leaves a persisted failure on the usable basic version`);

  await exited;
  assert.ok(existsSync(parserRan), "The parser must have returned after the deadline for this to prove anything.");
  const late = await assertReadyAndIndexed(project.id, documentId, "Etter sen parser");
  assert.equal(late.document.chunk_source_revision, before.document.chunk_source_revision, "The abandoned workflow must not publish.");
  assert.equal(late.document.parser_used, before.document.parser_used);
  assert.equal(late.document.processing_error, atDeadline.processing_error);
  assert.equal(late.chunks, before.chunks);
  assert.equal(JSON.stringify((await registerOf(project.id, documentId)).rows), rowsBefore);
  assert.equal(sha256(await download(project.id, documentId)), sha256(uploaded.bytes));
  const untouched = await artifactState(project.id, artifact.id);
  assert.equal(untouched.content_markdown, artifact.manualText);
  assert.equal(untouched.source_is_current, artifactBefore.source_is_current);
  check("the abandoned workflow writes nothing when its parser returns; chunks, register, bytes and manual work stay");
  const active = (await (await request(`/api/projects/${project.id}/jobs`)).json()).jobs.filter(item => item.status === "queued" || item.status === "running");
  assert.deepEqual(active, [], "The failure must not retry itself.");

  await request(route, { ...json("PATCH", { action: "retry_enhancement", source_revision: late.document.chunk_source_revision + 1 }), expected: 409 });
  const accepted = await (await request(route, { ...json("PATCH", { action: "retry_enhancement", source_revision: late.document.chunk_source_revision }), expected: 202 })).json();
  const recovered = await finishJob(project.id, accepted.job.id);
  assert.equal(recovered.job.status, "completed", recovered.job.error ?? "");
  const after = await assertReadyAndIndexed(project.id, documentId, "Gjenopprettet");
  assert.equal(after.document.processing_status, "enhanced_ready");
  assert.equal(after.document.processing_error, null);
  assert.ok(after.document.chunk_source_revision > late.document.chunk_source_revision);
  const stale = await artifactState(project.id, artifact.id);
  assert.equal(stale.content_markdown, artifact.manualText, "Recovery must not touch manual text.");
  assert.equal(stale.source_is_current, false);
  check("the document stays retryable after a deadline and an explicit retry recovers it");
  return { project_id: project.id, document_id: documentId, deadline_ms: DEADLINE_MS, parser_returned_after_ms: PARSER_RETURNS_AFTER_MS, job_error: finished.job.error, document_error: atDeadline.processing_error, revision_before: before.document.chunk_source_revision, revision_after_recovery: after.document.chunk_source_revision, chunks_before: before.chunks, chunks_after_late_return: late.chunks };
}

async function metricsScenario() {
  // A real ingestion trace, then the real route. Durations here are synthetic
  // inputs that exercise correlation; they are not measurements.
  const project = await newProject("Fiktiv tidsmålingskontroll");
  const form = new FormData();
  form.set("file", new File(["K-1.1 Leverandøren skal dokumentere driften."], "krav.txt", { type: "text/plain" }));
  form.set("title", "Bilag 1 krav"); form.set("role", "supporting_document"); form.set("role_source", "explicit"); form.set("supporting_subtype", "kravdokument");
  const accepted = await (await request(`/api/projects/${project.id}/documents`, { method: "POST", body: form, expected: 201 })).json();
  assert.equal((await finishJob(project.id, accepted.job.id)).job.status, "completed");
  const document = await projectDocument(project.id, accepted.document.id);
  const route = `/api/projects/${project.id}/performance`;
  const ready = { phase: "upload_to_ready", traceId: document.id, documentId: document.id, sourceRevision: document.chunk_source_revision, durationMs: 1234 };
  await request(route, { ...json("POST", ready), expected: 204 });
  await request(route, { ...json("POST", { ...ready, sourceRevision: document.chunk_source_revision + 1 }), expected: 409 });
  await request(route, { ...json("POST", { ...ready, traceId: "ffffffff-ffff-4fff-8fff-ffffffffffff", documentId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }), expected: 404 });
  await request(route, { ...json("POST", { ...ready, sourceRevision: undefined }), expected: 400 });
  await request(route, { ...json("POST", ready), as: null, expected: 401 });
  const chatTrace = randomUUID();
  await request(route, { ...json("POST", { phase: "chat_first_render", traceId: chatTrace, cacheState: "cold", durationMs: 321 }), expected: 204 });
  await pause(300);
  const events = readFileSync(path.join(status.directory, "app.log"), "utf8").split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const browser = events.filter(event => event.event === "workflow_performance" && event.project_id === project.id && event.operation === "browser");
  assert.equal(browser.length, 2, "Only accepted samples may reach the log.");
  const logged = browser.find(event => event.phase === "upload_to_ready");
  assert.deepEqual([logged.trace_id, logged.document_class, logged.source_revision, logged.duration_ms], [document.id, "txt", document.chunk_source_revision, 1234]);
  assert.equal(browser.find(event => event.phase === "chat_first_render").document_class, "txt", "A chat takes its class from the project's corpus.");
  const server = events.filter(event => event.event === "workflow_performance" && event.trace_id === document.id && event.operation === "document" && event.phase === "total");
  assert.deepEqual(server.map(event => [event.job_kind, event.document_class]), [["document_ingestion", "txt"]], "The job trace carries its kind and class.");
  assert.doesNotMatch(JSON.stringify(browser), /Leverandøren|krav\.txt/u, "Metrics carry no content or file names.");
  check("performance route records only correlated samples and refuses stale, foreign, malformed and anonymous ones");
  return { accepted_samples: browser.length };
}

const result = { limitation: "One local synthetic sample per fixture on a development server; no percentile, production latency or model output.", parser_image: status.docling.image, parser_image_id: status.docling.imageId };
if (wants("metrics")) result.metrics = await metricsScenario();
if (wants("text-pdf")) result.text_pdf = await textPdfScenario();
if (wants("ocr")) result.ocr = await ocrScenario();
if (wants("complex")) result.complex_pdf = await complexPdfScenario();
if (wants("enhancement")) result.enhancement_recovery = await enhancementFailureScenario();
if (wants("enhancement-deadline")) result.enhancement_deadline = await enhancementDeadlineScenario();
if (leaveFailedForBrowser) result.browser_fixture = await enhancementFailureScenario({ leaveFailed: true });
result.checks = checks;
writeFileSync(path.join(status.directory, "documents-system-result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
writeFileSync(systemTestStatusPath(), JSON.stringify({ ...status, ...(result.browser_fixture ? { projectId: result.browser_fixture.project_id } : {}), documentChecks: checks.length }, null, 2));
console.log(JSON.stringify(result, null, 2));
assert.ok(!existsSync(marker));
