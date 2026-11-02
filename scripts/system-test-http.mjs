#!/usr/bin/env node
// Actual HTTP/system wiring checks. --ai is explicit and requires a stack
// started with live AI credentials; the default never calls a paid model.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { systemTestStatusPath } from "./system-test-runtime.mjs";

const statusPath = systemTestStatusPath();
const status = JSON.parse(readFileSync(statusPath, "utf8"));
assert.equal(status.running, true, "Start scripts/system-test-environment.mjs first.");
const privatePath = path.join(status.directory, "environment.json");
const runtime = JSON.parse(readFileSync(privatePath, "utf8"));
const resumeAi = process.argv.includes("--resume-ai");
const aiEnabled = process.argv.includes("--ai") || resumeAi;
const allGenerators = process.argv.includes("--all-generators");
if (allGenerators && !aiEnabled) throw new Error("All generators require explicit --ai.");
const accessOnly = process.argv.includes("--access-only");
if (accessOnly && aiEnabled) throw new Error("Choose --access-only or --ai, not both.");
if (runtime.env.OPENAI_API_KEY && !aiEnabled && !accessOnly) throw new Error("This stack has a model endpoint enabled. Use --ai explicitly, or --access-only to reuse existing sources without AI calls.");
const base = status.baseUrl;
assert.equal(new URL(base).hostname, "127.0.0.1", "Only the owned loopback stack is allowed.");
const checks = [];
let adminCookie;
// Each run starts a fresh scenario in this owned database, including fresh
// rate-limit fixtures. Application authorization and session checks stay real.
assert.equal(runtime.env.DATA_API_URL, "http://127.0.0.1:55449");
const resetLimits = await fetch(`${runtime.env.DATA_API_URL}/app_rate_limits`, {
  method: "DELETE", headers: { authorization: `Bearer ${runtime.env.DATA_API_SERVICE_ROLE_KEY}` },
});
assert.ok(resetLimits.ok, "Could not reset local rate-limit fixtures.");
async function request(route, { cookie = adminCookie, expected = 200, ...options } = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options, redirect: "manual", signal: AbortSignal.timeout(600_000),
    headers: { origin: base, ...(cookie ? { cookie } : {}), ...options.headers },
  });
  assert.equal(response.status, expected, `${options.method ?? "GET"} ${route}: expected ${expected}, got ${response.status}`);
  return response;
}
const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const cookieFrom = response => {
  const value = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(value?.startsWith("bidsite_session="), "Login must return the real session cookie.");
  return value;
};
async function runJob(projectId, job) {
  await request("/api/project-jobs/worker", { ...json("POST", { limit: 10 }), headers: { "content-type": "application/json", "x-worker-token": runtime.env.PROJECT_JOB_WORKER_TOKEN } });
  // The accepting route can already have claimed the job for its background
  // runner. Worker completion alone therefore does not establish publication.
  const attempts = aiEnabled ? 3000 : 300;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await (await request(`/api/projects/${projectId}/jobs/${job.id}`)).json();
    if (["completed", "failed"].includes(current.job.status)) {
      assert.equal(current.job.status, "completed", `Job ${job.kind} did not complete (${current.job.status}): ${current.job.error ?? "no error detail"}`);
      return current.job;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Job ${job.kind} did not publish a terminal result within the test deadline.`);
}

await request("/api/health/live"); checks.push("liveness");
await request("/api/projects", { cookie: null, expected: 401 }); checks.push("anonymous access denied");
await request("/api/auth/login", { ...json("POST", { password: "intentionally-wrong-system-test-password" }), cookie: null, expected: 401 });
const login = await request("/api/auth/login", { ...json("POST", { password: runtime.adminPassword }), cookie: null });
adminCookie = cookieFrom(login); checks.push("admin password authentication and persisted session");
if (aiEnabled) {
  await request("/api/health/ready");
  checks.push("authenticated readiness of the configured system dependencies");
}
const resumeProjectId = resumeAi ? JSON.parse(readFileSync(path.join(status.directory, "ai-output.json"), "utf8")).projectId : null;
const project = resumeAi ? await (await request(`/api/projects/${resumeProjectId}`)).json() : accessOnly
  ? (await (await request("/api/projects")).json()).find(item => item.document_count === 3)
  : await (await request("/api/projects", { ...json("POST", { name: "Fiktiv systemtest", customer_name: "Fiktiv kommune" }), expected: 201 })).json();
assert.ok(project?.id, "Access-only mode needs an existing synthetic three-document project.");
checks.push(resumeAi ? "reused the owned synthetic project whose AI jobs already completed" : accessOnly ? "reused owned synthetic project for access checks" : "authenticated project creation");
const docs = [
  { role: "primary_customer_document", file: "konkurransegrunnlag.txt", title: "Konkurransegrunnlag", text: "Fiktiv kommune har 120 ansatte fordelt på tre lokasjoner. Kommunen anskaffer drift av en sikker skyplattform. Avtalen varer i tre år med opsjon på ett ekstra år. Tilbudsfrist er 10. november 2026. Kundedata skal behandles i Norge. Kravspesifikasjonen finnes i Bilag 1 og leverandørens besvarelse i løsningsnotatet. Kommunen legger vekt på trygg overgang, dokumentert driftsansvar og en etterprøvbar exitplan." },
  { role: "supporting_document", subtype: "kravdokument", file: "bilag1-krav.txt", title: "Bilag 1 Kravspesifikasjon", text: "1 Drift\nK-1.1 Leverandøren skal drifte plattformen hele døgnet og dokumentere kontaktpunkt for kritiske hendelser.\n2 Sikkerhet\nK-1.2 Kundedata, sikkerhetskopier og identifiserbare logger skal lagres og behandles i Norge.\n3 Exit\nK-1.3 Leverandøren skal levere en exitplan med eksport i åpne formater innen 30 dager." },
  { role: "primary_solution_document", file: "losningsnotat.txt", title: "Løsningsnotat", text: "Atea drifter plattformen hele døgnet. Driftssenterets vaktleder er navngitt kontaktpunkt for kritiske hendelser og følger hendelsen til godkjent avslutning. Kundedata, sikkerhetskopier og identifiserbare logger lagres og behandles i Norge. Dette dokumenteres gjennom regionoversikt og tilgangsrevisjon før produksjonssetting. Atea leverer en exitplan med eksport av kundens data i åpne formater innen 30 dager. Eksporten testes med kunden og kontrollsummer bekrefter at data er komplette før avtalen avsluttes." },
];
const uploaded = resumeAi ? project.documents.map(document => ({ id: document.id, role: document.role })) : [];
for (const doc of accessOnly || resumeAi ? [] : docs) {
  const form = new FormData();
  form.set("file", new File([doc.text], doc.file, { type: "text/plain" }));
  form.set("title", doc.title); form.set("role", doc.role); form.set("role_source", "explicit");
  if (doc.subtype) form.set("supporting_subtype", doc.subtype);
  const result = await (await request(`/api/projects/${project.id}/documents`, { method: "POST", body: form, expected: 201 })).json();
  await runJob(project.id, result.job);
  const download = await request(`/api/projects/${project.id}/documents/${result.document.id}`);
  assert.equal(await download.text(), doc.text, "Encrypted blob round-trip must preserve original upload bytes.");
  uploaded.push({ id: result.document.id, role: doc.role });
}
if (!accessOnly && !resumeAi) {
  checks.push("three document roles uploaded through actual multipart route");
  checks.push("actual queue claim, parsing, persisted chunk indexing and readiness");
  checks.push("encrypted Azure SDK/Azurite upload and original-byte download");
}
const current = await (await request(`/api/projects/${project.id}`)).json();
const currentDocuments = current.project?.documents ?? current.documents;
assert.equal(currentDocuments.length, 3);
assert.ok(currentDocuments.every(doc => ["basic_ready", "enhanced_ready"].includes(doc.processing_status)));
const register = await (await request(`/api/projects/${project.id}/requirement-register`)).json();
const formalRegister = register.documents.find(document => document.id === currentDocuments.find(document => document.title === "Bilag 1 Kravspesifikasjon")?.id);
assert.ok(formalRegister?.register_available, "The actual ingestion must persist a deterministic requirement register.");
assert.deepEqual(formalRegister.rows.map(row => row.id), ["K-1.1", "K-1.2", "K-1.3"]);
assert.ok(formalRegister.rows.every(row => row.id_origin === "source" && row.text.trim()), "Register rows must retain observed IDs and source text.");
checks.push("source-revision-bound persisted requirement register through the actual read route");
if (accessOnly) uploaded.push(...currentDocuments.map(doc => ({ id: doc.id, role: doc.role })));
const listing = await (await request("/api/projects")).json();
assert.equal(listing.find(item => item.id === project.id).document_count, 3);
checks.push("dashboard aggregate counts through real PostgREST RPC");
const invitation = await (await request("/api/admin/users", { ...json("POST", { email: `system-test-${Date.now()}@example.invalid`, displayName: "Fiktiv innsynsbruker", guestDescription: "Lokal sikkerhetstest", projectId: project.id, role: "restricted_viewer" }), expected: 201 })).json();
assert.ok(invitation.guestCode, "Administrator must receive a local guest credential.");
const guest = await request("/api/auth/guest", { ...json("POST", { code: invitation.guestCode }), cookie: null });
const guestCookie = cookieFrom(guest);
await request(`/api/projects/${project.id}`, { cookie: guestCookie });
const evidenceBody = { documentId: uploaded[1].id, sourceRevision: currentDocuments.find(document => document.id === uploaded[1].id).chunk_source_revision, quote: "Leverandøren skal drifte plattformen hele døgnet og dokumentere kontaktpunkt for kritiske hendelser." };
const guestEvidence = await (await request(`/api/projects/${project.id}/source-evidence`, { ...json("POST", evidenceBody), cookie: guestCookie })).json();
assert.equal(guestEvidence.source.classification, "documented");
assert.equal(guestEvidence.source.original_quote, evidenceBody.quote);
assert.ok(guestEvidence.source.evidence_id && guestEvidence.source.source_fingerprint && guestEvidence.source.source_revision === evidenceBody.sourceRevision);
await request(`/api/projects/${project.id}/source-evidence`, { ...json("POST", { ...evidenceBody, quote: "Et oppdiktet krav som ikke finnes i dokumentgrunnlaget." }), cookie: guestCookie, expected: 422 });
await request(`/api/projects/${project.id}/source-evidence`, { ...json("POST", { ...evidenceBody, sourceRevision: evidenceBody.sourceRevision + 1 }), cookie: guestCookie, expected: 409 });
await request(`/api/projects/${project.id}/source-evidence`, { ...json("POST", { ...evidenceBody, documentId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }), cookie: guestCookie, expected: 404 });
checks.push("restricted viewer original-excerpt verification, invented quote/stale revision/foreign source denied");

// Middleware deliberately hides forbidden project routes with 404 before
// the handler's finer-grained 403 authorization response can run.
await request(`/api/projects/${project.id}/documents/${uploaded[0].id}`, { cookie: guestCookie, expected: 404 });
await request(`/api/projects/${project.id}/generate`, { ...json("POST", { artifact_type: "forbedret_kravsvar" }), cookie: guestCookie, expected: 404 });
await request(`/api/projects/${project.id}/chat`, { ...json("POST", { message: "Hva er exitplanen?" }), cookie: guestCookie, expected: 404 });
await request("/api/admin/users", { cookie: guestCookie, expected: 403 });
checks.push("guest authentication, allowed read, denied source download/generation/chat/admin access");
const guestProject = await (await request("/api/projects", { ...json("POST", { name: "Gjestens lokale prosjekt" }), cookie: guestCookie, expected: 201 })).json();
await request(`/api/projects/${guestProject.id}`);
checks.push("guest-owned project creation and global admin access without a project grant");

if (aiEnabled) {
  assert.ok(runtime.env.OPENAI_API_KEY, "AI tests require an explicitly configured live/fixture model endpoint.");
  const workflows = [
    { kind: "customer_analysis" },
    { kind: "artifact_generation", artifact_type: "forbedret_kravsvar", source_document_ids: [uploaded[1].id] },
    ...(allGenerators ? ["losningsutkast", "gjennomforing_og_risiko"].map(artifact_type => ({ kind: "artifact_generation", artifact_type })) : []),
    { kind: "artifact_generation", artifact_type: "bilag1_rekonstruksjon" },
    { kind: "solution_evaluation", solution_document_id: uploaded[2].id }, { kind: "executive_summary" },
  ];
  for (const body of resumeAi ? [] : workflows) {
    const queued = await (await request(`/api/projects/${project.id}/jobs`, { ...json("POST", body), expected: 202 })).json();
    await runJob(project.id, queued.job);
    if (body.kind === "artifact_generation") {
      const result = await (await request(`/api/projects/${project.id}/generate?artifact_type=${body.artifact_type}`)).json();
      assert.ok(result.artifacts.some(artifact => artifact.is_current && artifact.source_is_current), "A newly published artifact must be fresh at publication.");
    }
    checks.push(`AI workflow completed and persisted: ${body.kind}${body.artifact_type ? `/${body.artifact_type}` : ""}`);
  }
  const published = await (await request(`/api/projects/${project.id}`)).json();
  const generated = await (await request(`/api/projects/${project.id}/generate?artifact_type=forbedret_kravsvar`)).json();
  const artifact = generated.artifacts.find(item => item.is_current === true);
  // Retain only synthetic evidence, never credentials or request headers.
  writeFileSync(path.join(status.directory, "ai-output.json"), JSON.stringify({
    projectId: project.id, customerAnalysis: published.customer_analysis,
    artifact, solutionEvaluation: published.solution_evaluation,
  }, null, 2), { mode: 0o600 });
  assert.ok(published.customer_analysis?.customer_profile_summary?.length > 60, "Customer analysis must publish substantive content.");
  assert.match(JSON.stringify(published.customer_analysis), /120/u, "Analysis must preserve the documented customer size.");
  assert.ok(artifact?.content_markdown?.length > 300, "Generation must publish a substantive artifact.");
  assert.equal(artifact.is_current, true, "Published artifact must be authoritative.");
  assert.equal(typeof artifact.source_is_current, "boolean", "Artifact freshness remains explicit after cross-type knowledge changes.");
  for (const suffix of [1, 2, 3]) assert.match(artifact.content_markdown, new RegExp(`K[- ]?1\\.${suffix}\\b`, "iu"), "Every explicit requirement must survive generation.");
  assert.equal(published.solution_evaluation?.solution_document_id, uploaded.find(document => document.role === "primary_solution_document").id, "Evaluation must reference the selected solution.");
  assert.ok(published.solution_evaluation.fit_to_customer_needs.length > 60, "Evaluation must publish substantive content.");
  assert.equal(artifact.input_snapshot.source_evidence.version, 1, "Requirement answer evidence must persist.");
  assert.equal(artifact.input_snapshot.source_evidence.issues?.length ?? 0, 0, "The known answerable requirement fixture must not need source clarification.");
  assert.equal(published.solution_evaluation.source_evidence.version, 1, "Evaluation evidence must persist.");
  assert.equal(published.solution_evaluation.source_evidence.issues?.length ?? 0, 0, "Known source-grounded evaluation fields must not be withheld.");
  const bilagList = await (await request(`/api/projects/${project.id}/generate?artifact_type=bilag1_rekonstruksjon`)).json();
  const bilag = bilagList.artifacts.find(item => item.is_current && item.source_is_current);
  assert.ok(bilag?.content_markdown?.length > 300, "Bilag 1 must publish a substantive current artifact.");
  assert.equal(bilag.input_snapshot.source_evidence.version, 1, "Bilag 1 evidence must persist.");
  assert.equal(bilag.input_snapshot.source_evidence.issues?.length ?? 0, 0, "Known Bilag 1 source fields must not be withheld.");
  const summaryResult = await (await request(`/api/projects/${project.id}/executive-summary`)).json();
  assert.equal(summaryResult.executive_summary?.source_evidence?.version, 1, "Executive summary evidence must persist.");
  assert.equal(summaryResult.executive_summary.source_evidence.issues?.length ?? 0, 0, "Known executive-summary source fields must not be withheld.");
  const allArtifacts = await (await request(`/api/projects/${project.id}/generate`)).json();
  writeFileSync(path.join(status.directory, "ai-output.json"), JSON.stringify({ projectId: project.id, customerAnalysis: published.customer_analysis, artifact, artifacts: allArtifacts.artifacts, solutionEvaluation: published.solution_evaluation, executiveSummary: summaryResult.executive_summary }, null, 2), { mode: 0o600 });
  checks.push("persisted AI outputs retain customer facts, all three requirement IDs, explicit freshness and selected solution provenance");
  checks.push("deterministic evidence contract persists across requirement answers, Bilag 1, evaluation and executive summary");
  const chat = await request(`/api/projects/${project.id}/chat`, json("POST", { message: "Hva er fristen for eksport av data ved exit? Vis kilden." }));
  const content = await chat.text();
  assert.ok(content.length > 100, "Chat must produce a streamed response.");
  assert.match(content, /30\s+dager/iu, "Chat must retain the documented exit deadline.");
  assert.match(content, /K-1\.3|Bilag\s*1|løsningsnotat/iu, "Chat must name its source.");
  checks.push("chat streaming with actual model endpoint");
  assert.doesNotMatch(content, /kunne ikke kildebekreftes/iu, "A correct source quote must pass deterministic validation.");
  const persistedChat = await (await request(`/api/projects/${project.id}/chat`)).json();
  const answer = persistedChat.messages.filter(message => message.role === "assistant").at(-1);
  assert.equal(answer.content, content);
  assert.ok(answer.source_references.length > 0, "Actual cited evidence must survive database decryption and reload.");
  for (const reference of answer.source_references) {
    assert.ok(reference.evidence_id && reference.original_quote && reference.source_fingerprint);
    assert.ok(Number.isSafeInteger(reference.citation_number) && Number.isSafeInteger(reference.source_revision));
    assert.match(content, new RegExp(`\\[Kilde ${reference.citation_number}\\]`, "u"));
  }
  checks.push("validated chat source IDs, sparse citation numbers, original quotation and revision survive actual persistence/reload");

}
runtime.sessions = { adminCookie, guestCookie };
writeFileSync(privatePath, JSON.stringify(runtime, null, 2), { mode: 0o600 });
const result = { resumedCompletedAiWorkflows: resumeAi, projectId: project.id, guestProjectId: guestProject.id, documents: uploaded, checks, aiMode: aiEnabled ? status.aiMode : "not exercised", skipped: [...(aiEnabled ? [] : ["AI analysis, generation, evaluation and chat output"]), "live Entra sign-in", "PDF/OCR through HTTP upload (separate image/parser evaluation)"] };
writeFileSync(path.join(status.directory, "http-result.json"), JSON.stringify(result, null, 2));
writeFileSync(statusPath, JSON.stringify({ ...status, projectId: project.id, documents: uploaded, httpChecks: checks.length }, null, 2));
console.log(JSON.stringify(result, null, 2));
