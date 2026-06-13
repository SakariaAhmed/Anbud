#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { resolveExistingFixturePath } from "./fixture_paths.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");
const smokeRoot = path.join(repoRoot, "test-data", "requirement-generation-smoke");
const outputRoot = path.join(repoRoot, "test-data", "evaluation-smoke");

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "").trim();
  }
}

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(frontendRoot, ".env.local"));

const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "evaluation-smoke.cjs"), {
  moduleCache: false,
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  extractTextFromBuffer,
  contentTypeForUploadFormat,
  inferUploadFileFormat,
} = jiti(path.join(frontendRoot, "lib", "server", "documents.ts"));
const {
  evaluateSolutionDocument,
  extractRequirementLedgerForDocument,
} = jiti(path.join(frontendRoot, "lib", "server", "ai.ts"));

const PROJECTS = [
  {
    id: "01",
    name: "Nordlys Logistikk AS",
    customer: "sky_bilag_5_par_ny/01_Bilag_1_Nordlys_Logistikk_AS.docx",
    requirements: "sky_bilag_5_par_ny/01_Bilag_2_Krav_Nordlys_Logistikk_AS.docx",
  },
  {
    id: "02",
    name: "HelseBro Klinikkdrift AS",
    customer: "sky_bilag_5_par_ny/02_Bilag_1_HelseBro_Klinikkdrift_AS.docx",
    requirements: "sky_bilag_5_par_ny/02_Bilag_2_Krav_HelseBro_Klinikkdrift_AS.docx",
  },
  {
    id: "03",
    name: "GrønnFjord Energi SA",
    customer: "sky_bilag_5_par_ny/03_Bilag_1_Gr_nnFjord_Energi_SA.docx",
    requirements: "sky_bilag_5_par_ny/03_Bilag_2_Krav_Gr_nnFjord_Energi_SA.docx",
  },
  {
    id: "04",
    name: "KulturHub Østlandet IKS",
    customer: "sky_bilag_5_par_ny/04_Bilag_1_KulturHub_stlandet_IKS.docx",
    requirements: "sky_bilag_5_par_ny/04_Bilag_2_Krav_KulturHub_stlandet_IKS.docx",
  },
  {
    id: "05",
    name: "TryggVakt Bemanning AS",
    customer: "sky_bilag_5_par_ny/05_Bilag_1_TryggVakt_Bemanning_AS.docx",
    requirements: "sky_bilag_5_par_ny/05_Bilag_2_Krav_TryggVakt_Bemanning_AS.docx",
  },
  {
    id: "11",
    name: "PolarNett Feltservice AS",
    customer: "sky_10_unike_ustrukturerte_prosjekter/DOCX/11_Bilag_1_PolarNett_Feltservice_AS.docx",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/DOCX/11_Bilag_2_Krav_PolarNett_Feltservice_AS.docx",
  },
  {
    id: "12",
    name: "Matrett Direkte AS",
    customer: "sky_10_unike_ustrukturerte_prosjekter/DOCX/12_Bilag_1_Matrett_Direkte_AS.docx",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/DOCX/12_Bilag_2_Krav_Matrett_Direkte_AS.docx",
  },
  {
    id: "13",
    name: "ArenaPulse Eventdrift AS",
    customer: "sky_10_unike_ustrukturerte_prosjekter/DOCX/13_Bilag_1_ArenaPulse_Eventdrift_AS.docx",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/DOCX/13_Bilag_2_Krav_ArenaPulse_Eventdrift_AS.docx",
  },
  {
    id: "14",
    name: "TreLinje Modulbygg AS",
    customer: "sky_10_unike_ustrukturerte_prosjekter/DOCX/14_Bilag_1_TreLinje_Modulbygg_AS.docx",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/DOCX/14_Bilag_2_Krav_TreLinje_Modulbygg_AS.docx",
  },
  {
    id: "15",
    name: "OmsorgLink Hjemmetjeneste KF",
    customer: "sky_10_unike_ustrukturerte_prosjekter/DOCX/15_Bilag_1_OmsorgLink_Hjemmetjeneste_KF.docx",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/DOCX/15_Bilag_2_Krav_OmsorgLink_Hjemmetjeneste_KF.docx",
  },
  {
    id: "16",
    name: "FjordByte Regnskap AS",
    customer: "sky_10_unike_ustrukturerte_prosjekter/PDF/16_Bilag_1_FjordByte_Regnskap_AS.pdf",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/PDF/16_Bilag_2_Krav_FjordByte_Regnskap_AS.pdf",
  },
  {
    id: "17",
    name: "NordVask Industrirens AS",
    customer: "sky_10_unike_ustrukturerte_prosjekter/PDF/17_Bilag_1_NordVask_Industrirens_AS.pdf",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/PDF/17_Bilag_2_Krav_NordVask_Industrirens_AS.pdf",
  },
  {
    id: "18",
    name: "BySykkel Verksteddrift AS",
    customer: "sky_10_unike_ustrukturerte_prosjekter/PDF/18_Bilag_1_BySykkel_Verksteddrift_AS.pdf",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/PDF/18_Bilag_2_Krav_BySykkel_Verksteddrift_AS.pdf",
  },
  {
    id: "19",
    name: "SkoleMat Pluss SA",
    customer: "sky_10_unike_ustrukturerte_prosjekter/PDF/19_Bilag_1_SkoleMat_Pluss_SA.pdf",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/PDF/19_Bilag_2_Krav_SkoleMat_Pluss_SA.pdf",
  },
  {
    id: "20",
    name: "HavnKontroll Terminaldrift IKS",
    customer: "sky_10_unike_ustrukturerte_prosjekter/PDF/20_Bilag_1_HavnKontroll_Terminaldrift_IKS.pdf",
    requirements: "sky_10_unike_ustrukturerte_prosjekter/PDF/20_Bilag_2_Krav_HavnKontroll_Terminaldrift_IKS.pdf",
  },
];

function resolveFixturePath(relativePath) {
  const filePath = resolveExistingFixturePath(relativePath);
  if (!filePath) {
    throw new Error(
      `Fant ikke fixture ${relativePath}. Sett REQUIREMENT_VERIFY_FIXTURE_ROOT til katalogen som inneholder testkorpuset.`,
    );
  }

  return filePath;
}

function resolveProjectFixturePaths(project) {
  return {
    ...project,
    customer: resolveFixturePath(project.customer),
    requirements: resolveFixturePath(project.requirements),
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const onlyIndex = args.indexOf("--only");
  const idsIndex = args.indexOf("--ids");
  const modelIndex = args.indexOf("--model");

  return {
    limit:
      limitIndex >= 0 && args[limitIndex + 1]
        ? Math.max(1, Number(args[limitIndex + 1]))
        : PROJECTS.length,
    only: onlyIndex >= 0 ? args[onlyIndex + 1] : "",
    ids:
      idsIndex >= 0 && args[idsIndex + 1]
        ? new Set(args[idsIndex + 1].split(",").map((id) => id.trim()).filter(Boolean))
        : null,
    model: modelIndex >= 0 ? args[modelIndex + 1] : undefined,
  };
}

function projectDocumentDetailFromParsed({
  filePath,
  parsed,
  buffer,
  projectId,
  role,
  supportingSubtype = null,
}) {
  const now = new Date(0).toISOString();
  const fileName = path.basename(filePath);

  return {
    id: `${projectId}-${fileName}`,
    project_id: projectId,
    role,
    supporting_subtype: supportingSubtype,
    title: fileName,
    file_name: fileName,
    file_format: parsed.fileFormat,
    content_type: parsed.contentType,
    file_size_bytes: buffer.length,
    page_count: null,
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: parsed.parserUsed,
    indexed_at: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: now,
    updated_at: now,
    raw_text: parsed.rawText,
    file_base64: parsed.fileBase64,
    structure_map: parsed.sourceMap,
  };
}

async function loadProjectDocument({ filePath, projectId, role, supportingSubtype }) {
  const buffer = await readFile(filePath);
  const fileName = path.basename(filePath);
  const fileFormat = inferUploadFileFormat({ fileName });
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName,
    contentType: contentTypeForUploadFormat(fileFormat),
    role,
    useDocling: false,
  });

  return projectDocumentDetailFromParsed({
    filePath,
    parsed,
    buffer,
    projectId,
    role,
    supportingSubtype,
  });
}

function markdownSolutionDocument({ projectId, project, markdown }) {
  const now = new Date(0).toISOString();
  const fileName = `${project.id}_generated_requirement_response.md`;

  return {
    id: `${projectId}-${fileName}`,
    project_id: projectId,
    role: "primary_solution_document",
    supporting_subtype: null,
    title: `Generert kravbesvarelse ${project.name}`,
    file_name: fileName,
    file_format: "md",
    content_type: "text/markdown",
    file_size_bytes: Buffer.byteLength(markdown),
    page_count: null,
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: "local-markdown",
    indexed_at: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: now,
    updated_at: now,
    raw_text: markdown,
    file_base64: Buffer.from(markdown, "utf8").toString("base64"),
    structure_map: [
      {
        reference: "Generert kravbesvarelse",
        text: markdown,
        kind: "text",
        parser: "local-markdown",
        page: 1,
      },
    ],
  };
}

function requirementLedgerContext({ document, ledger }) {
  const rows = ledger.map((entry, index) => {
    const source = [
      entry.pages?.length ? `Side ${entry.pages.join(",")}` : "",
      entry.heading,
      entry.tableId,
      entry.id,
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${index + 1}. ${entry.id} | ${source} | ${entry.text}`;
  });

  return [
    "### Presis kravledger for vurdering",
    "Bruk denne deterministiske kravledgeren som kontrolliste for kravdekning. Ikke legg til, fjern eller slå sammen krav.",
    `Dokument: ${document.title}`,
    `Krav funnet: ${ledger.length}`,
    ...rows,
  ].join("\n");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runOne(project, options) {
  const projectId = `local-evaluation-${project.id}`;
  const outDir = path.join(outputRoot, project.id);
  const smokeDir = path.join(smokeRoot, project.id);
  await mkdir(outDir, { recursive: true });

  const [customerDocument, requirementDocument, customerAnalysisRaw, responseMarkdown] =
    await Promise.all([
      loadProjectDocument({
        filePath: project.customer,
        projectId,
        role: "primary_customer_document",
      }),
      loadProjectDocument({
        filePath: project.requirements,
        projectId,
        role: "supporting_document",
        supportingSubtype: "kravdokument",
      }),
      readFile(path.join(smokeDir, "customer-analysis.json"), "utf8"),
      readFile(path.join(smokeDir, "requirement-response.md"), "utf8"),
    ]);
  const customerAnalysis = JSON.parse(customerAnalysisRaw);
  const ledger = await extractRequirementLedgerForDocument(requirementDocument);
  const solutionDocument = markdownSolutionDocument({
    projectId,
    project,
    markdown: responseMarkdown,
  });
  const solutionLedger = await extractRequirementLedgerForDocument(solutionDocument);

  console.log(`\n${project.id} ${project.name}`);
  console.log(`  kravledger: ${ledger.length} krav`);
  console.log(`  løsningsledger før vurdering: ${solutionLedger.length} krav`);

  const result = await evaluateSolutionDocument({
    projectName: project.name,
    customerDocument,
    solutionDocument,
    supportingDocuments: [requirementDocument],
    customerAnalysis,
    model: options.model,
    documentLedgerContext: requirementLedgerContext({
      document: requirementDocument,
      ledger,
    }),
    onProgress: (message) => console.log(`  ${message}`),
  });

  const coverage = result.requirement_coverage;
  const summary = {
    id: project.id,
    name: project.name,
    source_ledger_count: ledger.length,
    solution_ledger_count: solutionLedger.length,
    total_requirements: coverage?.total_requirements ?? 0,
    assessed_requirements: coverage?.assessed_requirements ?? 0,
    coverage_items: coverage?.items?.length ?? 0,
    good: coverage?.good ?? 0,
    weak: coverage?.weak ?? 0,
    missing: coverage?.missing ?? 0,
    unclear: coverage?.unclear ?? 0,
    ok:
      Boolean(coverage) &&
      coverage.total_requirements === ledger.length &&
      coverage.assessed_requirements === ledger.length &&
      coverage.items.length === ledger.length,
  };

  await writeJson(path.join(outDir, "solution-evaluation.json"), result);
  await writeJson(path.join(outDir, "summary.json"), summary);
  console.log(
    `  vurdering: ${summary.assessed_requirements}/${summary.source_ledger_count} vurdert, items=${summary.coverage_items}`,
  );

  return summary;
}

const options = parseArgs();
let projects = PROJECTS;
if (options.only) {
  projects = projects.filter((project) => project.id === options.only);
}
if (options.ids) {
  projects = projects.filter((project) => options.ids.has(project.id));
}
projects = projects.slice(0, options.limit).map(resolveProjectFixturePaths);

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY mangler. Legg nøkkelen i .env eller apps/frontend/.env.local.");
}

await mkdir(outputRoot, { recursive: true });
const results = [];

for (const project of projects) {
  results.push(await runOne(project, options));
}

await writeJson(path.join(outputRoot, "summary.json"), {
  generated_at: new Date().toISOString(),
  model: options.model ?? process.env.OPENAI_MODEL ?? null,
  results,
});

const passed = results.filter((result) => result.ok).length;
console.log(`\nTOTAL ${passed}/${results.length}`);
if (passed !== results.length) {
  process.exitCode = 1;
}
