#!/usr/bin/env node

import { createRequire } from "node:module";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const currentBase = args.get("--current-base");
const mainBase = args.get("--main-base");
const envPath = args.get("--env");
const repoRoot = args.get("--repo") ?? process.cwd();
const outPath =
  args.get("--out") ?? `/tmp/anbud-llm-quality-eval-${Date.now()}.json`;
const judgeModel = args.get("--judge-model") ?? "gpt-5.4";
const rounds = parsePositiveInteger(args.get("--rounds"), 3);
const judgeTimeoutMs = parsePositiveInteger(args.get("--judge-timeout-ms"), 180_000);
const judgeRetries = parsePositiveInteger(args.get("--judge-retries"), 3);
const defaultBilag1Path = path.join(
  repoRoot,
  "test-data/tenders/tender_nordic_hybrid_cloud_2026.pdf",
);
const bilag1Path = path.resolve(args.get("--bilag1") ?? defaultBilag1Path);

if (!currentBase || !mainBase || !envPath) {
  throw new Error(
    "Usage: node scripts/llm_quality_eval.mjs --current-base <url> --main-base <url> --env <path> [--repo <path>] [--bilag1 <path>] [--out <path>] [--judge-model <model>] [--rounds <n>] [--judge-timeout-ms <ms>] [--judge-retries <n>]",
  );
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnvFile(value) {
  const parsed = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    parsed[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const env = parseEnvFile(await readFile(envPath, "utf8"));
const password = env.APP_ACCESS_PASSWORD;
const openAiApiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!password) {
  throw new Error("APP_ACCESS_PASSWORD missing in env file.");
}
if (!openAiApiKey) {
  throw new Error("OPENAI_API_KEY missing in env file or environment.");
}

const requireFromApp = createRequire(path.join(repoRoot, "apps/frontend/package.json"));
const JSZip = requireFromApp("jszip");

const startedAt = Date.now();
const runId = `llm-eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const fixtureDir = path.join("/tmp", "anbud-llm-eval-fixtures", runId);
await mkdir(fixtureDir, { recursive: true });
try {
  await access(bilag1Path);
} catch {
  throw new Error(`Bilag 1 fixture not found: ${bilag1Path}. Pass --bilag1 <path>.`);
}

const GROUND_TRUTH = [
  "Bilag 1 gjelder Nordic Retail Logistics AS, et fiktivt norsk selskap med ca. 650 ansatte innen lagerdrift, transportkoordinering og distribusjon til detaljhandel i Norge og Sverige.",
  "Kunden har vokst gjennom oppkjøp og har et sammensatt IT-landskap med eldre systemer, ulik infrastruktur på tvers av lokasjoner og begrenset standardisering.",
  "Dagens situasjon omfatter blant annet ERP, WMS, CRM, integrasjoner mot transportører/kunder/leverandører, filservere, lokalt Active Directory, Microsoft 365 og mindre støttesystemer.",
  "Hovedutfordringene er skalerbarhet, sikkerhet, tilgjengelighet, driftskostnader, endringstakt, lokal infrastruktur, teknisk gjeld, manuelle prosesser, svak standardisering og nøkkelpersonavhengighet.",
  "Anskaffelsen omfatter rådgivning, design, etablering, migrering og overgang til stabil forvaltning av en fremtidsrettet skyløsning.",
  "Målene er sikker og skalerbar skyplattform, redusert lokal infrastruktur og teknisk gjeld, bedre stabilitet/tilgjengelighet, raskere endring, bedre sikkerhet/etterlevelse, kostnadskontroll, standardisering, automatisering og modernisering.",
  "Skyplattformen skal minimum dekke identitet og tilgangsstyring, nettverk og segmentering, sikkerhetsmekanismer, logging/overvåkning, backup/gjenoppretting, policy/governance, automatisert provisjonering og grunnlag for utvikling/test/produksjon.",
  "Migrering og modernisering skal vurdere hva som bør rehostes, replatformes, refaktoreres, beholdes midlertidig lokalt, fases ut eller erstattes.",
  "Arkitekturkravene omfatter målarkitektur for nettverk, identitet, arbeidslaster, data, integrasjoner og sikkerhet, tydelig separasjon mellom utvikling/test/produksjon, skalerbarhet for sesongtopper og kampanjeperioder, høy tilgjengelighet og automatisering.",
  "Sikkerhetskravene omfatter moderne identitets- og tilgangsstyring, rollebasert tilgang, MFA, logging/sporbarhet, sikker konfigurasjon, herding, sårbarhetshåndtering, segmentering, personvern/informasjonssikkerhet/revisjon, backup/gjenoppretting og ansvarsdeling mellom kunde og leverandør.",
  "Driftskravene omfatter sentralisert overvåkning, hendelseshåndtering, proaktiv drift, kontinuerlig forbedring, anbefalt driftsmodell, ansvarssnitt og forslag til tjenestenivåer.",
  "Gjennomføringskravene omfatter realistisk migreringsstrategi, prioriteringer, avhengigheter, milepæler, begrenset nedetid for forretningskritiske tjenester, risiko/tiltak, test/verifikasjon, tilbakeføring og overgang til ordinær drift.",
  "Føringer: kunden ønsker Microsoft-nære tjenester der hensiktsmessig, vil unngå unødig leverandørlåsing, har begrenset intern kapasitet, ønsker stegvis tilnærming med synlige gevinster, har begrenset toleranse for driftsavbrudd i åpningstid og må styrke sikkerhetsnivået vesentlig.",
  "Bilag 1 oppgir ikke eksakte RTO/RPO-verdier, budsjett, betalingsbetingelser eller konkrete leveransefrister; disse bør behandles som avklaringer eller foreslåtte tjenestenivåer, ikke som dokumenterte fakta.",
  "Leverandørens besvarelse må være konkret og relatert til kundens situasjon; generiske standardbesvarelser tillegges lav verdi.",
];

const TASKS = [
  {
    key: "customer_analysis",
    label: "Kundeanalyse",
    expectation:
      "Skal identifisere kundens behov, eksplisitte og implisitte krav, risiko, avklaringer, evalueringssignaler, relevante tjenester og posisjonering.",
  },
  {
    key: "high_level_design",
    label: "High-level design",
    expectation:
      "Skal beskrive en kundespesifikk arkitektur med tydelige komponenter, sikkerhet, drift, migrering og et relevant Mermaid-diagram.",
  },
  {
    key: "artifact_generation:forbedret_kravsvar",
    label: "Forbedret kravsvar",
    expectation:
      "Skal gi presise kravsvar som dekker K-1 til K-37, NF-krav, plattform, sikkerhet, drift, migrering, data, dokumentasjon og avklaringer uten å dikte eksakte RTO/RPO, frister eller budsjett.",
  },
  {
    key: "solution_evaluation",
    label: "Løsningsvurdering",
    expectation:
      "Skal sammenligne løsning mot kundekrav, finne gap, gi score, risiko, forbedringsråd og være konkret på dokumentert dekning.",
  },
  {
    key: "executive_summary",
    label: "Lederoppsummering",
    expectation:
      "Skal gi en kort ledervennlig oppsummering med beslutningsrelevante funn, risiko og anbefalinger.",
  },
  {
    key: "perfect_system_solution",
    label: "Perfekt systemløsning",
    expectation:
      "Skal forbedre systemløsningen konkret mot 100/100 ved å lukke gap, innarbeide krav og gjøre løsningen tilbudsklar.",
  },
  {
    key: "chat",
    label: "Chat-svar",
    expectation:
      "Skal svare direkte på tilgjengelighet/nedetid, sikkerhet, migrering, drift, dokumentasjon, Microsoft-føring og hva som ikke er oppgitt, helst med tydelige kildeindikasjoner.",
  },
];

class Client {
  constructor(baseUrlValue) {
    this.baseUrl = baseUrlValue.replace(/\/+$/, "");
    this.cookie = "";
  }

  async request(method, route, options = {}) {
    const headers = new Headers(options.headers ?? {});
    if (this.cookie) headers.set("cookie", this.cookie);
    const started = performance.now();
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers,
      body: options.body,
    });
    const elapsedMs = Math.round(performance.now() - started);
    const setCookie =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    if (setCookie.length) {
      this.cookie = setCookie.map((item) => item.split(";")[0]).join("; ");
    }
    return { response, elapsedMs };
  }

  async json(method, route, body, options = {}) {
    const headers = new Headers(options.headers ?? {});
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set("content-type", "application/json");
    }
    const { response, elapsedMs } = await this.request(method, route, {
      headers,
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : { text: await response.text() };
    if (!response.ok) {
      throw new Error(
        `${method} ${route} failed ${response.status}: ${
          payload.error ?? payload.text ?? "unknown"
        }`,
      );
    }
    return { payload, elapsedMs, status: response.status };
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function makeDocx(filePath) {
  const paragraphs = [
    "Støttenotat for Nordic Retail Logistics AS",
    "Plattform og applikasjonsomfang: Tilbudet skal knytte anbefalt skyplattform til lagerdrift, transportkoordinering, distribusjon, ERP, WMS, CRM og integrasjoner.",
    "Plattformkontroller: Plattformen skal dekke identitet, tilgangsstyring, nettverk, segmentering, sikkerhetsmekanismer, logging, overvåkning, backup, gjenoppretting, policyer, governance og automatisert provisjonering.",
    "Migreringsstrategi: Strategien skal vurdere rehost, replatform, refaktorering, midlertidig lokal videreføring, utfasing og erstatning.",
    "Drift og forvaltning: Svaret skal beskrive ansvarssnitt, proaktiv drift, hendelseshåndtering, tjenestenivåforslag, dokumentasjon og kunnskapsoverføring.",
    "Microsoft-føring: Kunden ønsker Microsoft-nære tjenester der det er hensiktsmessig, men ikke unødig leverandørlåsing.",
    "Åpen avklaring: Bilag 1 oppgir ikke eksakt RTO, RPO, budsjett, betalingsbetingelser eller bindende leveransefrister.",
    "Åpen avklaring: Leverandøren bør foreslå konkrete tjenestenivåer og migreringsmilepæler som forutsetninger, ikke presentere dem som dokumenterte krav.",
  ];
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs
      .map(
        (paragraph) =>
          `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`,
      )
      .join("\n")}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder("_rels").file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder("word").file("document.xml", documentXml);
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function makeSolutionTxt(filePath) {
  await writeFile(
    filePath,
    [
      "Solution draft for Nordic Retail Logistics AS",
      "",
      "We propose a Microsoft-near cloud foundation using Azure landing zones, hub-spoke networking, Entra ID, MFA, RBAC, policy-as-code, centralized logging, backup, restore testing, and infrastructure-as-code.",
      "The target architecture separates development, test, and production and segments ERP, WMS, CRM, integration services, file workloads, and shared platform services.",
      "Migration starts with discovery and dependency mapping, then prioritizes workloads by business criticality, risk, and modernization fit: rehost, replatform, refactor, keep temporarily local, retire, or replace.",
      "Availability, RTO/RPO, cost frame, delivery dates, and binding service levels are proposed during planning because Bilag 1 does not state exact numeric values.",
      "Managed service transition covers monitoring, incident handling, vulnerability management, documentation, knowledge transfer, and continuous improvement.",
    ].join("\n"),
    "utf8",
  );
}

const fixture = {
  bilag1_path: bilag1Path,
  bilag1_title: "Bilag 1 - Skyløsning Fiktiv Kunde",
  customer_name: "Nordic Retail Logistics AS",
  industry: "Lagerdrift, transportkoordinering og detaljhandelsdistribusjon",
  description:
    "Automated LLM-as-judge quality evaluation project using the user's Bilag 1 skylosning fixture.",
};

const customerPdf = fixture.bilag1_path;
const supportingDocx = path.join(fixtureDir, "word_requirements_appendix.docx");
const solutionTxt = path.join(fixtureDir, "solution_draft.txt");
const serviceTxt = path.join(fixtureDir, "service_description.txt");
await makeDocx(supportingDocx);
await makeSolutionTxt(solutionTxt);
await writeFile(
  serviceTxt,
  "Service: Cloud platform modernization and managed operations\nMicrosoft-near landing zones, Entra ID, MFA/RBAC, network segmentation, policy-as-code, backup/restore, monitoring, FinOps, vulnerability management, migration planning, and managed operations.\n",
  "utf8",
);

function contentTypeFor(filePath) {
  if (filePath.endsWith(".pdf")) return "application/pdf";
  if (filePath.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (filePath.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

async function fileForm(filePath, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  const bytes = await readFile(filePath);
  form.append(
    "file",
    new Blob([bytes], { type: contentTypeFor(filePath) }),
    path.basename(filePath),
  );
  return form;
}

function flattenText(value) {
  if (value === null || typeof value === "undefined") return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenText).join("\n");
  if (typeof value === "object") return Object.values(value).map(flattenText).join("\n");
  return "";
}

function compactText(value, maxChars) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.floor(maxChars * 0.65))}\n...[truncated]...\n${normalized.slice(-Math.floor(maxChars * 0.35))}`;
}

function factScore(text) {
  const normalized = text.toLowerCase();
  const checks = [
    ["customer", /nordic retail|logistics|lager|transport|distribusjon/.test(normalized)],
    ["workloads", /erp|wms|crm|integrasjon|filserver|active directory|microsoft 365/.test(normalized)],
    ["platform", /skyplattform|landing zone|identitet|nettverk|segmentering|dev|test|produksjon/.test(normalized)],
    ["security", /mfa|flerfaktor|rbac|rollebasert|logging|sporbarhet|herding|sårbarhet|governance/.test(normalized)],
    ["migration", /rehost|replatform|refaktor|migrering|utfas|erstatt|midlertidig lokalt/.test(normalized)],
    ["operations", /overvåkning|hendelseshåndtering|forvaltning|driftsmodell|proaktiv|kontinuerlig forbedring/.test(normalized)],
    ["continuity", /høy tilgjengelighet|begrenset nedetid|backup|gjenoppretting|tjenestenivå|sla/.test(normalized)],
    ["clarification", /ikke oppgitt|avklaring|rto|rpo|budsjett|frist|forutsetning/.test(normalized)],
  ];
  const hits = checks.filter(([, ok]) => ok).map(([name]) => name);
  return { hits, total: checks.length, score: hits.length / checks.length };
}

async function waitForJob(client, projectId, job, kind) {
  const started = performance.now();
  let latest = job;
  for (;;) {
    const { payload } = await client.json(
      "GET",
      `/api/projects/${projectId}/jobs/${job.id}`,
    );
    latest = payload.job;
    if (latest.status === "failed") {
      throw new Error(`${kind} failed: ${latest.error ?? "unknown"}`);
    }
    if (latest.status === "completed") {
      return {
        job: latest,
        durationMs: Math.round(performance.now() - started),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function runJob(client, projectId, body, kind) {
  const { payload, elapsedMs } = await client.json(
    "POST",
    `/api/projects/${projectId}/jobs`,
    body,
  );
  const completed = await waitForJob(client, projectId, payload.job, kind);
  return { post_ms: elapsedMs, ...completed };
}

async function uploadDocument(client, projectId, filePath, fields) {
  const form = await fileForm(filePath, fields);
  const started = performance.now();
  const { response } = await client.request(
    "POST",
    `/api/projects/${projectId}/documents`,
    { body: form },
  );
  const payload = await response.json();
  const uploadMs = Math.round(performance.now() - started);
  if (!response.ok) {
    throw new Error(
      `upload ${path.basename(filePath)} failed ${response.status}: ${
        payload.error ?? "unknown"
      }`,
    );
  }
  let ingest = null;
  if (payload.job) {
    ingest = await waitForJob(
      client,
      projectId,
      payload.job,
      `document_ingestion:${path.basename(filePath)}`,
    );
  }
  return {
    document: payload.document,
    upload_ms: uploadMs,
    ingest_ms: ingest?.durationMs ?? 0,
    job: ingest?.job ?? null,
    final_document: ingest?.job?.result?.document ?? payload.document,
  };
}

async function postChat(client, projectId, message) {
  const started = performance.now();
  const { response } = await client.request("POST", `/api/projects/${projectId}/chat`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, session_title: "LLM quality eval" }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`chat failed ${response.status}: ${text}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstChunkMs = null;
  let answer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstChunkMs === null) firstChunkMs = Math.round(performance.now() - started);
    answer += decoder.decode(value, { stream: true });
  }
  answer += decoder.decode();
  return {
    duration_ms: Math.round(performance.now() - started),
    first_chunk_ms: firstChunkMs,
    answer,
    quality: factScore(answer),
  };
}

function outputForJob(kind, result) {
  if (!result) return "";
  if (kind === "customer_analysis") return JSON.stringify(result.analysis ?? result, null, 2);
  if (kind === "high_level_design") {
    const analysis = result.analysis ?? result;
    return JSON.stringify(
      {
        high_level_solution_design: analysis.high_level_solution_design,
        high_level_architecture_mermaid: analysis.high_level_architecture_mermaid,
      },
      null,
      2,
    );
  }
  if (kind === "artifact_generation:forbedret_kravsvar") {
    return [
      result.artifact?.title ?? "",
      result.artifact?.content_markdown ?? flattenText(result),
    ].join("\n\n");
  }
  if (kind === "solution_evaluation") {
    return JSON.stringify(result.evaluation ?? result, null, 2);
  }
  if (kind === "executive_summary") {
    return JSON.stringify(result.executive_summary ?? result, null, 2);
  }
  if (kind === "perfect_system_solution") {
    return [
      result.artifact?.title ?? "",
      result.artifact?.content_markdown ?? "",
    ].join("\n\n");
  }
  return flattenText(result);
}

async function runScenario(label, baseUrl) {
  const client = new Client(baseUrl);
  const result = {
    label,
    baseUrl,
    started_at: new Date().toISOString(),
    total_duration_ms: null,
    project_id: null,
    uploads: [],
    jobs: [],
    outputs: {},
    cleanup: [],
    errors: [],
    task_errors: [],
  };
  const scenarioStartedAt = Date.now();
  let projectId = null;
  let serviceId = null;

  try {
    await client.json("GET", "/api/health");
    await client.json("POST", "/api/auth/login", { password });
    const created = await client.json("POST", "/api/projects", {
      name: `LLM kvalitets-eval ${label} ${runId}`,
      customer_name: fixture.customer_name,
      description: fixture.description,
      industry: fixture.industry,
      selected_service_ids: [],
    });
    projectId = created.payload.id;
    result.project_id = projectId;

    result.uploads.push(
      await uploadDocument(client, projectId, customerPdf, {
        title: fixture.bilag1_title,
        role: "primary_customer_document",
      }),
    );
    result.uploads.push(
      await uploadDocument(client, projectId, supportingDocx, {
        title: "Støttenotat krav og avklaringer",
        role: "supporting_document",
        supporting_subtype: "kravdokument",
      }),
    );
    result.uploads.push(
      await uploadDocument(client, projectId, solutionTxt, {
        title: "Solution draft",
        role: "primary_solution_document",
      }),
    );

    const serviceForm = await fileForm(serviceTxt, {
      name: `LLM eval service ${label} ${runId}`,
      description: "Temporary service description for LLM-as-judge evaluation.",
      title: "Hybrid cloud service description",
    });
    const serviceCreated = await client.request("POST", "/api/service-descriptions", {
      body: serviceForm,
    });
    const servicePayload = await serviceCreated.response.json();
    if (!serviceCreated.response.ok) {
      throw new Error(
        `service description failed ${serviceCreated.response.status}: ${
          servicePayload.error ?? "unknown"
        }`,
      );
    }
    serviceId = servicePayload.service?.id ?? null;

    const jobBodies = [
      { kind: "customer_analysis" },
      { kind: "high_level_design" },
      {
        kind: "artifact_generation",
        artifact_type: "forbedret_kravsvar",
        source_document_ids: [result.uploads[0]?.final_document?.id].filter(Boolean),
        instructions:
          "Lag et kort, presist forbedret kravsvar. Behold kildehenvisninger.",
      },
      {
        kind: "solution_evaluation",
        solution_document_id: result.uploads[2]?.final_document?.id,
      },
      { kind: "executive_summary" },
      { kind: "perfect_system_solution" },
    ];

    for (const body of jobBodies) {
      const kind =
        body.kind === "artifact_generation"
          ? `${body.kind}:${body.artifact_type}`
          : body.kind;
      const started = performance.now();
      try {
        const jobRun = await runJob(client, projectId, body, kind);
        const output = outputForJob(kind, jobRun.job.result);
        result.jobs.push({
          kind,
          duration_ms: jobRun.durationMs,
          post_ms: jobRun.post_ms,
          quality: factScore(output),
          text_chars: output.length,
        });
        result.outputs[kind] = output;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const output = `JOB_FAILED: ${message}`;
        result.task_errors.push({ kind, error: message });
        result.jobs.push({
          kind,
          duration_ms: Math.round(performance.now() - started),
          post_ms: null,
          quality: factScore(output),
          text_chars: output.length,
          error: message,
        });
        result.outputs[kind] = output;
      }
    }

    try {
      const chat = await postChat(
        client,
        projectId,
        "Hva er de viktigste kravene til tilgjengelighet/nedetid, sikkerhet, migrering, drift, dokumentasjon og avklaringer? Ta også med om RTO/RPO, budsjett eller frister faktisk er oppgitt. Svar med kilder hvis mulig.",
      );
      result.jobs.push({
        kind: "chat",
        duration_ms: chat.duration_ms,
        first_chunk_ms: chat.first_chunk_ms,
        quality: chat.quality,
        text_chars: chat.answer.length,
      });
      result.outputs.chat = chat.answer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const output = `JOB_FAILED: ${message}`;
      result.task_errors.push({ kind: "chat", error: message });
      result.jobs.push({
        kind: "chat",
        duration_ms: 0,
        first_chunk_ms: null,
        quality: factScore(output),
        text_chars: output.length,
        error: message,
      });
      result.outputs.chat = output;
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (serviceId) {
      try {
        const deletedService = await client.request(
          "DELETE",
          `/api/service-descriptions/${serviceId}`,
        );
        result.cleanup.push({
          target: "service",
          id: serviceId,
          status: deletedService.response.status,
        });
      } catch (error) {
        result.cleanup.push({ target: "service", id: serviceId, error: String(error) });
      }
    }
    if (projectId) {
      try {
        const deletedProject = await client.request("DELETE", `/api/projects/${projectId}`);
        result.cleanup.push({
          target: "project",
          id: projectId,
          status: deletedProject.response.status,
        });
      } catch (error) {
        result.cleanup.push({ target: "project", id: projectId, error: String(error) });
      }
    }
    result.finished_at = new Date().toISOString();
    result.total_duration_ms = Date.now() - scenarioStartedAt;
  }

  if (result.errors.length) {
    throw new Error(`${label} scenario failed: ${result.errors.join("; ")}`);
  }

  return result;
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Judge returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

async function callJudge(messages) {
  let lastError = null;
  for (let attempt = 1; attempt <= judgeRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), judgeTimeoutMs);
    let response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAiApiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: judgeModel,
          reasoning_effort: "medium",
          response_format: { type: "json_object" },
          messages,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        return payload.choices?.[0]?.message?.content ?? "{}";
      }
      lastError = new Error(
        `Judge API failed ${response.status}: ${
          payload.error?.message ?? JSON.stringify(payload).slice(0, 500)
        }`,
      );
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) {
        throw lastError;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= judgeRetries) {
        throw lastError;
      }
    } finally {
      clearTimeout(timeout);
    }
    await sleep(1000 * attempt);
  }
  throw lastError ?? new Error("Judge API failed without details.");
}

function mapBlindReason(reason, currentIsA) {
  const aLabel = currentIsA ? "current" : "main";
  const bLabel = currentIsA ? "main" : "current";
  return String(reason ?? "")
    .replace(/\bKandidat A\b/g, aLabel)
    .replace(/\bKandidat B\b/g, bLabel)
    .replace(/\bCandidate A\b/g, aLabel)
    .replace(/\bCandidate B\b/g, bLabel)
    .replace(/\bA\b/g, aLabel)
    .replace(/\bB\b/g, bLabel);
}

async function judgeTask(task, currentOutput, mainOutput, roundIndex) {
  const currentIsA = hashString(`${task.key}:${roundIndex}`) % 2 === 0;
  const candidateA = currentIsA ? currentOutput : mainOutput;
  const candidateB = currentIsA ? mainOutput : currentOutput;
  const started = Date.now();
  const content = await callJudge([
      {
        role: "system",
        content: [
          "Du er en streng, nøktern evaluator for norske tilbuds- og RAG-systemer.",
          "Du vurderer to anonyme kandidatsvar blindt mot samme oppgave og fasit.",
          "Ikke belønn lengde i seg selv. Belønn presisjon, dokumentert dekning, konkret kundetilpasning og lav hallucination-risiko.",
          "Gi lave scorer for generiske påstander, manglende fakta, svak struktur eller påstander som ikke støttes av fasiten.",
          "Returner kun gyldig JSON.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Oppgave: ${task.label}`,
          `Forventning: ${task.expectation}`,
          "",
          "Fasit/kjente nøkkelfakta:",
          ...GROUND_TRUTH.map((item) => `- ${item}`),
          "",
          "Rubric: Gi hver kandidat 0-5 på hvert kriterium:",
          "1. factual_coverage: dekker kjente fakta og krav.",
          "2. groundedness: tydelig skille mellom dokumenterte fakta, antakelser og avklaringer.",
          "3. specificity: konkret, kundetilpasset og operasjonelt nyttig.",
          "4. completeness: dekker oppgavens forventede deler uten store hull.",
          "5. structure: lett å bruke videre i tilbudsarbeid.",
          "6. risk_control: lav hallucination-risiko og håndterer usikkerhet riktig.",
          "7. language: profesjonelt norsk og presist språk.",
          "",
          "Returner JSON med formen:",
          JSON.stringify(
            {
              candidate_a: {
                scores: {
                  factual_coverage: 0,
                  groundedness: 0,
                  specificity: 0,
                  completeness: 0,
                  structure: 0,
                  risk_control: 0,
                  language: 0,
                },
                total_100: 0,
                strengths: [],
                weaknesses: [],
                missing_or_unsupported: [],
              },
              candidate_b: {
                scores: {
                  factual_coverage: 0,
                  groundedness: 0,
                  specificity: 0,
                  completeness: 0,
                  structure: 0,
                  risk_control: 0,
                  language: 0,
                },
                total_100: 0,
                strengths: [],
                weaknesses: [],
                missing_or_unsupported: [],
              },
              winner: "A|B|tie",
              confidence: "low|medium|high",
              short_reason: "",
            },
            null,
            2,
          ),
          "",
          "Kandidat A:",
          compactText(candidateA, 18_000),
          "",
          "Kandidat B:",
          compactText(candidateB, 18_000),
        ].join("\n"),
      },
  ]);
  const parsed = parseJson(content);
  const mapped = currentIsA
    ? {
        current: parsed.candidate_a,
        main: parsed.candidate_b,
        winner:
          parsed.winner === "A"
            ? "current"
            : parsed.winner === "B"
              ? "main"
              : "tie",
      }
    : {
        current: parsed.candidate_b,
        main: parsed.candidate_a,
        winner:
          parsed.winner === "A"
            ? "main"
            : parsed.winner === "B"
              ? "current"
              : "tie",
      };

  return {
    key: task.key,
    label: task.label,
    round: roundIndex,
    judge_model: judgeModel,
    judge_duration_ms: Date.now() - started,
    blind_mapping: currentIsA ? "current=A, main=B" : "current=B, main=A",
    current: mapped.current,
    main: mapped.main,
    winner: mapped.winner,
    confidence: parsed.confidence,
    short_reason: mapBlindReason(parsed.short_reason, currentIsA),
    blind_short_reason: parsed.short_reason,
  };
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function standardDeviation(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return 0;
  const avg = average(finite);
  const variance = average(finite.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function percentile(values, percentileValue) {
  const finite = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!finite.length) return 0;
  const index = Math.min(
    finite.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * finite.length) - 1),
  );
  return finite[index];
}

function completedRounds(report) {
  return (report.rounds ?? []).filter((round) => round.current && round.main);
}

function allJudgments(report) {
  return completedRounds(report).flatMap((round) => round.judgments ?? []);
}

function allJobs(report, label) {
  return completedRounds(report).flatMap((round) => round[label]?.jobs ?? []);
}

function allTaskErrors(report, label) {
  return completedRounds(report).flatMap((round) =>
    (round[label]?.task_errors ?? []).map((error) => ({
      round: round.round,
      ...error,
    })),
  );
}

function taskErrorKinds(round, label) {
  return new Set((round[label]?.task_errors ?? []).map((error) => error.kind));
}

function comparableSuccessfulJobTotals(report) {
  return completedRounds(report)
    .map((round) => {
      const currentErrors = taskErrorKinds(round, "current");
      const mainErrors = taskErrorKinds(round, "main");
      const currentByKind = new Map(
        (round.current?.jobs ?? []).map((job) => [job.kind, job]),
      );
      const mainByKind = new Map(
        (round.main?.jobs ?? []).map((job) => [job.kind, job]),
      );
      const kinds = [];
      let currentTotal = 0;
      let mainTotal = 0;

      for (const task of TASKS) {
        const currentJob = currentByKind.get(task.key);
        const mainJob = mainByKind.get(task.key);
        if (
          !currentJob ||
          !mainJob ||
          currentJob.error ||
          mainJob.error ||
          currentErrors.has(task.key) ||
          mainErrors.has(task.key) ||
          !Number.isFinite(currentJob.duration_ms) ||
          !Number.isFinite(mainJob.duration_ms)
        ) {
          continue;
        }

        kinds.push(task.key);
        currentTotal += currentJob.duration_ms;
        mainTotal += mainJob.duration_ms;
      }

      return {
        round: round.round,
        kinds,
        current_total_ms: currentTotal,
        main_total_ms: mainTotal,
      };
    })
    .filter((item) => item.kinds.length > 0);
}

function totalDurations(report, label) {
  return completedRounds(report)
    .map((round) => round[label]?.total_duration_ms)
    .filter((value) => Number.isFinite(value));
}

function summarize(report) {
  const roundsCompleted = completedRounds(report);
  const judgments = allJudgments(report);
  const currentJudgeAvg = average(
    judgments.map((item) => Number(item.current?.total_100)),
  );
  const mainJudgeAvg = average(
    judgments.map((item) => Number(item.main?.total_100)),
  );
  const currentJobs = allJobs(report, "current");
  const mainJobs = allJobs(report, "main");
  const currentFactAvg = average(currentJobs.map((job) => job.quality.score));
  const mainFactAvg = average(mainJobs.map((job) => job.quality.score));
  const currentTotals = totalDurations(report, "current");
  const mainTotals = totalDurations(report, "main");
  const comparableSpeedTotals = comparableSuccessfulJobTotals(report);
  const currentComparableTotals = comparableSpeedTotals.map(
    (item) => item.current_total_ms,
  );
  const mainComparableTotals = comparableSpeedTotals.map(
    (item) => item.main_total_ms,
  );
  const currentJobDurations = currentJobs.map((job) => job.duration_ms);
  const mainJobDurations = mainJobs.map((job) => job.duration_ms);
  const currentScores = judgments.map((item) => Number(item.current?.total_100));
  const mainScores = judgments.map((item) => Number(item.main?.total_100));
  const currentStddev = standardDeviation(currentScores);
  const mainStddev = standardDeviation(mainScores);
  const wins = judgments.filter((item) => item.winner === "current").length;
  const losses = judgments.filter((item) => item.winner === "main").length;
  const ties = judgments.filter((item) => item.winner === "tie").length;
  const currentTaskErrors = allTaskErrors(report, "current");
  const mainTaskErrors = allTaskErrors(report, "main");
  const externalErrorPattern =
    /fetch failed|connection error|enotfound|econnreset|econnrefused|abort|timeout/i;
  const externalTaskErrors = [...currentTaskErrors, ...mainTaskErrors].filter((item) =>
    externalErrorPattern.test(item.error ?? ""),
  );
  const speedDeltaPct =
    average(currentTotals) && average(mainTotals)
      ? (average(currentTotals) / average(mainTotals) - 1) * 100
      : 0;
  const comparableSpeedDeltaPct =
    average(currentComparableTotals) && average(mainComparableTotals)
      ? (average(currentComparableTotals) / average(mainComparableTotals) - 1) *
        100
      : speedDeltaPct;
  const betterThanMain =
    roundsCompleted.length > 0 &&
    currentJudgeAvg > mainJudgeAvg &&
    wins >= losses &&
    currentFactAvg >= mainFactAvg;
  const speedNotRegressed = comparableSpeedDeltaPct <= 5;
  const stableEnough = currentStddev <= mainStddev + 5;
  const currentTaskErrorFree = currentTaskErrors.length === 0;
  const externalTaskErrorFree = externalTaskErrors.length === 0;

  return {
    rounds: {
      requested: report.rounds_requested,
      completed: roundsCompleted.length,
    },
    speed: {
      current_avg_total_ms: average(currentTotals),
      main_avg_total_ms: average(mainTotals),
      delta_avg_total_ms: average(currentTotals) - average(mainTotals),
      delta_pct_avg: speedDeltaPct,
      current_avg_comparable_success_ms: average(currentComparableTotals),
      main_avg_comparable_success_ms: average(mainComparableTotals),
      delta_pct_comparable_success: comparableSpeedDeltaPct,
      comparable_success_rounds: comparableSpeedTotals.map((item) => ({
        round: item.round,
        task_count: item.kinds.length,
        tasks: item.kinds,
      })),
      current_p50_job_ms: percentile(currentJobDurations, 50),
      main_p50_job_ms: percentile(mainJobDurations, 50),
      current_p95_job_ms: percentile(currentJobDurations, 95),
      main_p95_job_ms: percentile(mainJobDurations, 95),
    },
    llm_quality: {
      current_average_100: currentJudgeAvg,
      main_average_100: mainJudgeAvg,
      delta_points: currentJudgeAvg - mainJudgeAvg,
      current_stddev: currentStddev,
      main_stddev: mainStddev,
      wins,
      losses,
      ties,
    },
    fact_coverage: {
      current_average: currentFactAvg,
      main_average: mainFactAvg,
      delta: currentFactAvg - mainFactAvg,
    },
    reliability: {
      current_task_errors: currentTaskErrors,
      main_task_errors: mainTaskErrors,
      external_task_errors: externalTaskErrors,
    },
    quality_gate: {
      better_than_main: betterThanMain,
      speed_not_regressed: speedNotRegressed,
      stable_enough: stableEnough,
      current_task_error_free: currentTaskErrorFree,
      external_task_error_free: externalTaskErrorFree,
      passed:
        betterThanMain &&
        speedNotRegressed &&
        stableEnough &&
        currentTaskErrorFree &&
        externalTaskErrorFree,
      criteria:
        "Pass krever høyere judge-snitt enn main, minst like mange wins som losses, minst lik fact coverage, <=5% gjennomsnittlig hastighetsregresjon på sammenlignbare vellykkede oppgaver, current stddev maks 5 poeng over main, ingen current task-feil og ingen eksterne fetch/connection-feil i sammenligningen. Total kjøretid rapporteres separat fordi main-feil kan stoppe en oppgave tidlig.",
    },
    by_task: TASKS.map((task) => {
      const taskJudgments = judgments.filter((item) => item.key === task.key);
      const currentScores = taskJudgments.map((item) =>
        Number(item.current?.total_100),
      );
      const mainScores = taskJudgments.map((item) =>
        Number(item.main?.total_100),
      );
      return {
        key: task.key,
        label: task.label,
        current_average_100: average(currentScores),
        main_average_100: average(mainScores),
        delta_points: average(currentScores) - average(mainScores),
        current_stddev: standardDeviation(currentScores),
        main_stddev: standardDeviation(mainScores),
        wins: taskJudgments.filter((item) => item.winner === "current").length,
        losses: taskJudgments.filter((item) => item.winner === "main").length,
        ties: taskJudgments.filter((item) => item.winner === "tie").length,
      };
    }),
  };
}

const report = {
  run_id: runId,
  started_at: new Date(startedAt).toISOString(),
  judge_model: judgeModel,
  rounds_requested: rounds,
  fixture,
  ground_truth: GROUND_TRUTH,
  current: null,
  main: null,
  rounds: [],
  judgments: [],
  summary: null,
};

for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
  const roundReport = {
    round: roundIndex,
    current: null,
    main: null,
    judgments: [],
  };
  report.rounds.push(roundReport);

  roundReport.current = await runScenario(`current-r${roundIndex}`, currentBase);
  report.current = roundReport.current;
  await writeFile(outPath, JSON.stringify(report, null, 2));

  roundReport.main = await runScenario(`main-r${roundIndex}`, mainBase);
  report.main = roundReport.main;
  await writeFile(outPath, JSON.stringify(report, null, 2));

  for (const task of TASKS) {
    const judgment = await judgeTask(
      task,
      roundReport.current.outputs[task.key] ?? "",
      roundReport.main.outputs[task.key] ?? "",
      roundIndex,
    );
    roundReport.judgments.push(judgment);
    report.judgments = allJudgments(report);
    report.summary = summarize(report);
    await writeFile(outPath, JSON.stringify(report, null, 2));
  }

  report.judgments = allJudgments(report);
  report.summary = summarize(report);
  await writeFile(outPath, JSON.stringify(report, null, 2));
}

report.finished_at = new Date().toISOString();
report.total_duration_ms = Date.now() - startedAt;
report.judgments = allJudgments(report);
report.summary = summarize(report);
await writeFile(outPath, JSON.stringify(report, null, 2));

console.log(
  JSON.stringify(
    {
      outPath,
      summary: report.summary,
      judgments: report.judgments.map((item) => ({
        round: item.round,
        key: item.key,
        winner: item.winner,
        current: item.current?.total_100,
        main: item.main?.total_100,
        confidence: item.confidence,
      })),
    },
    null,
    2,
  ),
);
