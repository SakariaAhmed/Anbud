#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { File } from "node:buffer";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");

const defaultCorpus50Root =
  "/Users/sakariaahmed/Downloads/sky_50_unike_prosjekter_blandet";
const defaultCorpus100Root =
  "/Users/sakariaahmed/Downloads/sky_100_unike_prosjekter_blandet(1)";
const defaultRekkefolgeRoot =
  "/Users/sakariaahmed/Downloads/sky_100_prosjekter_rekkefolge_ekstraksjon";
const defaultPetoroRequirement =
  "/Users/sakariaahmed/Downloads/Kravdokument - Bilag 2 - Petoro";
const defaultPetoroCustomer = "/Users/sakariaahmed/Downloads/Bilag 1 - Petoro";
const defaultOutputPath = "/tmp/anbud-vurdering-api-full-251-results.json";
const defaultArtifactsRoot = "/tmp/anbud-vurdering-api-full-251";
const defaultServerLogPath = "/tmp/anbud-vurdering-api-full-251-server.log";
const defaultReportPath = path.join(
  repoRoot,
  "reports",
  "vurdering-answer-quality-report.html",
);
const HARNESS_REQUEST_TIMEOUT_MS = 120_000;
const HARNESS_DIRECT_EVALUATION_TIMEOUT_MS = 20 * 60_000;
const HARNESS_UPLOAD_TIMEOUT_MS = 180_000;
const HARNESS_PROJECT_TIMEOUT_MS = 45 * 60_000;
const HARNESS_CHECKPOINT_SCHEMA_VERSION = 8;
const DOCUMENT_STORAGE_BUCKET = "anbud-documents";
const STORAGE_LIST_PAGE_SIZE = 1_000;
const KNOWN_CORPORA = new Set([
  "50-folder",
  "100-folder",
  "rekkefolge-100",
  "Petoro",
]);
const RELEVANT_25_V1_PROFILE = Object.freeze({
  name: "relevant-25-v1",
  expectedSelected: 26,
  orderedProjectIds: Object.freeze([
    "100-folder-001",
    "100-folder-002",
    "100-folder-008",
    "100-folder-010",
    "100-folder-012",
    "100-folder-015",
    "100-folder-021",
    "100-folder-032",
    "100-folder-034",
    "100-folder-038",
    "100-folder-045",
    "100-folder-049",
    "100-folder-054",
    "100-folder-056",
    "100-folder-058",
    "100-folder-062",
    "100-folder-070",
    "100-folder-071",
    "100-folder-073",
    "100-folder-077",
    "100-folder-084",
    "100-folder-088",
    "100-folder-093",
    "100-folder-095",
    "100-folder-099",
    "petoro",
  ]),
  profileSha256:
    "646edc410b402f0fc14b3f9ee83527b382d328026b191089f376b05b864387bc",
  corpusFasitSha256:
    "01979213d1c6b3aa45eb78af4533f33b58331b92e19dc01a881719bd12c311f1",
  selectedSourceFilesSha256:
    "63d964933dd9848f4c916cd623089bb78e03c1449ad0ad7787c9f7b51f2a221a",
  petoroRequirementSha256:
    "5db6fff8eb52887361103b0ceade45916b6a3ffad76c5cba5d277d903fbf0d52",
  petoroCustomerSha256:
    "9da92696c90989c6c50778cc8a60f2a0ddda2465d7f7a2bb801ef196d5e86795",
});
const SELECTION_PROFILES = new Map([
  [RELEVANT_25_V1_PROFILE.name, RELEVANT_25_V1_PROFILE],
]);
const PETORO_GOLDEN_REQUIREMENT_IDS_V1 = [
  "ID 2-01",
  "ID 2-02",
  "ID 2-03",
  "ID 2-04",
  "ID 2-05",
  "ID 2-06",
  "ID 2-07",
  "ID 2-08",
  "ID 2-09",
  "ID 2-10",
  "Tabell ID 2-11 - Tilgang og tilgjengelighet",
  "Tabell ID 2-11 - Lisenshåndtering",
  "Tabell ID 2-11 - Overvåke",
  "Tabell ID 2-11 - Dokumentasjon",
  "Tabell ID 2-11 - Bruker-administrasjon",
  "Tabell ID 2-11 - Inventarkontroll",
  "Tabell ID 2-11 - Feilhåndtering",
  "Tabell ID 2-11 - Tredjeparts-leverandører",
  "Tabell ID 2-11 - Bistand ved revisjoner",
  "Tabell ID 2-12 - Gjennomgang av logger",
  "Tabell ID 2-12 - Proaktivt vedlikehold",
  "Tabell ID 2-12 - Sikkerhets- og servicepatcher",
  "Tabell ID 2-13 - Applikasjonsforvaltning",
  "Tabell ID 2-13 - Sikkerhets- og servicepatcher",
  "Tabell ID 2-13 - Feilretting",
  "Tabell ID 2-13 - Rapportering",
  "ID 2-14",
  "ID 2-15",
  "ID 2-16",
  "ID 2-17",
  "ID 2-18",
  "ID 2-19",
  "ID 2-20",
  "ID 2-21",
  "ID 2-22",
  "ID 2-23",
  "ID 2-24",
  "ID 2-25",
  "ID 2-26",
  "ID 2-27",
  "ID 2-28",
  "ID 2-29",
  "ID 2-30",
  "Tabell ID 2-31 - Ivareta",
  "Tabell ID 2-31 - Erfaring",
  "Tabell ID 2-31 - Sertifiseringer",
  "Tabell ID 2-31 - Rådgivning og utvikling",
  "Tabell ID 2-31 - Information Security Management System",
  "Tabell ID 2-31 - Revisjon",
  "Tabell ID 2-31 - Testing",
  "Tabell ID 2-31 - Risikostyring",
  "Tabell ID 2-31 - Sårbarhetshåndtering",
  "Tabell ID 2-31 - Dokumentasjon og rapportering (sikkerhetsrapporter)",
  "Tabell ID 2-31 - Roller og ansvar",
  "Tabell ID 2-31 - Uønskede hendelser",
  "Tabell ID 2-31 - Dokumentasjon og rapportering (inventaroversikt)",
  "Tabell ID 2-31 - Leverandørstyring",
  "Tabell ID 2-31 - Avslutning",
  "Tabell ID 2-31 - Sikker autentisering",
  "Tabell ID 2-31 - Privilegerte tilganger",
  "Tabell ID 2-31 - Passord policy",
  "Tabell ID 2-31 - Logging av administratorpålogging",
  "Tabell ID 2-31 - Kryptering",
  "Tabell ID 2-31 - Mobil sikkerhet og MDM",
  "Tabell ID 2-31 - Sikkerhetskopiering",
  "Tabell ID 2-31 - Endepunktsikkerhet",
  "Tabell ID 2-31 - Sårbarhetsskanning",
  "Tabell ID 2-31 - Øvelse",
  "Tabell ID 2-31 - Bakgrunnssjekk",
  "Tabell ID 2-31 - Sikker endringshåndtering",
  "Tabell ID 2-31 - Konfigurasjonsendringer",
  "Tabell ID 2-32 - Sikkerhetsovervåking",
  "Tabell ID 2-32 - Plattformer",
  "Tabell ID 2-32 - Varslingsrutiner ved kritiske funn og hendelser",
];
const PETORO_GOLDEN_ORACLE_VERSION =
  "petoro-manual-gold-v4-source-verified";
const PETORO_GOLDEN_TEXT_SHA256_V1 = [
  "99e48f39873df58a30ab35d4ee1f8e7faded3a9347c05dfb24a9902240843fe3",
  "646d0e1f32a6128f34c620cb1af35030658d41119a08f565071113d0e39e29f3",
  "3d53f053fe84e6390b206711719b411a0aea9ba6e01c8235ae586f3e57f060ab",
  "9d71f9d0db9518353b35b0ce0fdafcec5e3c4c2f752ad2bf1be0833a74b4cac6",
  "3f2f2757123ec765f8a156374f318a5dd9eefb4cee5d459d0c64f7354ff460a4",
  "ec192b6a1c5d87d18a64f8e68556760757a2fbbc361697bba19f9d2ad6b48d0b",
  "5275d8f7ec3697c4b86ee6eb68f6be29266236fc1b6a4c25261ee70bded8e9f0",
  "4bba5e15fcf55014f9f61487f10100696c27a93d50a47d831816303627de1a4b",
  "03f627fae650025870e8dbacc755332736de520c43c5bc3e4d7b9c688e42bce0",
  "9af279bf82c48c7c6b84dc505f0f9f0dc27f4ba5815a7504cb2e2a1ca463ecd7",
  "cdb59fa1fdd7b252d39c480e7c3b23a2092420f0e65f444e7cf7aecc7d3ecc3b",
  "427d92e8eecbf7beaacc2e064b59c404656abd3266765fa7dbd4439d7f5ff936",
  "bc7165deffa5014a081f4951421239f995b354be6457aec7b52fd3fc01767b64",
  "c4d657fa5f3e2039d83581fbd289ddbb1cc62fb3a51dd0cd4042d23dbf37397c",
  "7fc3661e064c7bf8adf4ff5b6d1980487fbf4919df6a579790095ab69036dd10",
  "ad8f73bb7d64b047d05b7107005fe4f3e918be827ac0b4be7ea5a732fb498e35",
  "3bdebbaa6dd08845de5316a3cf6ee004bb650957e9cbbc5faadd6a404cb9e721",
  "a84b851d82e16fa21db51de278ec4a934049136d72decb39995e9f5f04044dbd",
  "99e7082230f02beb8d65b6e49724614d89f22aa1d4c7895b518d1dd870787a14",
  "4182d470abf6d009d9a05ca40780a8411a4d01af463b206479e12180b8f4e75a",
  "e2c17eb865102091d5ba5bb06c9e2cd51805049be4e7b0fb4818ffa8513ae17b",
  "049a876a596f7c50d138ae1e8a60214eef31fdcb6608bfd6282b57e0e6d4c446",
  "30aa1f0c03ddae231d18a8fbacd1c55da71570d9ec4a52533a5dbd53b608527e",
  "a4ea8a639110a32264f2b361d33555aae64879a1ae99a1b12ebdad5232b2151e",
  "4023138ee1df15c5d9465de1343bdbf778b678b14bc267139117a2f3f5c1b590",
  "5fa4957bb0498fecd6bb36126c9d543dded59e423189604e4e0d4b7659e27303",
  "3bc86443bd711b93caa5ecd291ac7995ff19d3f0244646d1c7ceab1231b6a61d",
  "12532323e749be87af0300faf4a94cf6129119d7d07034bb0117405560ea3408",
  "6ad6fcca34c9fd7d346f0e24f7046fe221bcd8c6b9335f6da576291ce0dbc00e",
  "ebade8640b64bd92a07637cd429e3081674d076ce7fb13b31a4e02bf3a0d8dbc",
  "125ddf14ba2ddd4c60908614e2807eee8489408de109309bd2bfde6115b594ef",
  "0aa1c9c9f732cea24475af0a5234c88df3a5fbb292505667f82dce647585e592",
  "fab4dacbca5f442c72009c1f7fbea4a2ee5d4c9b112f9a6049587bc96b71c7ab",
  "50d1e2e54490ec12b1e844d50c39b512429f74f2759262ea595161fa26e5a96e",
  "d5b70705ec7e8beb55d283ee1876d3094a520b6dea5d290a9aeb660a2895f3a4",
  "0176e5be44648eca76cf06f0d25957628a4a960209989ec7f78ed795e4c4f02c",
  "77404c2e7f19930359c0a0989813ecee813ce4dbb083af067944817cd56730b5",
  "3e903f1a32730144d76e2927978a24033c402242cad08e2cc70e4085ce8802f5",
  "35addccd8674b799fb81d26210126360638c6b2b01ff562b8a64e0fae426aa80",
  "79d693b92e2f4ed19dd30cda9e422ec711efd1021946ae73cb795c4a59cdea64",
  "dcb3c6aeccf7a425078caa8f5fedf278770502c79b4440d04f0b95fab3b8ad04",
  "8b8fb9e1dbb419d1ee5d32f55707002abdb2661ea99305cabb09bd165916f04c",
  "5a979815b3e6b934f520b91159e0408ccb40f3a249a80c2fa3691029cb393edf",
  "569ca3ed00fbef80977e8e42d3798d8ad8ef55b0c1049617da64054483fbd535",
  "62094e30be4b0bf50e685b82cab6617e61c991cb48329d8be5078815a0fc6cbe",
  "ee01614052cc4b0af0666b2cedf03d84ef7ceef45bc6e0103a1ebc91b244477b",
  "ffc2fca14c0721f37f919eda3e7d234504ae7354be028bb89a3d044eb2b43096",
  "898d738abb56fe878622553116bd7ff1bf9ac8d36b711c579ded983babbd796a",
  "a3e17290cb1ce39dd19ecb52a9d4afd80f74a371b46494d1af07edcb44ba64b2",
  "bed93c6e36f9fa7311474303e47a42da54bb60124b8efb846d94b80cb54df824",
  "4c461ff2e42d8835cb6b89607c0f7213dcf61a33ff72305d1defe4264d5199a3",
  "6a4c540a52494424b8cf336c8d435f5ed04d6fbc2c15cbbe0c5025bba7d3fc41",
  "362e494b436f73cf9c2137a5b8c6536b2c34ebfa25729a42d9cb6e2696b955c7",
  "36a306b8d6aa0c41f67591dd442173acff6ae84273f2aab654f8ff8ab7050d38",
  "6f2c9c1d90ac90020b32b3e91016cd0744aa068c4d33a656e8cfe20f43a061c4",
  "d87d067b1f8e3c22798bfab01ad974651953cc26759301d902a39b96837b2d81",
  "272c2d67ba4082cc81d76e69e75b32eb33fa7b5f054dfc639ef203a08b5f10d2",
  "adfa0d836319fa2e63f7fcdef790efa20f2a86a58bb6ef4c37311cf053d498c8",
  "55ce84fdbed577c5f3b5d3ef96e4717eb54f0d28908d7d9a441546d91474f77a",
  "f4b71f272914fa26a92b617f6f7a3653e5a3f215c654c6592e08819ef9650a19",
  "dd310b086c81bc594a587efd5a256f6520fde23802d4d0c02d6c80555d127c4e",
  "6254047fb9451ca045153614bbf0b57402bfa85280b687f84cb4c9264c9fb38c",
  "6ce5ebf0af97c31d346e96ac6364bb524cb4c4aa113b6232bca8f8f876d7e930",
  "d56d12e993bdfe6e125a3348e33bccdf5e90aac50d79faa779861bd8294f7c0c",
  "c2c13f0af0c99c1ed58c6e4d0fb01eea9b5d43c01ee67f189a416383d437b01e",
  "463f6d2a263c498936ccaf0c83655bd95c4e858397b24dbbf2fe931ce587a53b",
  "689e01e603894c58a23c043d33121163a050cfd5084d05ff1782acf16e758150",
  "d3612ede40a2cae5e86eee61816f62fcbfdb9f0d8c7be0e30f442a67429c9bec",
  "230bb0f4494154d688bfee29341135f37ff0e93bed24bcbda1c97aa3dc0d3eff",
  "f43ac2917f0753c4b595943794a2e04aa6b624e5b0a2188c0dedee2162866221",
  "b67d8c198950c1e2ec81695ead0e5a0e59528e888e027acd51f1c1dae3d72f0f",
  "e43bc7bf3c90991539355fb26b17593f731c445cb6084e3ae6bb0b6410e64ec8",
  "fb0cfb48464dbf2476c6d2b57d26f314b069c59e03bb67809009902ab7b8dc2a",
  "f0c3cf932ecdae855373484434895b696b98b8ae7af535f26b4022e8bd30ed68",
];
const PETORO_GOLDEN_TEXT_ANCHORS_V1 = [
  [
    "ID 2-02",
    "ansvarlig for tilgjengelighet, stabilitet, kapasitet og sikkerhet",
  ],
  ["ID 2-07", "overta det som kjører per i dag"],
  ["ID 2-07", "administrasjon av Microsoft 365 lisensene"],
  ["ID 2-01", "tilbud som ikke dekker hele forespørselen"],
  ["ID 2-09", "Ecit, leveranse av printløsning"],
  ["ID 2-09", "2 stk. datalinjer"],
  ["ID 2-10", "splittes i faste og variable tjenester"],
  ["ID 2-14", "virkedager mellom kl. 08.00 og 16.00"],
  ["ID 2-14", "backup-ressurser på on-site Helpdesk"],
  ["ID 2-14", "Teams, SharePoint Online, OneDrive, Planner og OneNote"],
  ["ID 2-14", "Power Automate og Copilot"],
  ["Tabell ID 2-13 - Rapportering", "ukentlige statusmøter"],
  ["ID 2-21", "RADIUSaaS (100 users)"],
  ["ID 2-22", "tilgang til kjøp og håndtering av maskinutstyr"],
  ["ID 2-22", "garanti- og RMA-prosesser"],
  ["ID 2-23", "Prisen skal oppgis per time"],
  ["ID 2-23", "priser for overtid"],
  ["ID 2-23", "reisekostnader og kostnader for reisetid"],
  ["ID 2-24", "06.00-08.00 og 16.00-20.00"],
  ["ID 2-25", "Petoro er ikke ISO 27001-sertifisert"],
  ["ID 2-22", "anskaffe standard arbeidsstasjoner"],
  ["ID 2-23", "tilby konsulentbistand"],
  ["ID 2-24", "1 måneds skriftlig varsel"],
  ["ID 2-25", "helhetlig informasjons- og it-sikkerhet"],
  ["ID 2-30", "ekstern tilgang, fjernadministrasjon"],
  ["Tabell ID 2-31 - Avslutning", "sikker sletting av alle kundens data"],
  ["Tabell ID 2-11 - Tilgang og tilgjengelighet", "24/7/365"],
  ["Tabell ID 2-31 - Ivareta", "årlige planer for sikkerhetsarbeid"],
  ["Tabell ID 2-31 - Revisjon", "minimum 30 dager"],
  ["Tabell ID 2-31 - Kryptering", "rotasjon av kryptografiske nøkler"],
  ["Tabell ID 2-31 - Kryptering", "administrativ og privilegert tilgang"],
  ["Tabell ID 2-31 - Øvelse", "rutiner for kontinuitet"],
  ["Tabell ID 2-32 - Sikkerhetsovervåking", "en sikkerhetsovervåking"],
];

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
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
const xlsx = require(path.join(frontendRoot, "node_modules", "@e965", "xlsx"));
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "vurdering-api-full-251.cjs"), {
  fsCache: false,
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
  buildRequirementCoverageLedgerFromDocuments,
  extractRequirementLedgerForDocument,
  mergeRequirementCoverageLedgerWithSolutionAnswers,
} = jiti(
  path.join(frontendRoot, "lib", "server", "ai.ts"),
  path.join(frontendRoot, "lib", "server", "artifact-validation.ts"),
  path.join(frontendRoot, "lib", "server", "document-ledger.ts"),
  path.join(frontendRoot, "lib", "server", "project-jobs.ts"),
);
const { createServiceClient } = jiti(
  path.join(frontendRoot, "lib", "server", "supabase.ts"),
);
const { splitMarkdownTableRow } = jiti(
  path.join(frontendRoot, "lib", "markdown-table-row.ts"),
);
const { encryptJson } = jiti(
  path.join(frontendRoot, "lib", "server", "crypto.ts"),
);
const { analyzeRequirementCoverageIntegrity } = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "requirements",
    "evaluation-coverage-integrity.ts",
  ),
  path.join(
    frontendRoot,
    "lib",
    "server",
    "requirements",
    "generated-corpus-parser.ts",
  ),
  path.join(frontendRoot, "lib", "server", "requirements", "presentation.ts"),
  path.join(frontendRoot, "lib", "server", "repositories", "supabase-store.ts"),
);
const {
  canonicalRequirementSourceDocuments,
  canonicalizeRequirementSourceLedger,
} = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "use-cases",
    "solution-evaluation-readiness.ts",
  ),
);

function buildHarnessCanonicalRequirementScope({
  customerDocument,
  formalRequirementDocuments,
  requirementLedgerResults,
}) {
  const sourceDocuments = canonicalRequirementSourceDocuments({
    customerDocument,
    documents: [customerDocument, ...formalRequirementDocuments].filter(Boolean),
    selectedFormalDocumentIds: formalRequirementDocuments.map(
      (document) => document.id,
    ),
  });
  return {
    sourceDocuments,
    ledger: canonicalizeRequirementSourceLedger({
      sourceDocuments,
      requirementLedgerResults,
    }),
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const valueAfter = (name, fallback = "") => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const artifactsRoot = valueAfter("--artifacts-root", defaultArtifactsRoot);
  const explicitRunId = valueAfter("--run-id");
  const maxEstimatedCostUsdValue = valueAfter("--max-estimated-cost-usd");
  const maxEstimatedCostUsd = maxEstimatedCostUsdValue
    ? Number(maxEstimatedCostUsdValue)
    : null;
  if (
    maxEstimatedCostUsd !== null &&
    (!Number.isFinite(maxEstimatedCostUsd) || maxEstimatedCostUsd <= 0)
  ) {
    throw new Error(
      "--max-estimated-cost-usd må være et positivt, endelig tall.",
    );
  }

  return {
    baseUrl: valueAfter("--base-url"),
    port: Number(valueAfter("--port", "3000")) || 3000,
    startServer: !args.includes("--no-start-server"),
    keepServer: args.includes("--keep-server"),
    limit: valueAfter("--limit")
      ? Math.max(1, Number(valueAfter("--limit")))
      : null,
    only: valueAfter("--only"),
    fromIndex: valueAfter("--from-index")
      ? Math.max(1, Number(valueAfter("--from-index")))
      : null,
    toIndex: valueAfter("--to-index")
      ? Math.max(1, Number(valueAfter("--to-index")))
      : null,
    shardIndex:
      valueAfter("--shard-index") !== ""
        ? Number(valueAfter("--shard-index"))
        : null,
    shardCount: valueAfter("--shard-count")
      ? Math.max(1, Number(valueAfter("--shard-count")))
      : null,
    model: valueAfter("--model") || undefined,
    strictModel: args.includes("--strict-model"),
    maxEstimatedCostUsd,
    outputPath: valueAfter("--output", defaultOutputPath),
    artifactsRoot,
    reportPath: valueAfter("--report", defaultReportPath),
    serverLogPath: valueAfter("--server-log", defaultServerLogPath),
    runId:
      explicitRunId ||
      `audit-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    runIdExplicit: Boolean(explicitRunId),
    cleanupManifestPath: valueAfter(
      "--cleanup-manifest",
      path.join(artifactsRoot, "created-projects.jsonl"),
    ),
    resume: !args.includes("--no-resume"),
    retryFailures: args.includes("--retry-failures"),
    discoverOnly: args.includes("--discover-only"),
    mergeOnly: args.includes("--merge-only"),
    cleanupOnly: args.includes("--cleanup-only"),
    validateCleanupManifestOnly: args.includes(
      "--validate-cleanup-manifest-only",
    ),
    skipReport: args.includes("--skip-report"),
    acceptanceMode: valueAfter("--acceptance-mode", "proposal"),
    customerAnalysisApi: args.includes("--customer-analysis-api"),
    directSolutionEvaluation: args.includes("--direct-solution-evaluation"),
    selectionProfile: valueAfter("--selection-profile"),
    corpus: valueAfter("--corpus"),
    includePetoro: args.includes("--include-petoro"),
    requireProtectedPetoro: args.includes("--require-protected-petoro"),
    expectSelected: valueAfter("--expect-selected")
      ? Number(valueAfter("--expect-selected"))
      : null,
    corpus50Root: valueAfter("--corpus-50-root", defaultCorpus50Root),
    corpus100Root: valueAfter("--corpus-100-root", defaultCorpus100Root),
    rekkefolgeRoot: valueAfter("--rekkefolge-root", defaultRekkefolgeRoot),
    petoroRequirement: valueAfter("--petoro-krav", defaultPetoroRequirement),
    petoroCustomer: valueAfter("--petoro-bilag1", defaultPetoroCustomer),
  };
}

function normalizeInlineText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function selectionProfileDefinition(name) {
  const normalizedName = normalizeInlineText(name);
  if (!normalizedName) return null;
  const profile = SELECTION_PROFILES.get(normalizedName);
  if (!profile) {
    throw new Error(
      `Unknown --selection-profile value: ${normalizedName}. Expected one of ${[
        ...SELECTION_PROFILES.keys(),
      ].join(", ")}.`,
    );
  }
  const orderedProjectIds = [...profile.orderedProjectIds];
  const uniqueProjectIds = new Set(orderedProjectIds);
  const corpusProjectIds = orderedProjectIds.filter((projectId) =>
    /^100-folder-\d{3}$/u.test(projectId),
  );
  const petoroIds = orderedProjectIds.filter(
    (projectId) => projectId === "petoro",
  );
  const computedProfileSha256 = createHash("sha256")
    .update(`${orderedProjectIds.join("\n")}\n`)
    .digest("hex");
  if (
    orderedProjectIds.length !== profile.expectedSelected ||
    uniqueProjectIds.size !== orderedProjectIds.length ||
    corpusProjectIds.length !== 25 ||
    petoroIds.length !== 1 ||
    orderedProjectIds.at(-1) !== "petoro" ||
    computedProfileSha256 !== profile.profileSha256
  ) {
    throw new Error(
      `Selection profile ${profile.name} has an invalid frozen definition.`,
    );
  }
  return profile;
}

function selectionProfileIdentity(options) {
  const profile = selectionProfileDefinition(options.selectionProfile);
  if (!profile) return {};
  return {
    selectionProfile: profile.name,
    selectionProfileSha256: profile.profileSha256,
    selectionCorpusFasitSha256: profile.corpusFasitSha256,
    selectionSourceFilesSha256: profile.selectedSourceFilesSha256,
    selectionPetoroRequirementSha256: profile.petoroRequirementSha256,
    selectionPetoroCustomerSha256: profile.petoroCustomerSha256,
  };
}

function selectionProfileMetadata(options) {
  const profile = selectionProfileDefinition(options.selectionProfile);
  if (!profile) return null;
  return {
    name: profile.name,
    profileSha256: profile.profileSha256,
    orderedProjectIds: [...profile.orderedProjectIds],
    sourceHashes: {
      corpusFasitSha256: profile.corpusFasitSha256,
      selectedSourceFilesSha256: profile.selectedSourceFilesSha256,
      petoroRequirementSha256: profile.petoroRequirementSha256,
      petoroCustomerSha256: profile.petoroCustomerSha256,
    },
  };
}

function requestedModel(options) {
  return options.model ?? process.env.OPENAI_MODEL?.trim() ?? "gpt-5.4";
}

function resolveRunnerModelPlan(options, env = process.env) {
  const configuredDefaultModel = env.OPENAI_MODEL?.trim() || "gpt-5.4";
  const configuredAnalysisModel =
    env.OPENAI_ANALYSIS_MODEL?.trim() ||
    (/(?:mini|nano)$/i.test(configuredDefaultModel)
      ? "gpt-5.4"
      : configuredDefaultModel);
  const requested =
    options.model?.trim() || configuredDefaultModel;
  const effectiveAnalysisModel = /(?:mini|nano)$/i.test(requested)
    ? configuredAnalysisModel
    : requested;

  return {
    requestedModel: requested,
    configuredDefaultModel,
    configuredAnalysisModel,
    effectiveDefaultModel: requested,
    effectiveAnalysisModel,
    promotedAnalysisModel: effectiveAnalysisModel !== requested,
    effectiveByStage: {
      customerAnalysis: requested,
      requirementResponseBatch: effectiveAnalysisModel,
      requirementCoverageBatch: effectiveAnalysisModel,
      solutionEvaluationHolistic: effectiveAnalysisModel,
    },
  };
}

function assertRunnerModelPreflight(options, env = process.env) {
  const plan = resolveRunnerModelPlan(options, env);
  if (options.strictModel && plan.promotedAnalysisModel) {
    throw new Error(
      [
        `Strict model preflight failed before API calls: requested ${plan.requestedModel}`,
        `but analysis stages would use ${plan.effectiveAnalysisModel}.`,
        `Set OPENAI_ANALYSIS_MODEL=${plan.requestedModel} or remove --strict-model to allow promotion.`,
      ].join(" "),
    );
  }
  return plan;
}

function customerAnalysisMode(options) {
  return options.customerAnalysisApi ? "api" : "deterministic-seed";
}

function solutionEvaluationMode(options) {
  return options.directSolutionEvaluation ? "direct" : "jobs";
}

const CHECKPOINT_CODE_PATHS = [
  __filename,
  path.join(frontendRoot, "lib", "server", "ai.ts"),
  path.join(frontendRoot, "lib", "server", "prompts.ts"),
  path.join(frontendRoot, "lib", "server", "prompts", "requirements.ts"),
  path.join(frontendRoot, "lib", "server", "use-cases", "generate-artifact.ts"),
  path.join(frontendRoot, "lib", "server", "use-cases", "project-workflows.ts"),
  path.join(
    frontendRoot,
    "lib",
    "server",
    "use-cases",
    "solution-evaluation-readiness.ts",
  ),
  path.join(
    frontendRoot,
    "lib",
    "server",
    "use-cases",
    "solution-evaluation-source-snapshot.ts",
  ),
  path.join(frontendRoot, "lib", "server", "document-chunks.ts"),
  path.join(frontendRoot, "lib", "server", "embedding-request.ts"),
  path.join(frontendRoot, "lib", "server", "repositories", "supabase-store.ts"),
  path.join(frontendRoot, "lib", "document-processing.ts"),
  path.join(frontendRoot, "lib", "requirement-response-metadata.ts"),
  path.join(frontendRoot, "lib", "requirement-coverage-summary.ts"),
  path.join(
    frontendRoot,
    "lib",
    "server",
    "requirements",
    "evaluation-coverage-integrity.ts",
  ),
  path.join(
    frontendRoot,
    "lib",
    "server",
    "requirements",
    "generated-corpus-parser.ts",
  ),
  path.join(frontendRoot, "lib", "server", "requirements", "id-detection.ts"),
  path.join(frontendRoot, "lib", "requirement-order.ts"),
  path.join(
    repoRoot,
    "supabase",
    "migrations",
    "20260711121500_customer_analysis_invalidates_derived_outputs.sql",
  ),
  path.join(
    repoRoot,
    "supabase",
    "migrations",
    "20260711123000_solution_evaluation_source_revision_fence.sql",
  ),
  path.join(
    repoRoot,
    "supabase",
    "migrations",
    "20260711124500_selected_service_document_retrieval.sql",
  ),
  path.join(
    repoRoot,
    "supabase",
    "migrations",
    "20260711130000_generated_artifact_source_revision_fence.sql",
  ),
  path.join(
    repoRoot,
    "supabase",
    "migrations",
    "20260711133000_atomic_primary_document_roles.sql",
  ),
  path.join(
    repoRoot,
    "supabase",
    "migrations",
    "20260711134500_atomic_project_service_selections.sql",
  ),
  path.join(
    repoRoot,
    "supabase",
    "migrations",
    "20260711140000_atomic_document_chunk_replacement.sql",
  ),
];
const CHECKPOINT_CODE_ROOTS = [
  path.join(frontendRoot, "app", "api"),
  path.join(frontendRoot, "lib"),
  path.join(repoRoot, "supabase", "migrations"),
];
const CHECKPOINT_CODE_EXTENSIONS = new Set([
  ".js",
  ".json",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
]);

function checkpointFilesUnder(rootPath) {
  if (!existsSync(rootPath)) return [];
  const files = [];
  const visit = (currentPath) => {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (
        entry.isFile() &&
        CHECKPOINT_CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(entryPath);
      }
    }
  };
  visit(rootPath);
  return files;
}

CHECKPOINT_CODE_PATHS.push(
  path.join(frontendRoot, "package.json"),
  path.join(frontendRoot, "package-lock.json"),
  ...CHECKPOINT_CODE_ROOTS.flatMap(checkpointFilesUnder),
);
CHECKPOINT_CODE_PATHS.splice(
  0,
  CHECKPOINT_CODE_PATHS.length,
  ...new Set(CHECKPOINT_CODE_PATHS.map((filePath) => path.resolve(filePath))),
);
CHECKPOINT_CODE_PATHS.sort();
const CHECKPOINT_CONFIG_KEYS = [
  "OPENAI_MODEL",
  "OPENAI_ANALYSIS_MODEL",
  "OPENAI_REASONING_EFFORT",
  "OPENAI_EMBEDDING_MODEL",
  "RAG_QUERY_REWRITE",
  "DOCLING_INGESTION",
  "DOCLING_FORMATS",
  "DOCLING_ASYNC_AUTO_RUN",
  "DOCLING_ENHANCEMENT_MODE",
  "DOCLING_OCR",
  "DOCLING_POOR_EXTRACTION_MAX_CHARS",
  "DOCLING_COMPLEXITY_MIN_CHARS",
  "DOCLING_COMPLEXITY_MIN_SECTIONS",
  "REQUIREMENT_RESPONSE_BATCH_SIZE",
  "LARGE_REQUIREMENT_RESPONSE_BATCH_SIZE",
  "REQUIREMENT_RESPONSE_BATCH_CONCURRENCY",
  "REQUIREMENT_RESPONSE_RETRIEVAL_CONCURRENCY",
  "REQUIREMENT_RESPONSE_HANDOFF_CONCURRENCY",
  "REQUIREMENT_RESPONSE_STRICT_HANDOFF_CONCURRENCY",
  "REQUIREMENT_RESPONSE_STRICT_HANDOFF_MAX_CALLS",
  "REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEADLINE_MS",
  "REQUIREMENT_COVERAGE_BATCH_SIZE",
  "REQUIREMENT_COVERAGE_BATCH_CHAR_BUDGET",
  "REQUIREMENT_COVERAGE_BATCH_CONCURRENCY",
  "REQUIREMENT_COVERAGE_EVALUATION_DETAIL_MAX_ROWS",
  "REQUIREMENT_COVERAGE_EVALUATION_DETAIL_CHAR_BUDGET",
  "REQUIREMENT_RESPONSE_DIAGNOSTIC_FAILED_ANSWERS",
  "ARTIFACT_GENERATOR_REVISION",
  "GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "OPENAI_PROMPT_CACHE_RETENTION",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
];
let cachedCheckpointCodeRevision = null;

function checkpointCodeRevision() {
  if (cachedCheckpointCodeRevision) return cachedCheckpointCodeRevision;
  const hash = createHash("sha256");
  for (const filePath of CHECKPOINT_CODE_PATHS) {
    hash.update(path.relative(repoRoot, filePath));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  cachedCheckpointCodeRevision = hash.digest("hex");
  return cachedCheckpointCodeRevision;
}

function checkpointConfigurationRevision(options = {}) {
  const hash = createHash("sha256");
  for (const key of CHECKPOINT_CONFIG_KEYS) {
    hash.update(`${key}=${process.env[key] ?? ""}\n`);
  }
  const profileIdentity = selectionProfileIdentity(options);
  for (const [key, value] of Object.entries(profileIdentity)) {
    hash.update(`${key}=${value}\n`);
  }
  return hash.digest("hex");
}

function checkpointBackendIdentity(options) {
  const apiBaseUrl = String(options.resolvedBaseUrl ?? options.baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  const supabaseUrl = String(
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  )
    .trim()
    .replace(/\/+$/, "");
  return createHash("sha256")
    .update(JSON.stringify({ apiBaseUrl, supabaseUrl }))
    .digest("hex");
}

async function projectCheckpointContext(project, options = {}) {
  const [requirementBytes, customerBytes] = await Promise.all([
    readFile(project.requirementPath),
    readFile(project.customerPath),
  ]);
  const sourceHash = createHash("sha256");
  for (const [label, filePath, bytes] of [
    ["requirement", project.requirementPath, requirementBytes],
    ["customer", project.customerPath, customerBytes],
  ]) {
    sourceHash.update(label);
    sourceHash.update("\0");
    sourceHash.update(path.resolve(filePath));
    sourceHash.update("\0");
    sourceHash.update(bytes);
    sourceHash.update("\0");
  }
  return {
    projectId: project.id,
    sourceFingerprint: sourceHash.digest("hex"),
    codeRevision: checkpointCodeRevision(),
    configurationRevision: checkpointConfigurationRevision(options),
  };
}

function checkpointIdentity(options, context = {}) {
  return {
    schemaVersion: HARNESS_CHECKPOINT_SCHEMA_VERSION,
    runId: options.runId,
    model: requestedModel(options),
    customerAnalysisMode: customerAnalysisMode(options),
    ...(options.directSolutionEvaluation
      ? { solutionEvaluationMode: solutionEvaluationMode(options) }
      : {}),
    backendIdentity: checkpointBackendIdentity(options),
    ...selectionProfileIdentity(options),
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.sourceFingerprint
      ? { sourceFingerprint: context.sourceFingerprint }
      : {}),
    ...(context.codeRevision ? { codeRevision: context.codeRevision } : {}),
    ...(context.configurationRevision
      ? { configurationRevision: context.configurationRevision }
      : {}),
  };
}

function checkpointIdentityMismatch(checkpoint, options, context = {}) {
  const expected = checkpointIdentity(options, context);
  const expectedSelectionProfile = selectionProfileIdentity(options);
  const actual = {
    schemaVersion: checkpoint?.checkpointSchemaVersion ?? null,
    runId: checkpoint?.runId ?? null,
    model: checkpoint?.model ?? null,
    customerAnalysisMode: checkpoint?.customerAnalysisMode ?? null,
    ...(options.directSolutionEvaluation
      ? {
          solutionEvaluationMode:
            checkpoint?.solutionEvaluationMode ?? null,
        }
      : {}),
    backendIdentity: checkpoint?.backendIdentity ?? null,
    ...Object.fromEntries(
      Object.keys(expectedSelectionProfile).map((field) => [
        field,
        checkpoint?.[field] ?? null,
      ]),
    ),
    ...(context.projectId
      ? { projectId: checkpoint?.checkpointProjectId ?? null }
      : {}),
    ...(context.sourceFingerprint
      ? { sourceFingerprint: checkpoint?.sourceFingerprint ?? null }
      : {}),
    ...(context.codeRevision
      ? { codeRevision: checkpoint?.codeRevision ?? null }
      : {}),
    ...(context.configurationRevision
      ? { configurationRevision: checkpoint?.configurationRevision ?? null }
      : {}),
  };
  const mismatches = Object.entries(expected)
    .filter(([field, value]) => actual[field] !== value)
    .map(
      ([field, value]) =>
        `${field}: expected ${value}, found ${actual[field] ?? "missing"}`,
    );
  return mismatches.length ? mismatches.join("; ") : null;
}

function normalizeComparable(value) {
  return normalizeInlineText(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/["“”]/g, "")
    .replace(/[.,;:]+$/g, "")
    .trim();
}

function normalizeRequirementMeaning(value) {
  return normalizeComparable(value)
    .replace(
      /^(?:avklaring|implisitt|fra arbeidsnotatet|notat fra behovsarbeidet|notat)\s*[:\-]\s*/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRef(value) {
  return normalizeComparable(value)
    .replace(/^(?:-|—|n\/a|na|nei|ingen)$/i, "")
    .replace(/\s*[-/]\s*/g, "-")
    .replace(/\s+/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slug(value) {
  return (
    normalizeInlineText(value)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "project"
  );
}

async function walkFiles(root) {
  const files = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else {
        files.push(filePath);
      }
    }
  }
  await visit(root);
  return files;
}

function loadRows(sheetPath, sheetName = "Alle krav") {
  const workbook = xlsx.readFile(sheetPath);
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Fasitfilen mangler arket "${sheetName}": ${sheetPath}`);
  }
  return xlsx.utils.sheet_to_json(sheet, { defval: "" });
}

function groupRowsByDocument(rows, columnName) {
  const byDocument = new Map();
  for (const row of rows) {
    const documentName = normalizeInlineText(row[columnName]);
    if (!documentName) continue;
    byDocument.set(documentName, [
      ...(byDocument.get(documentName) ?? []),
      row,
    ]);
  }
  return byDocument;
}

function leadingProjectNumber(filePath) {
  return path.basename(filePath).match(/^(\d+)[_-]/)?.[1] ?? "";
}

function projectNameFromRequirement(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .replace(/^\d+_Bilag_2_Krav_/, "")
    .replace(/^\d+_/, "")
    .replace(/^Bilag_2_Krav_/, "")
    .replace(/_/g, " ");
}

function discoveryProjectSummary(project) {
  if (!project) return null;
  return {
    id: project.id,
    corpus: project.corpus,
    sourceNumber: project.sourceNumber,
    name: project.name,
    documentName: project.documentName,
    requirementPath: project.requirementPath,
    customerPath: project.customerPath,
    fasitRows: project.fasitRows?.length ?? 0,
    hasFasit: project.hasFasit,
  };
}

function rowsSortedByFasitOrder(rows) {
  return [...rows].sort((left, right) => {
    const leftOrder = Number(
      left["Kravrekkefølge i Bilag 2"] ?? left.Nr ?? left["Nr"] ?? 0,
    );
    const rightOrder = Number(
      right["Kravrekkefølge i Bilag 2"] ?? right.Nr ?? right["Nr"] ?? 0,
    );
    return leftOrder - rightOrder;
  });
}

async function discoverLegacyFasitProjects({ corpus, root, fasitPath }) {
  const rootFiles = await walkFiles(root);
  const byRelative = new Map(
    rootFiles.map((filePath) => [path.relative(root, filePath), filePath]),
  );
  const byBasename = new Map();
  const bilag1ByNumber = new Map();

  for (const filePath of rootFiles) {
    const fileName = path.basename(filePath);
    byBasename.set(fileName, [...(byBasename.get(fileName) ?? []), filePath]);
    if (!/_Bilag_1_/i.test(fileName)) continue;
    const number = leadingProjectNumber(fileName);
    if (number) {
      bilag1ByNumber.set(number, [
        ...(bilag1ByNumber.get(number) ?? []),
        filePath,
      ]);
    }
  }

  const rowsByDocument = groupRowsByDocument(loadRows(fasitPath), "Dokument");
  return [...rowsByDocument.entries()]
    .map(([documentName, fasitRows], index) => {
      const requirementPath =
        byRelative.get(documentName) ??
        byBasename.get(path.basename(documentName))?.[0];
      if (!requirementPath) {
        throw new Error(`Fant ikke kravdokument fra fasit: ${documentName}`);
      }
      const number = leadingProjectNumber(requirementPath);
      const bilag1Candidates = bilag1ByNumber.get(number) ?? [];
      const sameDir = bilag1Candidates.find(
        (candidate) =>
          path.dirname(candidate) === path.dirname(requirementPath),
      );
      const customerPath = sameDir ?? bilag1Candidates[0] ?? null;
      if (!customerPath) {
        throw new Error(`Fant ikke Bilag 1 for ${requirementPath}`);
      }
      return {
        id: `${corpus}-${number || index + 1}`,
        corpus,
        projectNumber: index + 1,
        sourceNumber: number,
        name: projectNameFromRequirement(requirementPath),
        documentName,
        requirementPath,
        customerPath,
        fasitRows: rowsSortedByFasitOrder(fasitRows),
        hasFasit: true,
      };
    })
    .sort(
      (left, right) => Number(left.sourceNumber) - Number(right.sourceNumber),
    );
}

async function discoverRekkefolgeProjects({ root }) {
  const fasitPath = path.join(
    root,
    "Fasit_100_skyprosjekter_rekkefolge_ekstraksjon.xlsx",
  );
  const rows = loadRows(fasitPath);
  const rootFiles = await walkFiles(root);
  const byBasename = new Map();
  for (const filePath of rootFiles) {
    byBasename.set(path.basename(filePath), filePath);
  }

  const grouped = new Map();
  for (const row of rows) {
    const projectId = normalizeInlineText(row["Prosjekt ID"]);
    const documentName = normalizeInlineText(row["Bilag 2-fil"]);
    if (!projectId || !documentName) continue;
    const key = `${projectId}|${documentName}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return [...grouped.entries()]
    .map(([key, fasitRows], index) => {
      const [projectId, documentName] = key.split("|");
      const requirementPath = byBasename.get(documentName);
      if (!requirementPath) {
        throw new Error(`Fant ikke rekkefolge-kravdokument: ${documentName}`);
      }
      const customerName = documentName.replace("_Bilag_2_Krav_", "_Bilag_1_");
      const customerPath = byBasename.get(customerName);
      if (!customerPath) {
        throw new Error(`Fant ikke rekkefolge-Bilag 1: ${customerName}`);
      }
      const number = leadingProjectNumber(requirementPath);
      return {
        id: `rekkefolge-100-${number || projectId}`,
        corpus: "rekkefolge-100",
        projectNumber: index + 1,
        sourceNumber: number,
        name:
          normalizeInlineText(fasitRows[0]?.Kunde) ||
          projectNameFromRequirement(requirementPath),
        documentName,
        requirementPath,
        customerPath,
        fasitRows: rowsSortedByFasitOrder(fasitRows),
        hasFasit: true,
      };
    })
    .sort(
      (left, right) => Number(left.sourceNumber) - Number(right.sourceNumber),
    );
}

const SYNTHETIC_CUSTOMER_FILE_NAME = "synthetic-bilag1.md";
const SYNTHETIC_CUSTOMER_DOCUMENT_TITLE = "Syntetisk Bilag 1 fallback";

function documentTitleForUpload(fileName) {
  const basename = path.basename(fileName);
  return path.basename(basename, path.extname(basename));
}

function projectDocumentDetailFromParsed({
  fileName,
  title,
  parsed,
  buffer,
  projectId,
  role,
  supportingSubtype = null,
}) {
  const now = new Date(0).toISOString();
  return {
    id: `${projectId}-${fileName}`,
    project_id: projectId,
    role,
    supporting_subtype: supportingSubtype,
    title: title || documentTitleForUpload(fileName),
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

async function loadProjectDocument({
  filePath,
  fileNameOverride,
  projectId,
  role,
  supportingSubtype = null,
}) {
  const buffer = await readFile(filePath);
  const fileName = fileNameOverride ?? path.basename(filePath);
  const fileFormat = inferUploadFileFormat({ fileName });
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName,
    contentType: contentTypeForUploadFormat(fileFormat),
    role,
    useDocling: false,
  });
  return projectDocumentDetailFromParsed({
    fileName,
    parsed,
    buffer,
    projectId,
    role,
    supportingSubtype,
  });
}

async function buildLocalPetoroCanonicalPreflight({
  requirementPath = defaultPetoroRequirement,
  customerPath = defaultPetoroCustomer,
  projectId = "petoro-canonical-preflight",
} = {}) {
  const [requirementDocument, customerDocument] = await Promise.all([
    loadProjectDocument({
      filePath: requirementPath,
      fileNameOverride: "Kravdokument - Bilag 2 - Petoro.pdf",
      projectId,
      role: "supporting_document",
      supportingSubtype: "kravdokument",
    }),
    loadProjectDocument({
      filePath: customerPath,
      fileNameOverride: "Bilag 1 - Petoro.pdf",
      projectId,
      role: "primary_customer_document",
    }),
  ]);
  const [bilag2SourceLedger, customerSourceLedger] = await Promise.all([
    extractRequirementLedgerForDocument(requirementDocument),
    extractRequirementLedgerForDocument(customerDocument),
  ]);
  const canonicalRequirementScope = buildHarnessCanonicalRequirementScope({
    customerDocument,
    formalRequirementDocuments: [requirementDocument],
    requirementLedgerResults: [
      { document: customerDocument, ledger: customerSourceLedger },
      { document: requirementDocument, ledger: bilag2SourceLedger },
    ],
  });

  return {
    requirementDocument,
    customerDocument,
    bilag2SourceLedger,
    customerSourceLedger,
    canonicalRequirementScope,
    canonicalEvaluationSourceLedger: canonicalRequirementScope.ledger,
  };
}

async function buildIntegrityLedgerFromGeneratedSolutionArtifact({
  sourceLedger,
  artifactMarkdown,
  solutionFileName,
  solutionDocumentId,
  solutionDocumentTitle,
  projectId = "vurdering-harness-integrity",
}) {
  const buffer = Buffer.from(String(artifactMarkdown ?? ""), "utf8");
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName: solutionFileName,
    contentType: "text/markdown",
    role: "primary_solution_document",
    useDocling: false,
  });
  const solutionDocument = {
    ...projectDocumentDetailFromParsed({
      fileName: solutionFileName,
      parsed,
      buffer,
      projectId,
      role: "primary_solution_document",
    }),
    id: solutionDocumentId,
    title: solutionDocumentTitle,
  };
  const solutionLedger =
    await extractRequirementLedgerForDocument(solutionDocument);

  return mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements: sourceLedger,
    solutionEntries: solutionLedger,
  });
}

function artifactSourceDocumentIds(artifact) {
  const inputSnapshot = artifact?.input_snapshot;
  const requested = Array.isArray(
    inputSnapshot?.requested_source_document_ids,
  )
    ? inputSnapshot.requested_source_document_ids
        .map(normalizeInlineText)
        .filter(Boolean)
    : [];
  const requestedSourceSnapshot = Array.isArray(
    inputSnapshot?.source_snapshot?.requested_source_document_ids,
  )
    ? inputSnapshot.source_snapshot.requested_source_document_ids
        .map(normalizeInlineText)
        .filter(Boolean)
    : [];
  const topLevel = Array.isArray(inputSnapshot?.source_document_ids)
    ? inputSnapshot.source_document_ids.map(normalizeInlineText).filter(Boolean)
    : [];
  const sourceSnapshot = Array.isArray(
    inputSnapshot?.source_snapshot?.declared_source_document_ids,
  )
    ? inputSnapshot.source_snapshot.declared_source_document_ids
        .map(normalizeInlineText)
        .filter(Boolean)
    : [];
  const roleManifest = Array.isArray(inputSnapshot?.source_document_roles)
    ? inputSnapshot.source_document_roles
        .map((entry) => normalizeInlineText(entry?.id))
        .filter(Boolean)
    : [];
  return {
    requested,
    requestedSourceSnapshot,
    topLevel,
    sourceSnapshot,
    roleManifest,
  };
}

function assertGeneratedArtifactSourceScope({
  artifact,
  expectedRequestedDocumentIds,
  expectedDocumentIds,
}) {
  const expectedRequested = expectedRequestedDocumentIds
    .map(normalizeInlineText)
    .filter(Boolean);
  const expected = expectedDocumentIds.map(normalizeInlineText).filter(Boolean);
  const actual = artifactSourceDocumentIds(artifact);
  const matchesExpected = (values) =>
    values.length === expected.length &&
    values.every((value, index) => value === expected[index]);
  for (const [label, values] of Object.entries({
    requested: actual.requested,
    requestedSourceSnapshot: actual.requestedSourceSnapshot,
  })) {
    if (
      values.length !== expectedRequested.length ||
      values.some((value, index) => value !== expectedRequested[index])
    ) {
      throw new Error(
        `Generated requirement response requested source scope mismatch in ${label}: ` +
          `expected [${expectedRequested.join(", ")}], received [${values.join(", ")}].`,
      );
    }
  }
  for (const [label, values] of Object.entries({
    topLevel: actual.topLevel,
    sourceSnapshot: actual.sourceSnapshot,
    roleManifest: actual.roleManifest,
  })) {
    if (!matchesExpected(values)) {
      throw new Error(
        `Generated requirement response source scope mismatch in ${label}: ` +
          `expected [${expected.join(", ")}], received [${values.join(", ")}].`,
      );
    }
  }
  return actual;
}

function syntheticCustomerMarkdown({ projectName, reason }) {
  return [
    `# ${projectName}`,
    "",
    "Minimal syntetisk kundegrunnlag brukt fordi lokal/API-parsing av Bilag 1 feilet.",
    `Parsingfeil: ${reason}`,
    "Vurderingen skal primært kontrolleres mot kravledgeren fra Bilag 2.",
  ].join("\n");
}

async function buildSyntheticCustomerDocument({ projectId, projectName, reason }) {
  const fileName = SYNTHETIC_CUSTOMER_FILE_NAME;
  const buffer = Buffer.from(
    syntheticCustomerMarkdown({ projectName, reason }),
    "utf8",
  );
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName,
    contentType: "text/markdown",
    role: "primary_customer_document",
    useDocling: false,
  });
  return projectDocumentDetailFromParsed({
    fileName,
    parsed,
    buffer,
    projectId,
    role: "primary_customer_document",
    title: SYNTHETIC_CUSTOMER_DOCUMENT_TITLE,
  });
}

function compactText(value, limit = 700) {
  const text = normalizeInlineText(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function buildCustomerAnalysis({ projectName, customerDocument, ledger }) {
  const profile = compactText(customerDocument.raw_text, 600);
  return {
    customer_profile_summary:
      profile || `${projectName} er analysert fra lokal Bilag 1-tekst.`,
    customer_goals_summary:
      "Kunden trenger en tilbudsbesvarelse som dekker alle krav med tydelig ansvar, leveransebevis, driftsovergang og avklaringer.",
    high_level_solution_design:
      "Løsningen bør styres som en kravdrevet leveranse med sporbarhet fra hvert krav til tiltak, test, akseptanse og drift.",
    high_level_architecture_mermaid:
      "flowchart TD\nKunde[Kunde] --> Leveranse[Atea leveranse]",
    customer_profile: [profile].filter(Boolean),
    customer_goals: [
      "Fullstendig og sporbar kravdekning.",
      "Tydelige anbefalinger og avklaringer før kontrakt.",
    ],
    implicit_requirements: [],
    prioritized_requirements: ledger.slice(0, 6).map((entry) => ({
      requirement: compactText(entry.text, 180),
      priority: "Viktig",
      reason: "Kravet inngar i kildeledgeren og ma vurderes eksplisitt.",
    })),
    ambiguities: [],
    risks: [],
    risks_for_us: [],
    risks_for_customer: [],
    likely_evaluation_criteria: [
      "Dekning av alle kravrader.",
      "Konkrete bevis og anbefalinger per krav.",
      "Sporbarhet til kilde, side, tabell eller seksjon.",
    ],
    signal_words: [],
    signal_word_counts: [],
    expected_solution_direction: [
      "Kravdrevet leveranse med dokumenterte kontrollpunkter.",
    ],
    positioning_recommendations: [
      "Svar konkret pa hvert krav og skill leveransebevis fra apne avklaringer.",
    ],
    recommended_services: [],
    value_opportunities: [],
    executive_summary:
      "Vurderingen er kjort mot ekte kravledger og API-generert kravbesvarelse for a teste dekning og actionability.",
  };
}

function expectedIdFromFasit(row) {
  const usability = normalizeInlineText(row?.["Har brukbar ID"]);
  if (usability && !/^ja$/i.test(usability)) return "";
  const original = normalizeInlineText(row?.["Original ID / markering"]);
  if (
    /^(?:|[-—x?]|se\s+notat|må\s+avklares|rad\s+i\s+tabell|uten\s+nr\.?|ikke\s+satt|mangler\s+id|nb)$/i.test(
      original,
    )
  ) {
    return usability ? normalizeRef(row?.["ID-identifikator"]) : "";
  }
  return (
    normalizeRef(row?.["ID-identifikator"]) ||
    normalizeRef(row?.["Original ID / markering"])
  );
}

function exactEntryIdMatch(row, entry) {
  const expectedId = expectedIdFromFasit(row);
  if (!expectedId || !entry) return false;
  return [entry.id, entry.fullReference, entry.reference, entry.tableId]
    .map(normalizeRef)
    .some((value) => value === expectedId);
}

function exactEntryHeadingMatch(row, entry) {
  const expectedHeading = normalizeComparable(row?.Underoverskrift);
  if (!expectedHeading || !entry) return false;
  const actualHeading = normalizeComparable(
    entry.heading || entry.headingPath || entry.tableId,
  );
  return Boolean(actualHeading) && actualHeading === expectedHeading;
}

function alignLedgerWithFasitRows(ledger, expectedRows) {
  const candidatesByText = new Map();
  for (const [entryIndex, entry] of ledger.entries()) {
    const text = normalizeRequirementMeaning(entry?.text);
    if (!text) continue;
    candidatesByText.set(text, [
      ...(candidatesByText.get(text) ?? []),
      entryIndex,
    ]);
  }

  const expectedByText = new Map();
  for (const [rowIndex, row] of expectedRows.entries()) {
    const text = normalizeRequirementMeaning(row?.Kravtekst);
    if (!text) continue;
    expectedByText.set(text, [...(expectedByText.get(text) ?? []), rowIndex]);
  }

  const matchedEntryIndexes = Array(expectedRows.length).fill(null);
  for (const [text, rowIndexes] of expectedByText.entries()) {
    const available = new Set(candidatesByText.get(text) ?? []);
    const assign = (rowIndex, candidateIndex) => {
      matchedEntryIndexes[rowIndex] = candidateIndex;
      available.delete(candidateIndex);
    };

    // Preserve exact IDs first. For repeated text/ID pairs, prefer exact heading too.
    for (const rowIndex of rowIndexes) {
      if (matchedEntryIndexes[rowIndex] !== null) continue;
      const row = expectedRows[rowIndex];
      if (!expectedIdFromFasit(row)) continue;
      const candidates = [...available].filter((candidateIndex) =>
        exactEntryIdMatch(row, ledger[candidateIndex]),
      );
      if (!candidates.length) continue;
      const headingCandidate = candidates.find((candidateIndex) =>
        exactEntryHeadingMatch(row, ledger[candidateIndex]),
      );
      assign(rowIndex, headingCandidate ?? candidates[0]);
    }

    // Then preserve exact headings for rows without an assigned exact-ID candidate.
    for (const rowIndex of rowIndexes) {
      if (matchedEntryIndexes[rowIndex] !== null) continue;
      const row = expectedRows[rowIndex];
      if (!normalizeComparable(row?.Underoverskrift)) continue;
      const candidateIndex = [...available].find((index) =>
        exactEntryHeadingMatch(row, ledger[index]),
      );
      if (candidateIndex !== undefined) assign(rowIndex, candidateIndex);
    }

    // Canonical exact text remains the only fallback; no fuzzy/substring matching.
    for (const rowIndex of rowIndexes) {
      if (matchedEntryIndexes[rowIndex] !== null) continue;
      const candidateIndex = available.values().next().value;
      if (candidateIndex === undefined) break;
      assign(rowIndex, candidateIndex);
    }
  }

  return matchedEntryIndexes;
}

function countUnorderedTextMatches(
  ledger,
  expectedRows,
  normalizeText = normalizeComparable,
) {
  const expectedCounts = new Map();
  for (const row of expectedRows) {
    const text = normalizeText(row?.Kravtekst);
    if (!text) continue;
    expectedCounts.set(text, (expectedCounts.get(text) ?? 0) + 1);
  }
  let matched = 0;
  for (const entry of ledger) {
    const text = normalizeText(entry?.text);
    const remaining = expectedCounts.get(text) ?? 0;
    if (remaining <= 0) continue;
    matched += 1;
    if (remaining === 1) expectedCounts.delete(text);
    else expectedCounts.set(text, remaining - 1);
  }
  return matched;
}

function sourceGeometryOrderDiagnostics(ledger) {
  const issues = [];
  let comparablePairs = 0;
  let orderedPairs = 0;

  for (let index = 1; index < ledger.length; index += 1) {
    const previous = ledger[index - 1];
    const current = ledger[index];
    const previousOrder =
      typeof previous?.documentEntryOrder === "number"
        ? previous.documentEntryOrder
        : Number.NaN;
    const currentOrder =
      typeof current?.documentEntryOrder === "number"
        ? current.documentEntryOrder
        : Number.NaN;
    const hasExplicitOrders =
      Number.isFinite(previousOrder) && Number.isFinite(currentOrder);
    const previousPage =
      typeof previous?.pages?.[0] === "number" ? previous.pages[0] : Number.NaN;
    const currentPage =
      typeof current?.pages?.[0] === "number" ? current.pages[0] : Number.NaN;
    const hasPages =
      Number.isFinite(previousPage) && Number.isFinite(currentPage);

    if (!hasExplicitOrders && !hasPages) continue;
    comparablePairs += 1;

    const inSourceOrder = hasExplicitOrders
      ? currentOrder > previousOrder
      : currentPage >= previousPage;
    if (inSourceOrder) {
      orderedPairs += 1;
      continue;
    }

    issues.push(
      `${index} ${previous?.id || "(uten id)"} -> ${index + 1} ${
        current?.id || "(uten id)"
      }`,
    );
  }

  return {
    comparablePairs,
    orderedPairs,
    issues,
  };
}

function compareLedgerWithFasitRows(ledger, expectedRows, options = {}) {
  const mismatches = [];
  let rawOrderedMatched = 0;
  let orderedMatched = 0;
  let rawWorkbookOrderedMatched = 0;
  let workbookOrderedMatched = 0;
  let idMatched = 0;
  let idComparable = 0;
  let headingMatched = 0;
  let headingComparable = 0;
  const byStructure = new Map();
  const matchedEntryIndexes = alignLedgerWithFasitRows(ledger, expectedRows);

  for (let index = 0; index < expectedRows.length; index += 1) {
    const row = expectedRows[index];
    const workbookOrderedEntry = ledger[index];
    const matchedEntryIndex = matchedEntryIndexes[index];
    const sourceOrderedEntry =
      matchedEntryIndex === null ? undefined : ledger[matchedEntryIndex];
    const structure = normalizeInlineText(row?.Strukturgrad) || "unknown";
    const bucket = byStructure.get(structure) ?? {
      expected: 0,
      orderedMatched: 0,
      idMatched: 0,
      idComparable: 0,
      headingMatched: 0,
      headingComparable: 0,
    };
    bucket.expected += 1;

    const rawExpectedText = normalizeComparable(row?.Kravtekst);
    const rawWorkbookOrderedText = normalizeComparable(
      workbookOrderedEntry?.text,
    );
    const rawSourceOrderedText = normalizeComparable(sourceOrderedEntry?.text);
    const expectedText = normalizeRequirementMeaning(row?.Kravtekst);
    const workbookOrderedText = normalizeRequirementMeaning(
      workbookOrderedEntry?.text,
    );
    const sourceOrderedText = normalizeRequirementMeaning(
      sourceOrderedEntry?.text,
    );
    if (rawWorkbookOrderedText && rawWorkbookOrderedText === rawExpectedText) {
      rawWorkbookOrderedMatched += 1;
    }
    if (workbookOrderedText && workbookOrderedText === expectedText) {
      workbookOrderedMatched += 1;
    }
    if (rawSourceOrderedText && rawSourceOrderedText === rawExpectedText) {
      rawOrderedMatched += 1;
    }
    if (sourceOrderedText && sourceOrderedText === expectedText) {
      orderedMatched += 1;
      bucket.orderedMatched += 1;
    } else {
      mismatches.push({
        index: index + 1,
        ref: row?.["Fasit-ref"],
        expected: row?.Kravtekst,
        actual: sourceOrderedEntry?.text,
        canonicalMatchIndex:
          matchedEntryIndex === null ? null : matchedEntryIndex + 1,
      });
    }

    const expectedId = expectedIdFromFasit(row);
    if (expectedId) {
      idComparable += 1;
      bucket.idComparable += 1;
      if (exactEntryIdMatch(row, sourceOrderedEntry)) {
        idMatched += 1;
        bucket.idMatched += 1;
      }
    }

    const expectedHeading = normalizeComparable(row?.Underoverskrift);
    if (expectedHeading) {
      headingComparable += 1;
      bucket.headingComparable += 1;
      if (exactEntryHeadingMatch(row, sourceOrderedEntry)) {
        headingMatched += 1;
        bucket.headingMatched += 1;
      }
    }
    byStructure.set(structure, bucket);
  }

  const missingLocatorIssues = ledger
    .map((entry, index) => {
      const hasLocator =
        entry.sourceExcerpt ||
        entry.tableId ||
        entry.heading ||
        (Array.isArray(entry.pages) && entry.pages.length > 0);
      return hasLocator ? null : `${index + 1} ${entry.id || "(uten id)"}`;
    })
    .filter(Boolean);
  const sourceGeometry = sourceGeometryOrderDiagnostics(ledger);
  const sourceFormat = normalizeInlineText(options.sourceFormat).toLowerCase();
  const sourceGeometryEnforced = sourceFormat === "pdf";
  const sourceIssues = [
    ...missingLocatorIssues,
    ...(sourceGeometryEnforced
      ? sourceGeometry.issues.map((issue) => `source-order ${issue}`)
      : []),
  ];

  return {
    expectedCount: expectedRows.length,
    actualCount: ledger.length,
    orderingBasis: sourceGeometryEnforced
      ? "source_geometry"
      : "ledger_source_order",
    workbookOrderAuthoritative: false,
    sourceGeometryEnforced,
    sourceGeometryComparablePairs: sourceGeometry.comparablePairs,
    sourceGeometryOrderedPairs: sourceGeometry.orderedPairs,
    rawOrderedMatched,
    orderedMatched,
    rawWorkbookOrderedMatched,
    workbookOrderedMatched,
    rawUnorderedMatched: countUnorderedTextMatches(
      ledger,
      expectedRows,
      normalizeComparable,
    ),
    unorderedMatched: matchedEntryIndexes.filter((index) => index !== null)
      .length,
    idComparable,
    idMatched,
    headingComparable,
    headingMatched,
    byStructure: Object.fromEntries(byStructure.entries()),
    mismatches: mismatches.slice(0, 12),
    mismatchCount: mismatches.length,
    sourceIssues: sourceIssues.slice(0, 12),
    sourceIssueCount: sourceIssues.length,
  };
}

function normalizeFindingEvidence(value) {
  return normalizeInlineText(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[“”"]/g, "")
    .replace(/^[\s'`‘’.,;:!?…()[\]{}<>]+/u, "")
    .replace(/[\s'`‘’.,;:!?…()[\]{}<>]+$/u, "")
    .trim();
}

function compareLedgerWithRequirementOracle(ledger, oracle) {
  if (!oracle) return null;
  const expectedIds = Array.isArray(oracle.orderedIds) ? oracle.orderedIds : [];
  const actualIds = ledger.map((entry) => normalizeInlineText(entry.id));
  const orderedIdsMatch =
    actualIds.length === expectedIds.length &&
    actualIds.every(
      (id, index) => normalizeRef(id) === normalizeRef(expectedIds[index]),
    );
  const entriesById = new Map(
    ledger.map((entry) => [normalizeRef(entry.id), entry]),
  );
  const missingOrChangedAnchors = (oracle.textAnchors ?? [])
    .map(([id, expectedText]) => {
      const entry = entriesById.get(normalizeRef(id));
      return entry &&
        normalizeRequirementMeaning(entry.text).includes(
          normalizeRequirementMeaning(expectedText),
        )
        ? null
        : id;
    })
    .filter(Boolean);
  const expectedTextHashes = Array.isArray(oracle.orderedTextSha256)
    ? oracle.orderedTextSha256
    : [];
  const actualTextHashes = ledger.map((entry) =>
    createHash("sha256")
      .update(normalizeRequirementMeaning(entry.text))
      .digest("hex"),
  );
  const changedTextRows = expectedTextHashes.length
    ? expectedIds.filter(
        (_, index) => actualTextHashes[index] !== expectedTextHashes[index],
      )
    : [];
  const orderedTextsMatch =
    expectedTextHashes.length === 0 ||
    (expectedTextHashes.length === expectedIds.length &&
      changedTextRows.length === 0);
  return {
    version: oracle.version,
    expectedCount: expectedIds.length,
    actualCount: ledger.length,
    orderedIdsMatch,
    orderedTextsMatch,
    changedTextRows,
    missingOrChangedAnchors,
    ok:
      expectedIds.length > 0 &&
      orderedIdsMatch &&
      orderedTextsMatch &&
      missingOrChangedAnchors.length === 0,
  };
}

function normalizedTextIsExactOrContained(
  left,
  right,
  minimumContainedLength = 1,
) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) < minimumContainedLength) {
    return false;
  }
  return left.includes(right) || right.includes(left);
}

function findingEvidenceMatchesCoverageEvidence(
  findingEvidence,
  coverageEvidence,
) {
  return normalizedTextIsExactOrContained(
    normalizeFindingEvidence(findingEvidence),
    normalizeFindingEvidence(coverageEvidence),
    16,
  );
}

function findingReferenceMatchesFullCoverageReference(findingReference, item) {
  const finding = normalizeRef(findingReference);
  return [item?.full_reference, item?.source_reference]
    .map(normalizeRef)
    .filter(Boolean)
    .some((reference) => normalizedTextIsExactOrContained(finding, reference));
}

function matchedRequirementReferenceMatchesItem(matchedReference, item) {
  const expected = normalizeRef(matchedReference);
  if (!expected) return false;
  return [item?.reference, item?.full_reference, item?.source_reference]
    .map(normalizeRef)
    .filter(Boolean)
    .some((reference) => reference === expected);
}

function sectionFindingIssue(finding, index) {
  const reference = normalizeInlineText(finding?.reference);
  if (!reference.toLowerCase().startsWith("seksjonsfunn:")) {
    return {
      code: "invalid_section_finding_reference",
      index,
      message: `Seksjonsfunn ${index + 1} må ha en eksplisitt "Seksjonsfunn:"-referanse.`,
    };
  }
  if (normalizeRef(finding?.matched_requirement_reference)) {
    return {
      code: "section_finding_has_requirement_reference",
      index,
      message: `Seksjonsfunn ${index + 1} kan ikke samtidig peke til en coverage-rad.`,
    };
  }

  const substantiveFields = [
    ["finding", finding?.finding, 24],
    ["evidence", finding?.evidence, 16],
    ["recommendation", finding?.recommendation, 24],
  ];
  const insufficientField = substantiveFields.find(
    ([, value, minimumLength]) =>
      normalizeFindingEvidence(value).length < minimumLength,
  );
  if (insufficientField) {
    return {
      code: "insubstantial_section_finding",
      index,
      field: insufficientField[0],
      message: `Seksjonsfunn ${index + 1} mangler et substansielt ${insufficientField[0]}-felt.`,
    };
  }
  if (finding?.evidence_grounding !== "document_exact") {
    return {
      code: "invalid_section_evidence_grounding",
      index,
      message: `Seksjonsfunn ${index + 1} mangler deterministisk document_exact-grounding.`,
    };
  }

  return null;
}

function analyzeDocumentFindingTraceability(documentFindings, coverage) {
  const findings = Array.isArray(documentFindings) ? documentFindings : null;
  const items = Array.isArray(coverage?.items) ? coverage.items : [];
  const issues = [];
  let coverageFindings = 0;
  let sectionFindings = 0;

  if (!findings) {
    issues.push({
      code: "missing_document_findings",
      message: "Vurderingen mangler document_findings-array.",
    });
  } else if (findings.length === 0) {
    issues.push({
      code: "empty_document_findings",
      message: "Vurderingen har ingen document_findings.",
    });
  }

  for (const [index, finding] of (findings ?? []).entries()) {
    if (finding?.reference_match === "section") {
      const issue = sectionFindingIssue(finding, index);
      if (issue) {
        issues.push(issue);
        continue;
      }
      sectionFindings += 1;
      continue;
    }
    if (finding?.reference_match !== "coverage") {
      issues.push({
        code: "invalid_finding_reference_match",
        index,
        message: `Finding ${index + 1} må være koblet til coverage eller section.`,
      });
      continue;
    }

    coverageFindings += 1;
    const matchedReference = normalizeRef(
      finding.matched_requirement_reference,
    );
    if (!matchedReference) {
      issues.push({
        code: "missing_matched_requirement_reference",
        index,
        message: `Coverage-finding ${index + 1} mangler matched_requirement_reference.`,
      });
      continue;
    }

    const matchedReferenceCandidates = items.filter((item) =>
      matchedRequirementReferenceMatchesItem(matchedReference, item),
    );
    if (matchedReferenceCandidates.length === 0) {
      issues.push({
        code: "matched_requirement_not_found",
        index,
        matchedRequirementReference: finding.matched_requirement_reference,
        message: `Coverage-finding ${index + 1} peker ikke til en eksisterende coverage-rad.`,
      });
      continue;
    }

    const fullReferenceCandidates = items.filter((item) =>
      findingReferenceMatchesFullCoverageReference(finding.reference, item),
    );
    let candidates = fullReferenceCandidates.length
      ? matchedReferenceCandidates.filter((item) =>
          fullReferenceCandidates.includes(item),
        )
      : matchedReferenceCandidates;

    if (candidates.length === 0) {
      issues.push({
        code: "finding_reference_conflicts_with_matched_requirement",
        index,
        matchedRequirementReference: finding.matched_requirement_reference,
        message: `Coverage-finding ${index + 1} har en full referanse som ikke samsvarer med matched_requirement_reference.`,
      });
      continue;
    }

    if (candidates.length > 1) {
      candidates = candidates.filter((item) =>
        findingEvidenceMatchesCoverageEvidence(
          finding.evidence,
          item?.evidence,
        ),
      );
    }

    if (candidates.length !== 1) {
      issues.push({
        code:
          candidates.length === 0
            ? "finding_evidence_does_not_disambiguate"
            : "ambiguous_matched_requirement_reference",
        index,
        matchedRequirementReference: finding.matched_requirement_reference,
        message: `Coverage-finding ${index + 1} kan ikke kobles entydig til én coverage-rad.`,
      });
      continue;
    }

    if (
      !findingEvidenceMatchesCoverageEvidence(
        finding.evidence,
        candidates[0]?.evidence,
      )
    ) {
      issues.push({
        code: "finding_evidence_mismatch",
        index,
        matchedRequirementReference: finding.matched_requirement_reference,
        message: `Evidence i coverage-finding ${index + 1} matcher ikke evidence i den koblede coverage-raden.`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    totalFindings: findings?.length ?? 0,
    coverageFindings,
    sectionFindings,
    issueCount: issues.length,
    issues,
  };
}

function normalizedGroundingText(value) {
  return normalizeInlineText(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\\\|/g, "|")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[*_`#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceIsGroundedInAnswer(evidence, artifactMarkdown) {
  const normalizedEvidence = normalizedGroundingText(evidence)
    .replace(/^[\s'"“”.,;:!?…()[\]{}<>]+/u, "")
    .replace(/[\s'"“”.,;:!?…()[\]{}<>]+$/u, "");
  const normalizedAnswer = normalizedGroundingText(artifactMarkdown);
  return (
    normalizedEvidence.length >= 16 &&
    normalizedAnswer.includes(normalizedEvidence)
  );
}

function markdownHeaderKey(value) {
  return normalizeComparable(value).replace(/[^a-z0-9æøå]+/gi, "");
}

function kravSvarArtifactContent(artifactMarkdown) {
  const lines = String(artifactMarkdown ?? "").split(/\r?\n/);
  const rows = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes("|")) continue;
    const headers = splitMarkdownTableRow(lines[index]);
    const headerKeys = headers.map(markdownHeaderKey);
    const referenceIndex = headerKeys.findIndex((key) =>
      ["kravref", "kravreferanse", "reference", "ref"].includes(key),
    );
    const answerIndex = headerKeys.findIndex((key) =>
      ["svar", "besvarelse", "answer", "response"].includes(key),
    );
    const answerEvidenceIndexes = headerKeys
      .map((key, cellIndex) =>
        [
          "svar",
          "besvarelse",
          "answer",
          "response",
          "svargrunnlag",
          "answerbasis",
          "evidence",
        ].includes(key)
          ? cellIndex
          : -1,
      )
      .filter((cellIndex) => cellIndex >= 0);
    const sourceIndex = headerKeys.findIndex((key) =>
      ["kildegrunnlag", "kilde", "source", "sourcereference"].includes(key),
    );
    if (referenceIndex < 0 || answerIndex < 0) continue;
    const separator = splitMarkdownTableRow(lines[index + 1]);
    if (
      separator.length < headers.length ||
      !separator
        .slice(0, headers.length)
        .every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
    ) {
      continue;
    }

    let rowIndex = index + 2;
    for (; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex];
      if (!line.trim() || !line.includes("|")) break;
      const cells = splitMarkdownTableRow(line);
      if (cells.length < headers.length) break;
      const reference = normalizeInlineText(cells[referenceIndex]);
      if (!reference) continue;
      const sourceLocator =
        sourceIndex >= 0 ? normalizeInlineText(cells[sourceIndex]) : "";
      rows.push({
        orderIndex: rows.length,
        reference,
        referenceKey: normalizeRef(reference),
        sourceLocator,
        rowText: answerEvidenceIndexes
          .map((cellIndex) => normalizeInlineText(cells[cellIndex]))
          .join(" "),
      });
    }
    index = rowIndex - 1;
  }
  return {
    rows,
    // Table lines are deliberately excluded: a requirement quoted in the
    // `Krav` column is source text, not evidence from the generated answer.
    answerBearingText: [
      ...rows.map((row) => row.rowText),
      ...lines.filter((line) => !line.includes("|")),
    ].join("\n"),
  };
}

function coverageOrderIndex(item) {
  return typeof item?.order_index === "number" &&
    Number.isSafeInteger(item.order_index) &&
    item.order_index >= 0
    ? item.order_index
    : null;
}

function coverageSimpleReferenceKeys(item) {
  return [
    ...new Set(
      [item?.reference, item?.table_id].map(normalizeRef).filter(Boolean),
    ),
  ];
}

function coverageLocatorKeys(item) {
  return [
    ...new Set(
      [item?.full_reference, item?.source_reference]
        .flatMap(groundingLocatorKeys)
        .filter(Boolean),
    ),
  ];
}

function groundingLocatorKeys(value) {
  const normalized = normalizedGroundingText(value);
  if (!normalized) return [];
  const withoutStandaloneRowCoordinates = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        !/^(?:rad|row)\s+\d+(?:\s*-\s*\d+)?$/u.test(part),
    )
    .join(", ");
  return [...new Set([normalized, withoutStandaloneRowCoordinates])];
}

function sourceLocatorMatchesCoverageItem(row, item) {
  const rowLocators = groundingLocatorKeys(row?.sourceLocator);
  const coverageLocators = coverageLocatorKeys(item);
  if (!rowLocators.length || !coverageLocators.length) return true;
  return coverageLocators.some((coverageLocator) =>
    rowLocators.some(
      (rowLocator) =>
        coverageLocator === rowLocator ||
        coverageLocator.includes(rowLocator) ||
        rowLocator.includes(coverageLocator),
    ),
  );
}

function artifactRowMatchesCoverageItem(row, item) {
  const orderIndex = coverageOrderIndex(item);
  return (
    orderIndex !== null &&
    row?.orderIndex === orderIndex &&
    coverageSimpleReferenceKeys(item).includes(row.referenceKey) &&
    sourceLocatorMatchesCoverageItem(row, item)
  );
}

function analyzeAnswerEvidenceGrounding({
  coverage,
  documentFindings,
  artifactMarkdown,
  expectedSolutionDocumentId,
}) {
  const issues = [];
  const items = Array.isArray(coverage?.items) ? coverage.items : [];
  const artifactContent = kravSvarArtifactContent(artifactMarkdown);
  const artifactRows = artifactContent.rows;
  const rowCandidates = artifactRows.map((row) =>
    items
      .map((item, itemIndex) =>
        artifactRowMatchesCoverageItem(row, item) ? itemIndex : null,
      )
      .filter((itemIndex) => itemIndex !== null),
  );
  const itemCandidateRows = items.map((item, itemIndex) =>
    artifactRows
      .map((row, rowIndex) =>
        artifactRowMatchesCoverageItem(row, item) &&
        rowCandidates[rowIndex].includes(itemIndex)
          ? rowIndex
          : null,
      )
      .filter((rowIndex) => rowIndex !== null),
  );

  for (const [rowIndex, candidates] of rowCandidates.entries()) {
    if (candidates.length === 0) {
      issues.push({
        code: "artifact_answer_row_not_in_coverage",
        rowIndex,
        reference: artifactRows[rowIndex].reference,
      });
    } else if (candidates.length > 1) {
      issues.push({
        code: "artifact_answer_row_ambiguous",
        rowIndex,
        reference: artifactRows[rowIndex].reference,
      });
    }
  }
  for (const [index, item] of items.entries()) {
    const candidateRowIndexes = itemCandidateRows[index];
    if (candidateRowIndexes.length === 0) {
      issues.push({
        code: "coverage_answer_row_not_found",
        index,
        reference: item.reference,
      });
    } else if (candidateRowIndexes.length > 1) {
      issues.push({
        code: "coverage_answer_row_ambiguous",
        index,
        reference: item.reference,
      });
    }
    if (item?.assessment !== "Godt") continue;
    if (
      !expectedSolutionDocumentId ||
      item.answer_document_id !== expectedSolutionDocumentId
    ) {
      issues.push({
        code: "good_coverage_wrong_answer_document",
        index,
        reference: item.reference,
      });
    }
    const matchedRows = candidateRowIndexes.map(
      (rowIndex) => artifactRows[rowIndex],
    );
    if (matchedRows.length !== 1) {
      issues.push({
        code: "good_coverage_answer_row_not_found",
        index,
        reference: item.reference,
      });
      continue;
    }
    if (
      !matchedRows.some((row) =>
        evidenceIsGroundedInAnswer(item.evidence, row.rowText),
      )
    ) {
      issues.push({
        code: "good_coverage_evidence_not_in_matching_answer_row",
        index,
        reference: item.reference,
      });
    }
  }
  for (const [index, finding] of (documentFindings ?? []).entries()) {
    if (
      !evidenceIsGroundedInAnswer(
        finding?.evidence,
        artifactContent.answerBearingText,
      )
    ) {
      issues.push({
        code: "finding_evidence_not_in_answer",
        index,
        reference: finding?.reference,
      });
    }
  }
  return {
    ok: issues.length === 0,
    issueCount: issues.length,
    artifactRowCount: artifactRows.length,
    issues,
  };
}

function substantiveText(value, minimumLength) {
  const text = normalizeInlineText(value);
  return (
    text.length >= minimumLength &&
    !/^(?:ok|n\/?a|ingen|ikke vurdert|ukjent|mangler)$/i.test(text)
  );
}

function substantiveArray(value, minimumItems, minimumLength = 24) {
  return (
    Array.isArray(value) &&
    value.length >= minimumItems &&
    value.every((item) => substantiveText(item, minimumLength))
  );
}

function analyzeHolisticEvaluation(evaluation) {
  const issues = [];
  const requireText = (field, value, minimumLength) => {
    if (!substantiveText(value, minimumLength)) issues.push(field);
  };
  const requireArray = (field, value, minimumItems, minimumLength = 24) => {
    if (!substantiveArray(value, minimumItems, minimumLength))
      issues.push(field);
  };
  if (!evaluation || typeof evaluation !== "object") {
    return { ok: false, issueCount: 1, issues: ["missing_evaluation"] };
  }
  requireText("fit_to_customer_needs", evaluation.fit_to_customer_needs, 60);
  requireText("executive_summary", evaluation.executive_summary, 80);
  requireArray("strengths", evaluation.strengths, 2);
  requireArray("weaknesses", evaluation.weaknesses, 1);
  requireArray("risks_to_customer", evaluation.risks_to_customer, 1);
  requireArray(
    "improvement_recommendations",
    evaluation.improvement_recommendations,
    2,
  );
  requireText(
    "likely_score_assessment.quality",
    evaluation.likely_score_assessment?.quality,
    12,
  );
  requireText(
    "likely_score_assessment.delivery_confidence",
    evaluation.likely_score_assessment?.delivery_confidence,
    12,
  );
  requireText(
    "likely_score_assessment.risk",
    evaluation.likely_score_assessment?.risk,
    12,
  );
  requireText(
    "likely_score_assessment.competitiveness",
    evaluation.likely_score_assessment?.competitiveness,
    12,
  );
  requireText(
    "requirement_coverage.coverage_summary",
    evaluation.requirement_coverage?.coverage_summary,
    40,
  );

  const comparison = evaluation.architecture_comparison;
  const architectScore = Number(comparison?.architect_solution_score);
  const systemScore = Number(comparison?.system_solution_score);
  if (
    !Number.isFinite(architectScore) ||
    architectScore < 0 ||
    architectScore > 100 ||
    !Number.isFinite(systemScore) ||
    systemScore < 0 ||
    systemScore > 100
  ) {
    issues.push("architecture_comparison.scores");
  } else {
    const expectedWinner =
      architectScore === systemScore
        ? "Uavgjort"
        : architectScore > systemScore
          ? "Arkitektløsning"
          : "Systemløsning";
    if (comparison?.winner !== expectedWinner) {
      issues.push("architecture_comparison.winner");
    }
  }
  requireText("architecture_comparison.verdict", comparison?.verdict, 50);
  requireArray(
    "architecture_comparison.strong_critique",
    comparison?.strong_critique,
    1,
  );
  requireArray(
    "architecture_comparison.pragmatic_reflections",
    comparison?.pragmatic_reflections,
    1,
  );
  requireArray(
    "architecture_comparison.strategy_improvement_advice",
    comparison?.strategy_improvement_advice,
    1,
  );

  return { ok: issues.length === 0, issueCount: issues.length, issues };
}

function scoreProject({
  sourceCount,
  coverage,
  integrity,
  fasitComparison,
  requirementResponseMetadata,
  bilag1Fallback,
  documentFindings,
  evaluation,
  artifactMarkdown,
  oracleComparison,
  expectedSolutionDocumentId,
}) {
  const items = Array.isArray(coverage?.items) ? coverage.items : [];
  const coverageRatio =
    sourceCount > 0
      ? Math.min(
          1,
          Math.min(
            coverage?.total_requirements ?? 0,
            coverage?.assessed_requirements ?? 0,
            items.length,
          ) / sourceCount,
        )
      : 0;
  const referenceRatio = items.length
    ? items.filter(
        (item) =>
          normalizeInlineText(item.reference) ||
          normalizeInlineText(item.full_reference) ||
          normalizeInlineText(item.source_reference),
      ).length / items.length
    : 0;
  const subtitleRatio = items.length
    ? items.filter(
        (item) =>
          normalizeInlineText(item.requirement_subtitle).length >= 4 ||
          normalizeInlineText(item.table_id).length >= 2,
      ).length / items.length
    : 0;
  const actionableRatio = items.length
    ? items.filter((item) =>
        ["rationale", "evidence", "recommendation"].every((field) => {
          const text = normalizeInlineText(item[field]);
          return text.length >= 24 && !/^(ok|n\/a|ikke vurdert)$/i.test(text);
        }),
      ).length / items.length
    : 0;
  const assessmentCounts = items.reduce(
    (counts, item) => {
      if (item.assessment === "Godt") counts.good += 1;
      else if (item.assessment === "Dårlig") counts.weak += 1;
      else if (item.assessment === "Mangler") counts.missing += 1;
      else if (item.assessment === "Uklart") counts.unclear += 1;
      return counts;
    },
    { good: 0, weak: 0, missing: 0, unclear: 0 },
  );
  const goodRatio = items.length ? assessmentCounts.good / items.length : 0;
  const integrityPoints = integrity.ok
    ? 20
    : Math.max(0, 20 - integrity.issueCount * 2);
  const integrityRatio = integrityPoints / 20;
  const fasitRatio = fasitComparison
    ? Math.min(
        1,
        (fasitComparison.unorderedMatched /
          Math.max(1, fasitComparison.expectedCount) +
          (fasitComparison.idComparable
            ? fasitComparison.idMatched / fasitComparison.idComparable
            : 1) +
          (fasitComparison.headingComparable
            ? fasitComparison.headingMatched / fasitComparison.headingComparable
            : 1)) /
          3,
      )
    : 1;

  const completeCoverage =
    sourceCount > 0 &&
    integrity.ok &&
    coverage?.total_requirements === sourceCount &&
    coverage?.assessed_requirements === sourceCount &&
    items.length === sourceCount;
  const exactFasit = fasitComparison
    ? fasitComparison.expectedCount === fasitComparison.actualCount &&
      fasitComparison.unorderedMatched === fasitComparison.expectedCount &&
      fasitComparison.orderedMatched === fasitComparison.expectedCount &&
      (fasitComparison.mismatchCount ?? 0) === 0 &&
      (!fasitComparison.idComparable ||
        fasitComparison.idMatched === fasitComparison.idComparable) &&
      (!fasitComparison.headingComparable ||
        fasitComparison.headingMatched === fasitComparison.headingComparable) &&
      (fasitComparison.sourceIssueCount ?? 0) === 0
    : oracleComparison?.ok === true;
  const assessmentCountsConsistent =
    coverage?.good === assessmentCounts.good &&
    coverage?.weak === assessmentCounts.weak &&
    coverage?.missing === assessmentCounts.missing &&
    coverage?.unclear === assessmentCounts.unclear;
  const metadataMethod = requirementResponseMetadata?.method;
  const metadataTotal = requirementResponseMetadata?.total_requirements;
  const metadataBatchCount = requirementResponseMetadata?.batch_count;
  const metadataFailedBatches = requirementResponseMetadata?.failed_batches;
  const metadataFallbackAfterHandoff =
    requirementResponseMetadata?.deterministic_fallback_answers_after_handoff;
  const metadataUnresolvedFallbacks =
    requirementResponseMetadata?.unresolved_fallback_answers;
  const metadataTemplateRepairCount =
    requirementResponseMetadata?.deterministic_template_repair_answers;
  const metadataTemplateRepairRefs =
    requirementResponseMetadata?.deterministic_template_repair_refs;
  const metadataTemplateRepairRows =
    requirementResponseMetadata?.deterministic_template_repair_rows;
  const metadataControlRepairCount =
    requirementResponseMetadata?.deterministic_control_repair_answers;
  const metadataControlRepairRefs =
    requirementResponseMetadata?.deterministic_control_repair_refs;
  const metadataControlRepairRows =
    requirementResponseMetadata?.deterministic_control_repair_rows;
  const metadataProposalInputCount =
    requirementResponseMetadata?.proposal_input_required_count;
  const metadataProposalInputRefs =
    requirementResponseMetadata?.proposal_input_required_refs;
  const metadataProposalInputRows =
    requirementResponseMetadata?.proposal_input_required_rows;
  const metadataManualReviewRequired =
    requirementResponseMetadata?.manual_review_required;
  const metadataManualReviewNote =
    requirementResponseMetadata?.manual_review_note;
  const metadataRequirementRefs = requirementResponseMetadata?.requirement_refs;
  const metadataImmutableManifest =
    requirementResponseMetadata?.immutable_row_manifest;
  const hasMetadataField = (field) =>
    requirementResponseMetadata &&
    typeof requirementResponseMetadata === "object" &&
    Object.prototype.hasOwnProperty.call(requirementResponseMetadata, field);
  const hasRequiredMetadataFields = [
    "method",
    "total_requirements",
    "batch_count",
    "failed_batches",
    "deterministic_fallback_answers_after_handoff",
    "deterministic_template_repair_answers",
    "deterministic_template_repair_refs",
    "deterministic_template_repair_rows",
    "deterministic_control_repair_answers",
    "deterministic_control_repair_refs",
    "deterministic_control_repair_rows",
    "proposal_input_required_count",
    "proposal_input_required_refs",
    "proposal_input_required_rows",
    "manual_review_required",
    "unresolved_fallback_answers",
    "coverage_enforced",
    "source_evidence_enforced",
    "requirement_refs",
    "immutable_row_manifest",
  ].every(hasMetadataField);
  const normalizedMetadataRefs = Array.isArray(metadataRequirementRefs)
    ? metadataRequirementRefs.map(normalizeRef).filter(Boolean)
    : [];
  const normalizedTemplateRepairRefs = Array.isArray(metadataTemplateRepairRefs)
    ? metadataTemplateRepairRefs.map(normalizeRef).filter(Boolean)
    : [];
  const normalizedControlRepairRefs = Array.isArray(metadataControlRepairRefs)
    ? metadataControlRepairRefs.map(normalizeRef).filter(Boolean)
    : [];
  const normalizedProposalInputRefs = Array.isArray(metadataProposalInputRefs)
    ? metadataProposalInputRefs.map(normalizeRef).filter(Boolean)
    : [];
  const metadataRefSet = new Set(normalizedMetadataRefs);
  const immutableManifestRows = Array.isArray(metadataImmutableManifest?.rows)
    ? metadataImmutableManifest.rows
    : [];
  const immutableRowManifest =
    metadataImmutableManifest?.version === 1 &&
    /^[0-9a-f]{64}$/i.test(metadataImmutableManifest?.manifest_sha256 ?? "") &&
    immutableManifestRows.length === sourceCount &&
    immutableManifestRows.every(
      (row, index) =>
        row?.order_index === index &&
        normalizeRef(row?.ref) === normalizedMetadataRefs[index] &&
        normalizeInlineText(row?.requirement_text_normalized).length >= 1 &&
        normalizeInlineText(row?.source_locator).length >= 1 &&
        normalizeInlineText(row?.source_document_id).length >= 1 &&
        /^[0-9a-f]{64}$/i.test(row?.row_sha256 ?? ""),
    );
  const templateRepairMetadata =
    Number.isInteger(metadataTemplateRepairCount) &&
    metadataTemplateRepairCount >= 0 &&
    metadataTemplateRepairCount <= sourceCount &&
    Array.isArray(metadataTemplateRepairRefs) &&
    metadataTemplateRepairRefs.length === metadataTemplateRepairCount &&
    metadataTemplateRepairRefs.every(
      (reference) => typeof reference === "string" && normalizeRef(reference),
    ) &&
    normalizedTemplateRepairRefs.length === metadataTemplateRepairCount &&
    normalizedTemplateRepairRefs.every((reference) =>
      metadataRefSet.has(reference),
    ) &&
    Array.isArray(metadataTemplateRepairRows) &&
    metadataTemplateRepairRows.length === metadataTemplateRepairCount &&
    metadataTemplateRepairRows.every(
      (row, index) =>
        normalizeRef(row?.ref) === normalizedTemplateRepairRefs[index] &&
        Number.isSafeInteger(row?.order_index) &&
        row.order_index >= 0 &&
        row.order_index < sourceCount &&
        normalizeRef(items[row.order_index]?.reference) ===
          normalizedTemplateRepairRefs[index] &&
        typeof row?.source_document_id === "string" &&
        normalizeInlineText(row.source_document_id).length > 0 &&
        typeof row?.source_locator === "string" &&
        normalizeInlineText(row.source_locator).length > 0,
    );
  const controlRepairMetadata =
    Number.isInteger(metadataControlRepairCount) &&
    metadataControlRepairCount >= 0 &&
    metadataControlRepairCount <= sourceCount &&
    Array.isArray(metadataControlRepairRefs) &&
    metadataControlRepairRefs.length === metadataControlRepairCount &&
    normalizedControlRepairRefs.length === metadataControlRepairCount &&
    normalizedControlRepairRefs.every((reference) =>
      metadataRefSet.has(reference),
    ) &&
    Array.isArray(metadataControlRepairRows) &&
    metadataControlRepairRows.length === metadataControlRepairCount &&
    metadataControlRepairRows.every(
      (row, index) =>
        normalizeRef(row?.ref) === normalizedControlRepairRefs[index] &&
        typeof row?.pattern === "string" &&
        normalizeInlineText(row.pattern).length > 0 &&
        Number.isSafeInteger(row?.order_index) &&
        row.order_index >= 0 &&
        row.order_index < sourceCount &&
        normalizeRef(items[row.order_index]?.reference) ===
          normalizedControlRepairRefs[index] &&
        typeof row?.source_document_id === "string" &&
        normalizeInlineText(row.source_document_id).length > 0 &&
        typeof row?.source_locator === "string" &&
        normalizeInlineText(row.source_locator).length > 0,
    );
  const proposalInputMetadata =
    Number.isInteger(metadataProposalInputCount) &&
    metadataProposalInputCount >= 0 &&
    metadataProposalInputCount <= sourceCount &&
    Array.isArray(metadataProposalInputRefs) &&
    metadataProposalInputRefs.length === metadataProposalInputCount &&
    normalizedProposalInputRefs.length === metadataProposalInputCount &&
    normalizedProposalInputRefs.every((reference) =>
      metadataRefSet.has(reference),
    ) &&
    Array.isArray(metadataProposalInputRows) &&
    metadataProposalInputRows.length === metadataProposalInputCount &&
    metadataProposalInputRows.every(
      (row, index) =>
        normalizeRef(row?.ref) === normalizedProposalInputRefs[index] &&
        Array.isArray(row?.reasons) &&
        row.reasons.length > 0 &&
        row.reasons.every(
          (reason) =>
            typeof reason === "string" && normalizeInlineText(reason),
        ) &&
        Number.isSafeInteger(row?.order_index) &&
        row.order_index >= 0 &&
        row.order_index < sourceCount &&
        normalizeRef(items[row.order_index]?.reference) ===
          normalizedProposalInputRefs[index] &&
        typeof row?.source_document_id === "string" &&
        normalizeInlineText(row.source_document_id).length > 0 &&
        typeof row?.source_locator === "string" &&
        normalizeInlineText(row.source_locator).length > 0,
    );
  const expectedManualReviewRequired =
    metadataTemplateRepairCount > 0 ||
    metadataControlRepairCount > 0 ||
    metadataProposalInputCount > 0;
  const manualReviewMetadata =
    typeof metadataManualReviewRequired === "boolean" &&
    metadataManualReviewRequired === expectedManualReviewRequired &&
    (!expectedManualReviewRequired ||
      (typeof metadataManualReviewNote === "string" &&
        /manuell gjennomgang|leverandørbevis|tilbudsvalg|kommersielle vilkår/i.test(
          metadataManualReviewNote,
        )));
  const repairCoverageRowsAreUnambiguous = [
    ...(metadataTemplateRepairRows ?? []),
    ...(metadataControlRepairRows ?? []),
  ].every(
    (row) =>
      Number.isSafeInteger(row?.order_index) &&
      normalizeRef(items[row.order_index]?.reference) === normalizeRef(row?.ref),
  );
  const repairRefSet = new Set([
    ...normalizedTemplateRepairRefs,
    ...normalizedControlRepairRefs,
  ]);
  const nonGoodRowsAreExplicitRepairReviews = items.every((item) => {
    if (item.assessment === "Godt") return true;
    return (
      item.assessment === "Uklart" &&
      repairRefSet.has(normalizeRef(item.reference))
    );
  });
  const strongAssessment =
    goodRatio === 1 &&
    assessmentCounts.weak === 0 &&
    assessmentCounts.missing === 0 &&
    assessmentCounts.unclear === 0 &&
    metadataTemplateRepairCount === 0 &&
    metadataControlRepairCount === 0 &&
    metadataManualReviewRequired === false &&
    repairCoverageRowsAreUnambiguous &&
    nonGoodRowsAreExplicitRepairReviews;
  const kravSvarMetadata =
    hasRequiredMetadataFields &&
    immutableRowManifest &&
    templateRepairMetadata &&
    controlRepairMetadata &&
    proposalInputMetadata &&
    manualReviewMetadata &&
    metadataMethod === "ledger_batch" &&
    Number.isInteger(metadataTotal) &&
    metadataTotal === sourceCount &&
    Number.isInteger(metadataBatchCount) &&
    metadataBatchCount > 0 &&
    Number.isInteger(metadataFailedBatches) &&
    metadataFailedBatches === 0 &&
    requirementResponseMetadata?.coverage_enforced === true &&
    requirementResponseMetadata?.source_evidence_enforced === true &&
    Array.isArray(metadataRequirementRefs) &&
    metadataRequirementRefs.length === sourceCount &&
    metadataRequirementRefs.every(
      (reference) => typeof reference === "string",
    ) &&
    normalizedMetadataRefs.length === sourceCount;
  const noFallbacks =
    !bilag1Fallback &&
    hasRequiredMetadataFields &&
    Number.isInteger(metadataFallbackAfterHandoff) &&
    metadataFallbackAfterHandoff === 0 &&
    Array.isArray(metadataUnresolvedFallbacks) &&
    metadataUnresolvedFallbacks.length === 0;
  const documentFindingTraceability = analyzeDocumentFindingTraceability(
    documentFindings,
    coverage,
  );
  const answerEvidenceGrounding = analyzeAnswerEvidenceGrounding({
    coverage,
    documentFindings,
    artifactMarkdown,
    expectedSolutionDocumentId,
  });
  const holisticEvaluation = analyzeHolisticEvaluation(evaluation);

  const score = Math.round(
    coverageRatio * 20 +
      referenceRatio * 10 +
      subtitleRatio * 5 +
      actionableRatio * 15 +
      integrityPoints +
      fasitRatio * 10 +
      goodRatio * 20,
  );

  const boundedScore = Math.max(0, Math.min(100, score));
  const acceptance = {
    completeCoverage,
    exactFasit,
    independentOracle:
      Boolean(fasitComparison) || oracleComparison?.ok === true,
    strongAssessment,
    assessmentCountsConsistent,
    actionable: actionableRatio === 1,
    traceable: referenceRatio === 1 && subtitleRatio === 1,
    kravSvarMetadata,
    immutableRowManifest,
    templateRepairMetadata,
    controlRepairMetadata,
    proposalInputMetadata,
    manualReviewMetadata,
    noFallbacks,
    documentFindingTraceability: documentFindingTraceability.ok,
    answerEvidenceGrounded: answerEvidenceGrounding.ok,
    artifactRowsExact: answerEvidenceGrounding.artifactRowCount === sourceCount,
    holisticEvaluation: holisticEvaluation.ok,
    noManualReview: metadataManualReviewRequired === false,
    strongScore: boundedScore === 100,
  };
  acceptance.passed = Object.values(acceptance).every(Boolean);

  return {
    score: boundedScore,
    components: {
      coverageRatio,
      referenceRatio,
      subtitleRatio,
      actionableRatio,
      goodRatio,
      integrityRatio,
      fasitRatio,
    },
    acceptance,
    documentFindingTraceability,
    answerEvidenceGrounding,
    holisticEvaluation,
  };
}

function scoreBand(score, acceptance) {
  if (score === 100 && acceptance?.passed) return "Strong";
  if (score >= 85) return "Usable";
  if (score >= 75) return "Needs review";
  return "Not ready";
}

const STRICT_SCORE_COMPONENT_FIELDS = [
  "coverageRatio",
  "referenceRatio",
  "subtitleRatio",
  "actionableRatio",
  "goodRatio",
  "integrityRatio",
  "fasitRatio",
];

const STRICT_ACCEPTANCE_FIELDS = [
  "completeCoverage",
  "exactFasit",
  "independentOracle",
  "strongAssessment",
  "assessmentCountsConsistent",
  "actionable",
  "traceable",
  "kravSvarMetadata",
  "immutableRowManifest",
  "templateRepairMetadata",
  "controlRepairMetadata",
  "proposalInputMetadata",
  "manualReviewMetadata",
  "noFallbacks",
  "documentFindingTraceability",
  "answerEvidenceGrounded",
  "artifactRowsExact",
  "holisticEvaluation",
  "noManualReview",
  "strongScore",
  "passed",
];

function strictProjectGate(project, { requireDeclaredOk = true } = {}) {
  const issues = [];
  const requireCondition = (condition, issue) => {
    if (!condition) issues.push(issue);
  };
  const canonicalCount = project?.canonicalRequirementCount;
  const sourceCount = project?.sourceRequirementCount;
  const bilag2Count = project?.bilag2RequirementCount;

  requireCondition(
    Number.isInteger(canonicalCount) && canonicalCount > 0,
    "canonical_requirement_count",
  );
  requireCondition(
    Number.isInteger(sourceCount) && sourceCount === canonicalCount,
    "source_requirement_count",
  );
  requireCondition(
    Number.isInteger(bilag2Count) &&
      bilag2Count > 0 &&
      bilag2Count <= canonicalCount,
    "bilag2_requirement_count",
  );

  const coverage = project?.coverage;
  for (const field of [
    "total_requirements",
    "assessed_requirements",
    "itemCount",
    "good",
  ]) {
    requireCondition(
      coverage?.[field] === canonicalCount,
      `coverage.${field}`,
    );
  }
  for (const field of ["weak", "missing", "unclear", "missingSubtitles"]) {
    requireCondition(coverage?.[field] === 0, `coverage.${field}`);
  }

  requireCondition(project?.score === 100, "score");
  requireCondition(project?.scoreBand === "Strong", "score_band");
  for (const field of STRICT_SCORE_COMPONENT_FIELDS) {
    requireCondition(
      project?.scoreComponents?.[field] === 1,
      `score_components.${field}`,
    );
  }

  const integrity = project?.integrity;
  requireCondition(integrity?.ok === true, "integrity.ok");
  requireCondition(
    integrity?.sourceCount === canonicalCount,
    "integrity.source_count",
  );
  requireCondition(
    integrity?.itemCount === canonicalCount,
    "integrity.item_count",
  );
  requireCondition(integrity?.issueCount === 0, "integrity.issue_count");
  requireCondition(
    Array.isArray(integrity?.issues) && integrity.issues.length === 0,
    "integrity.issues",
  );

  const fasit = project?.fasitComparison;
  const oracle = project?.requirementOracle;
  const hasFasit = Boolean(fasit && typeof fasit === "object");
  const hasOracle = Boolean(oracle && typeof oracle === "object");
  requireCondition(hasFasit !== hasOracle, "reference_gate_mode");
  if (hasFasit) {
    requireCondition(
      fasit.expectedCount === bilag2Count,
      "fasit.expected_count",
    );
    requireCondition(fasit.actualCount === bilag2Count, "fasit.actual_count");
    requireCondition(
      fasit.unorderedMatched === bilag2Count,
      "fasit.unordered_matched",
    );
    requireCondition(
      fasit.orderedMatched === bilag2Count,
      "fasit.ordered_matched",
    );
    requireCondition(fasit.mismatchCount === 0, "fasit.mismatch_count");
    requireCondition(fasit.sourceIssueCount === 0, "fasit.source_issue_count");
    requireCondition(
      Number.isInteger(fasit.idComparable) &&
        fasit.idMatched === fasit.idComparable,
      "fasit.id_matched",
    );
    requireCondition(
      Number.isInteger(fasit.headingComparable) &&
        fasit.headingMatched === fasit.headingComparable,
      "fasit.heading_matched",
    );
    requireCondition(
      Array.isArray(fasit.mismatches) && fasit.mismatches.length === 0,
      "fasit.mismatches",
    );
    requireCondition(
      Array.isArray(fasit.sourceIssues) && fasit.sourceIssues.length === 0,
      "fasit.source_issues",
    );
  }
  if (hasOracle) {
    requireCondition(
      normalizeInlineText(oracle.version).length > 0,
      "oracle.version",
    );
    requireCondition(oracle.ok === true, "oracle.ok");
    requireCondition(
      oracle.expectedCount === bilag2Count,
      "oracle.expected_count",
    );
    requireCondition(oracle.actualCount === bilag2Count, "oracle.actual_count");
    requireCondition(
      oracle.orderedIdsMatch === true,
      "oracle.ordered_ids_match",
    );
    requireCondition(
      Array.isArray(oracle.missingOrChangedAnchors) &&
        oracle.missingOrChangedAnchors.length === 0,
      "oracle.missing_or_changed_anchors",
    );
  }

  const findingTraceability = project?.documentFindingTraceability;
  requireCondition(
    findingTraceability?.ok === true,
    "document_finding_traceability.ok",
  );
  requireCondition(
    findingTraceability?.issueCount === 0,
    "document_finding_traceability.issue_count",
  );
  requireCondition(
    Number.isInteger(findingTraceability?.totalFindings) &&
      findingTraceability.totalFindings > 0 &&
      Number.isInteger(findingTraceability.coverageFindings) &&
      Number.isInteger(findingTraceability.sectionFindings) &&
      findingTraceability.coverageFindings +
        findingTraceability.sectionFindings ===
        findingTraceability.totalFindings,
    "document_finding_traceability.counts",
  );
  requireCondition(
    Array.isArray(findingTraceability?.issues) &&
      findingTraceability.issues.length === 0,
    "document_finding_traceability.issues",
  );

  const grounding = project?.answerEvidenceGrounding;
  requireCondition(grounding?.ok === true, "answer_evidence_grounding.ok");
  requireCondition(
    grounding?.issueCount === 0,
    "answer_evidence_grounding.issue_count",
  );
  requireCondition(
    grounding?.artifactRowCount === canonicalCount,
    "answer_evidence_grounding.artifact_row_count",
  );
  requireCondition(
    Array.isArray(grounding?.issues) && grounding.issues.length === 0,
    "answer_evidence_grounding.issues",
  );

  const holistic = project?.holisticEvaluation;
  requireCondition(holistic?.ok === true, "holistic_evaluation.ok");
  requireCondition(
    holistic?.issueCount === 0,
    "holistic_evaluation.issue_count",
  );
  requireCondition(
    Array.isArray(holistic?.issues) && holistic.issues.length === 0,
    "holistic_evaluation.issues",
  );

  const acceptance = project?.acceptance;
  for (const field of STRICT_ACCEPTANCE_FIELDS) {
    requireCondition(acceptance?.[field] === true, `acceptance.${field}`);
  }
  for (const [field, value] of Object.entries(acceptance ?? {})) {
    if (!STRICT_ACCEPTANCE_FIELDS.includes(field)) {
      requireCondition(value === true, `acceptance.${field}`);
    }
  }
  if (requireDeclaredOk) {
    requireCondition(project?.ok === true, "declared_ok");
  }

  return { passed: issues.length === 0, issues };
}

// A technically correct evaluator must be allowed to report real proposal
// weaknesses. Keep strictProjectGate as the all-Godt proposal-readiness gate,
// while this gate verifies the pipeline invariants without rewarding invented
// supplier evidence merely to obtain a perfect proposal score.
const PIPELINE_GATE_PROPOSAL_ONLY_ISSUES = new Set([
  "coverage.good",
  "coverage.weak",
  "coverage.unclear",
  "score",
  "score_band",
  "score_components.goodRatio",
  "acceptance.strongAssessment",
  "acceptance.strongScore",
  "acceptance.passed",
  "acceptance.noManualReview",
  "declared_ok",
]);

function technicalProjectGate(project) {
  const strict = strictProjectGate(project, { requireDeclaredOk: false });
  const issues = strict.issues.filter(
    (issue) => !PIPELINE_GATE_PROPOSAL_ONLY_ISSUES.has(issue),
  );
  return { passed: issues.length === 0, issues };
}

function shardStopReason(project, acceptanceMode = "proposal") {
  if (project?.error) {
    return {
      kind: "execution",
      issues: [normalizeInlineText(project.error) || "project_execution_failed"],
    };
  }
  const gate =
    acceptanceMode === "pipeline"
      ? technicalProjectGate(project)
      : strictProjectGate(project);
  return gate.passed
    ? null
    : {
        kind: "acceptance",
        issues: [...gate.issues],
      };
}

function telemetryEventsFromLog(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const telemetryEventNames = new Set([
    "ai_json_completion_started",
    "ai_json_completion_timing",
    "ai_json_completion_failed",
    "ai_json_file_input_completion_started",
    "ai_json_file_input_completion_timing",
    "ai_json_file_input_completion_failed",
  ]);
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => {
      const jsonStart = line.indexOf("{");
      if (jsonStart < 0) return null;
      try {
        const event = JSON.parse(line.slice(jsonStart));
        return telemetryEventNames.has(event.event) ? event : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeTelemetryAttempts(events) {
  const correlated = new Map();
  const legacy = [];

  for (const event of events) {
    const eventName = String(event?.event ?? "");
    const isCompletion =
      eventName === "ai_json_completion_timing" ||
      eventName === "ai_json_file_input_completion_timing";
    const isFailure =
      eventName === "ai_json_completion_failed" ||
      eventName === "ai_json_file_input_completion_failed";
    const isStart =
      eventName === "ai_json_completion_started" ||
      eventName === "ai_json_file_input_completion_started";
    if (!isCompletion && !isFailure && !isStart) continue;

    const requestId =
      typeof event.request_id === "string" && event.request_id.trim()
        ? event.request_id.trim()
        : "";
    const eventState = {
      ...event,
      fileInput: eventName.includes("file_input"),
      completed: isCompletion,
      failed: isFailure,
      started: isStart,
    };
    if (!requestId) {
      if (isCompletion) legacy.push(eventState);
      continue;
    }

    const current = correlated.get(requestId) ?? {
      request_id: requestId,
      completed: false,
      failed: false,
      started: false,
      fileInput: false,
    };
    correlated.set(requestId, {
      ...current,
      ...event,
      request_id: requestId,
      fileInput: current.fileInput || eventState.fileInput,
      completed: current.completed || isCompletion,
      failed: current.failed || isFailure,
      started: current.started || isStart,
    });
  }

  return [...correlated.values(), ...legacy];
}

function summarizeTelemetry(events) {
  const attempts = normalizeTelemetryAttempts(events);
  const byModel = new Map();
  let usageEventCount = 0;
  let completedRequestCount = 0;
  let failedRequestCount = 0;
  for (const event of attempts) {
    const model = event.model || "unknown";
    const existing = byModel.get(model) ?? {
      model,
      requests: 0,
      systemChars: 0,
      userChars: 0,
      durationMs: 0,
      fileInputRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      usageEvents: 0,
      unknownCostInvocations: 0,
      billingInputTokens: 0,
      billingOutputTokens: 0,
    };
    existing.requests += 1;
    existing.systemChars += Number(event.system_chars ?? 0);
    existing.userChars += Number(event.user_chars ?? 0);
    existing.durationMs += Number(event.duration_ms ?? 0);
    const hasInputUsage =
      typeof event.input_tokens === "number" &&
      Number.isFinite(event.input_tokens);
    const hasOutputUsage =
      typeof event.output_tokens === "number" &&
      Number.isFinite(event.output_tokens);
    const hasTotalUsage =
      typeof event.total_tokens === "number" &&
      Number.isFinite(event.total_tokens);
    const inputTokens = hasInputUsage
      ? Math.max(0, Math.round(event.input_tokens))
      : 0;
    const outputTokens = hasOutputUsage
      ? Math.max(0, Math.round(event.output_tokens))
      : 0;
    const totalTokens = hasTotalUsage
      ? Math.max(0, Math.round(event.total_tokens))
      : inputTokens + outputTokens;
    const estimatedEventInputTokens = Math.ceil(
      (Number(event.system_chars ?? 0) + Number(event.user_chars ?? 0)) / 4,
    );
    const estimatedEventOutputTokens = 900;
    existing.billingInputTokens +=
      hasInputUsage ? inputTokens : estimatedEventInputTokens;
    existing.billingOutputTokens +=
      hasOutputUsage ? outputTokens : estimatedEventOutputTokens;
    const hasUsage = hasInputUsage && hasOutputUsage;
    if (hasUsage) {
      usageEventCount += 1;
      existing.usageEvents += 1;
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.totalTokens += totalTokens;
      existing.cachedInputTokens += Number(event.cached_input_tokens ?? 0);
    }
    if (event.completed) completedRequestCount += 1;
    if (event.failed) failedRequestCount += 1;
    if (event.fileInput) {
      existing.fileInputRequests += 1;
      if (!hasUsage) existing.unknownCostInvocations += 1;
    }
    byModel.set(model, existing);
  }

  const models = [...byModel.values()].map((item) => {
    const estimatedInputTokens = Math.ceil(
      (item.systemChars + item.userChars) / 4,
    );
    const estimatedOutputTokens = item.requests * 900;
    return {
      ...item,
      estimatedInputTokens,
      estimatedOutputTokens,
    };
  });
  const totalRequests = models.reduce((sum, item) => sum + item.requests, 0);
  const incompleteRequestCount = Math.max(
    0,
    totalRequests - completedRequestCount - failedRequestCount,
  );
  const exactUsageAvailable =
    totalRequests > 0 &&
    incompleteRequestCount === 0 &&
    usageEventCount === totalRequests;
  const usageBasis = exactUsageAvailable
    ? "exact"
    : usageEventCount > 0
      ? "mixed"
      : "estimated";
  const unknownCostInvocationCount = models.reduce(
    (sum, item) => sum + item.unknownCostInvocations,
    0,
  );

  return {
    exactUsageAvailable,
    usageBasis,
    totalRequests,
    completedRequestCount,
    failedRequestCount,
    incompleteRequestCount,
    unknownCostInvocationCount,
    usageEventCount,
    inputTokens: models.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: models.reduce((sum, item) => sum + item.outputTokens, 0),
    totalTokens: models.reduce((sum, item) => sum + item.totalTokens, 0),
    cachedInputTokens: models.reduce(
      (sum, item) => sum + item.cachedInputTokens,
      0,
    ),
    estimatedInputTokens: models.reduce(
      (sum, item) => sum + item.estimatedInputTokens,
      0,
    ),
    estimatedOutputTokens: models.reduce(
      (sum, item) => sum + item.estimatedOutputTokens,
      0,
    ),
    note: exactUsageAvailable
      ? "Every observed JSON invocation has a terminal event with finite SDK input/output usage fields. Embedding requests are not counted because the request was for chat calls."
      : `Usage is incomplete: requests without SDK usage, including failed or unconfirmed attempts, use prompt character estimates plus 900 output tokens. Cost remains approximate and can differ from provider billing.${unknownCostInvocationCount > 0 ? ` ${unknownCostInvocationCount} file-input invocation(s) lack provider usage, so their file-processing cost is unknown and the estimate is only a known-text lower bound plus the generic output allowance.` : ""} Embedding requests are not counted because the request was for chat calls.`,
    byModel: models,
  };
}

function approximateCost(telemetry) {
  const miniInput = Number(
    process.env.VURDERING_MINI_INPUT_PER_MTOK_USD ?? 0.5,
  );
  const miniOutput = Number(
    process.env.VURDERING_MINI_OUTPUT_PER_MTOK_USD ?? 2,
  );
  const defaultInput = Number(process.env.VURDERING_INPUT_PER_MTOK_USD ?? 5);
  const defaultOutput = Number(process.env.VURDERING_OUTPUT_PER_MTOK_USD ?? 15);
  let total = 0;
  const byModel = telemetry.byModel.map((item) => {
    const isMini = /mini|nano/i.test(item.model);
    const inputRate = isMini ? miniInput : defaultInput;
    const outputRate = isMini ? miniOutput : defaultOutput;
    const cost =
      (item.billingInputTokens / 1_000_000) * inputRate +
      (item.billingOutputTokens / 1_000_000) * outputRate;
    total += cost;
    return {
      model: item.model,
      estimatedCostUsd: Number(cost.toFixed(2)),
      inputTokens: item.billingInputTokens,
      outputTokens: item.billingOutputTokens,
      inputRatePerMillion: inputRate,
      outputRatePerMillion: outputRate,
    };
  });
  return {
    estimatedCostUsd: Number(total.toFixed(2)),
    currency: "USD",
    byModel,
    unknownCostInvocationCount: telemetry.unknownCostInvocationCount ?? 0,
    assumption:
      (telemetry.unknownCostInvocationCount ?? 0) > 0
        ? "Approximation uses configurable per-million token rates and estimated token counts, not provider billing data. File-input invocations without SDK usage contain an unknown cost component that is not represented by prompt-character estimates."
        : "Approximation uses configurable per-million token rates and estimated token counts, not provider billing data.",
  };
}

const SHARED_COST_CAP_CAVEAT =
  "The estimated cost cap is checked against the shared server log before the first project and between projects. Concurrent shards can each have one project in flight, so aggregate spend can overshoot the cap by up to the cost of those in-flight projects. Estimates are not provider billing totals, and file-input calls without usage can add unknown cost.";

function sharedEstimatedCostStatus(options) {
  const telemetry = summarizeTelemetry(
    telemetryEventsFromLog(options.serverLogPath),
  );
  const cost = approximateCost(telemetry);
  const limitUsd = options.maxEstimatedCostUsd ?? null;
  return {
    enabled: limitUsd !== null,
    limitUsd,
    estimatedCostUsd: cost.estimatedCostUsd,
    reached:
      limitUsd !== null && cost.estimatedCostUsd >= limitUsd,
    telemetryRequests: telemetry.totalRequests,
    usageBasis: telemetry.usageBasis,
    unknownCostInvocationCount: telemetry.unknownCostInvocationCount,
    enforcement: "before_first_project_and_between_projects",
    caveat: SHARED_COST_CAP_CAVEAT,
  };
}

function sharedCostCapStopReason(options, nextProjectId) {
  if (
    options.maxEstimatedCostUsd === null ||
    options.maxEstimatedCostUsd === undefined
  ) {
    return null;
  }
  const status = sharedEstimatedCostStatus(options);
  if (!status.reached) return null;
  return {
    projectId: nextProjectId ?? null,
    kind: "cost_cap",
    issues: [
      `Estimated shared-server cost $${status.estimatedCostUsd.toFixed(2)} reached cap $${status.limitUsd.toFixed(2)} before starting the next project.`,
    ],
    costCap: status,
  };
}

let atomicWriteSequence = 0;

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  atomicWriteSequence += 1;
  const temporaryPath = `${filePath}.tmp-${process.pid}-${atomicWriteSequence}`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readJsonCheckpoint(filePath) {
  try {
    return {
      checkpoint: JSON.parse(await readFile(filePath, "utf8")),
      error: null,
    };
  } catch (error) {
    return {
      checkpoint: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const preparedCleanupManifestPaths = new Set();

async function appendCleanupEvent(options, event) {
  await ensureCleanupManifestReadyForAppend(options);
  await mkdir(path.dirname(options.cleanupManifestPath), { recursive: true });
  await appendFile(
    options.cleanupManifestPath,
    `${JSON.stringify({
      version: 1,
      runId: options.runId,
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`,
    "utf8",
  );
}

async function registerCreatedProject(options, project, apiProjectId) {
  await appendCleanupEvent(options, {
    event: "created",
    apiProjectId,
    sourceProjectId: project.id,
    sourceProjectName: project.name,
  });
}

async function cleanupEventsFromEventLog(options) {
  if (!existsSync(options.cleanupManifestPath)) return [];
  const raw = await readFile(options.cleanupManifestPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const lastContentIndex = lines.reduce(
    (last, line, index) => (line.trim() ? index : last),
    -1,
  );
  const hasTerminatingNewline = /\r?\n$/.test(raw);
  const events = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.runId === options.runId) events.push(event);
    } catch (error) {
      const isTrailingPartial =
        index === lastContentIndex && !hasTerminatingNewline;
      if (isTrailingPartial) {
        console.warn(
          `Ignoring trailing partial cleanup manifest line ${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      throw new Error(
        `Malformed cleanup manifest ${options.cleanupManifestPath} at line ${
          index + 1
        }: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return events;
}

async function cleanupProjectsFromEventLog(options, knownEvents = null) {
  const projects = new Map();
  const events = knownEvents ?? (await cleanupEventsFromEventLog(options));
  for (const event of events) {
    if (!event.apiProjectId) continue;
    const current = projects.get(event.apiProjectId) ?? {};
    projects.set(event.apiProjectId, { ...current, ...event });
  }
  return [...projects.values()].filter(
    (project) => project.event !== "ignored",
  );
}

async function prepareCleanupManifestForAppend(options) {
  if (!existsSync(options.cleanupManifestPath)) return;
  const raw = await readFile(options.cleanupManifestPath, "utf8");
  if (!raw || /\r?\n$/.test(raw)) return;
  const lineStart = Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf("\r")) + 1;
  const trailingLine = raw.slice(lineStart);
  try {
    JSON.parse(trailingLine);
    await appendFile(options.cleanupManifestPath, "\n", "utf8");
  } catch {
    const prefix = raw.slice(0, lineStart);
    const partialRunId = trailingLine.match(/"runId"\s*:\s*"([^"]+)"/)?.[1];
    const partialEvent = trailingLine.match(/"event"\s*:\s*"([^"]+)"/)?.[1];
    const partialApiProjectId = trailingLine.match(
      /"apiProjectId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"/i,
    )?.[1];
    const recoveredApiProjectId =
      partialRunId === options.runId &&
      partialEvent === "created" &&
      partialApiProjectId
        ? partialApiProjectId
        : null;
    const quarantineEvent = {
      version: 1,
      runId: options.runId,
      timestamp: new Date().toISOString(),
      event: "quarantined-trailing-partial",
      originalLine: raw.slice(0, lineStart).split(/\r?\n/).length,
      partialSha256: createHash("sha256").update(trailingLine).digest("hex"),
      partialBase64: Buffer.from(trailingLine, "utf8").toString("base64"),
      ...(recoveredApiProjectId
        ? {
            apiProjectId: recoveredApiProjectId,
            sourceProjectId: "recovered-from-partial-created-event",
          }
        : {}),
    };
    await writeFile(
      options.cleanupManifestPath,
      `${prefix}${JSON.stringify(quarantineEvent)}\n`,
      "utf8",
    );
    console.warn(
      `Quarantined trailing partial cleanup manifest line ${quarantineEvent.originalLine} before appending cleanup results.`,
    );
  }
}

async function ensureCleanupManifestReadyForAppend(options) {
  const manifestKey = path.resolve(options.cleanupManifestPath);
  if (preparedCleanupManifestPaths.has(manifestKey)) return;
  await prepareCleanupManifestForAppend(options);
  await cleanupEventsFromEventLog(options);
  preparedCleanupManifestPaths.add(manifestKey);
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function choosePort(preferred) {
  for (let port = preferred; port < preferred + 20; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `Fant ingen ledig port fra ${preferred} til ${preferred + 19}.`,
  );
}

async function waitForHealth(baseUrl, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - started);
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { "x-client-ip": "127.251.0.1" },
        signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, remainingMs))),
      });
      if (response.status < 500) return;
      lastError = `${response.status} ${await response.text().catch(() => "")}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const retryDelayMs = Math.min(
      1_000,
      Math.max(0, timeoutMs - (Date.now() - started)),
    );
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(`Lokal server ble ikke klar: ${lastError}`);
}

async function startLocalServer(options) {
  if (options.baseUrl) {
    await waitForHealth(options.baseUrl, 30_000);
    return { baseUrl: options.baseUrl.replace(/\/+$/, ""), child: null };
  }

  const port = options.startServer
    ? await choosePort(options.port)
    : options.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  if (!options.startServer) {
    await waitForHealth(baseUrl, 30_000);
    return { baseUrl, child: null };
  }

  await mkdir(path.dirname(options.serverLogPath), { recursive: true });
  await writeFile(
    options.serverLogPath,
    `# anbud vurdering api full 251 server log ${new Date().toISOString()}\n`,
    "utf8",
  );
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: frontendRoot,
      env: {
        ...process.env,
        TRUST_FORWARDED_RATE_LIMIT_HEADERS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const appendLog = (chunk) => {
    writeFile(options.serverLogPath, chunk, { flag: "a" }).catch(
      () => undefined,
    );
  };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  child.once("exit", (code) => {
    appendLog(`\n# server exited code=${code}\n`);
  });
  await waitForHealth(baseUrl);
  return { baseUrl, child };
}

function parseSetCookie(headers) {
  const raw = headers.get("set-cookie");
  return raw ? raw.split(";")[0] : "";
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const normalized = String(value ?? "").trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    return Math.max(0, Number(normalized) * 1000);
  }
  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : 1000;
}

function abortableDelay(delayMs, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Retry wait aborted."));
  }
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error("Retry wait aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableHarnessTransportError(error) {
  const message = String(error?.message ?? error);
  const causeCode = String(error?.cause?.code ?? "");
  if (/timed?\s*out|deadline|abort/i.test(message)) {
    return false;
  }
  return (
    error instanceof TypeError ||
    /fetch failed|socket|connection reset|ECONNRESET|EPIPE|UND_ERR/i.test(
      `${message} ${causeCode}`,
    )
  );
}

class ApiClient {
  constructor(
    baseUrl,
    {
      fetchImpl = fetch,
      requestTimeoutMs = HARNESS_REQUEST_TIMEOUT_MS,
      projectTimeoutMs = HARNESS_PROJECT_TIMEOUT_MS,
    } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.cookie = "";
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.projectTimeoutMs = projectTimeoutMs;
    this.projectDeadlineAt = null;
    this.projectDeadlineController = null;
  }

  async withProjectDeadline(run) {
    const previousDeadline = this.projectDeadlineAt;
    const previousController = this.projectDeadlineController;
    const controller = new AbortController();
    this.projectDeadlineController = controller;
    this.projectDeadlineAt = Date.now() + this.projectTimeoutMs;
    const deadlineTimer = setTimeout(() => {
      controller.abort(
        new Error("Project API run exceeded the total project deadline."),
      );
    }, this.projectTimeoutMs);
    deadlineTimer.unref?.();
    try {
      return await run();
    } finally {
      clearTimeout(deadlineTimer);
      this.projectDeadlineAt = previousDeadline;
      this.projectDeadlineController = previousController;
    }
  }

  async waitForRateLimit(response) {
    const remainingProjectMs = this.projectDeadlineAt
      ? this.projectDeadlineAt - Date.now()
      : Number.POSITIVE_INFINITY;
    if (remainingProjectMs <= 0) {
      throw new Error("Project API run exceeded the total project deadline.");
    }
    const requestedDelayMs = parseRetryAfterMs(
      response.headers.get("retry-after"),
    );
    const delayMs = Math.min(requestedDelayMs, remainingProjectMs);
    await abortableDelay(delayMs, this.projectDeadlineController?.signal);
  }

  async request(url, init, timeoutMs = this.requestTimeoutMs) {
    const remainingProjectMs = this.projectDeadlineAt
      ? this.projectDeadlineAt - Date.now()
      : Number.POSITIVE_INFINITY;
    if (remainingProjectMs <= 0) {
      throw new Error("Project API run exceeded the total project deadline.");
    }
    const effectiveTimeoutMs = Math.max(
      1,
      Math.min(timeoutMs, remainingProjectMs),
    );
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } catch (error) {
      if (
        error?.name === "TimeoutError" ||
        error?.name === "AbortError" ||
        /timed?\s*out|deadline/i.test(String(error?.message ?? error))
      ) {
        throw new Error(
          `API request timed out after ${effectiveTimeoutMs} ms: ${url}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async login() {
    const password = process.env.APP_ACCESS_PASSWORD;
    if (!password) return;
    const response = await this.request(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-ip": "127.251.0.2",
      },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      throw new Error(
        `Login feilet: ${response.status} ${await response.text()}`,
      );
    }
    this.cookie = parseSetCookie(response.headers);
  }

  headers(projectKey, extra = {}) {
    const hash = createHash("sha1")
      .update(projectKey || "global")
      .digest();
    const ip = `10.${hash[0]}.${hash[1]}.${Math.max(1, hash[2])}`;
    return {
      ...extra,
      ...(this.cookie ? { cookie: this.cookie } : {}),
      "x-client-ip": ip,
    };
  }

  async json(
    pathname,
    {
      method = "GET",
      body,
      projectKey = "global",
      headers = {},
      expectedStatus = null,
      timeoutMs = this.requestTimeoutMs,
    } = {},
  ) {
    const normalizedMethod = method.toUpperCase();
    const mayRetryTransport = normalizedMethod === "GET";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      let response;
      try {
        response = await this.request(
          `${this.baseUrl}${pathname}`,
          {
            method: normalizedMethod,
            headers: this.headers(projectKey, {
              ...(body !== undefined
                ? { "content-type": "application/json" }
                : {}),
              ...headers,
            }),
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          timeoutMs,
        );
      } catch (error) {
        if (
          mayRetryTransport &&
          attempt < 5 &&
          isRetryableHarnessTransportError(error)
        ) {
          await abortableDelay(
            Math.min(1_000, 100 * 2 ** (attempt - 1)),
            this.projectDeadlineController?.signal,
          );
          continue;
        }
        throw error;
      }
      if (response.status === 429 && attempt < 5) {
        await this.waitForRateLimit(response);
        continue;
      }
      if (
        mayRetryTransport &&
        [502, 503, 504].includes(response.status) &&
        attempt < 5
      ) {
        await abortableDelay(
          Math.min(1_000, 100 * 2 ** (attempt - 1)),
          this.projectDeadlineController?.signal,
        );
        continue;
      }
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        throw new Error(
          `${method} ${pathname} feilet ${response.status}: ${
            parsed?.error ?? text.slice(0, 500)
          }`,
        );
      }
      if (expectedStatus !== null && response.status !== expectedStatus) {
        throw new Error(
          `${method} ${pathname} returnerte ${response.status}, forventet ${expectedStatus}.`,
        );
      }
      return parsed;
    }
    throw new Error(`${method} ${pathname} feilet etter rate-limit retries.`);
  }

  async uploadDocument({
    projectId,
    projectKey,
    fileName,
    buffer,
    title,
    role,
    supportingSubtype,
    contentType,
  }) {
    const form = new FormData();
    form.set(
      "file",
      new File([buffer], fileName, {
        type: contentType || "application/octet-stream",
      }),
    );
    form.set("title", title || documentTitleForUpload(fileName));
    form.set("role", role);
    if (supportingSubtype) form.set("supporting_subtype", supportingSubtype);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await this.request(
        `${this.baseUrl}/api/projects/${projectId}/documents`,
        {
          method: "POST",
          headers: this.headers(projectKey),
          body: form,
        },
        HARNESS_UPLOAD_TIMEOUT_MS,
      );
      if (response.status === 429 && attempt < 5) {
        await this.waitForRateLimit(response);
        continue;
      }
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(
          `Upload ${fileName} feilet ${response.status}: ${
            parsed?.error ?? text.slice(0, 500)
          }`,
        );
      }
      return parsed;
    }
    throw new Error(`Upload ${fileName} feilet etter rate-limit retries.`);
  }
}

async function listStoragePrefixFiles({
  supabase,
  prefix,
  bucket = DOCUMENT_STORAGE_BUCKET,
  pageSize = STORAGE_LIST_PAGE_SIZE,
}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("Storage page size must be an integer from 1 to 1000.");
  }
  const normalizedPrefix = String(prefix ?? "")
    .replace(/^\/+|\/+$/gu, "")
    .trim();
  if (!normalizedPrefix) {
    throw new Error("Storage verification requires a non-empty prefix.");
  }

  const pendingPrefixes = [normalizedPrefix];
  const visitedPrefixes = new Set();
  const files = [];
  while (pendingPrefixes.length) {
    const currentPrefix = pendingPrefixes.shift();
    if (!currentPrefix || visitedPrefixes.has(currentPrefix)) continue;
    visitedPrefixes.add(currentPrefix);

    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase.storage
        .from(bucket)
        .list(currentPrefix, {
          limit: pageSize,
          offset,
          sortBy: { column: "name", order: "asc" },
        });
      if (error) {
        throw new Error(
          `Storage prefix query failed for ${bucket}/${currentPrefix}: ${
            error.message || "unknown storage error"
          }`,
        );
      }

      const page = Array.isArray(data) ? data : [];
      for (const entry of page) {
        const name = String(entry?.name ?? "");
        if (!name || name === "." || name === ".." || name.includes("/")) {
          throw new Error(
            `Storage prefix query returned an unsafe child name under ${bucket}/${currentPrefix}.`,
          );
        }
        const childPath = `${currentPrefix}/${name}`;
        const isFolder = entry?.id == null && entry?.metadata == null;
        if (isFolder) pendingPrefixes.push(childPath);
        else files.push(childPath);
      }

      if (page.length < pageSize) break;
    }
  }

  return [...new Set(files)].sort();
}

async function listDatabaseProjects() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, title, client_name, description");
  if (error) {
    throw new Error(`Direct project baseline query failed: ${error.message}`);
  }
  return Array.isArray(data)
    ? data.map((project) => ({
        id: project.id,
        name: project.title ?? "",
        customer_name: project.client_name ?? "",
        description: project.description ?? "",
      }))
    : [];
}

async function databaseProjectExists(apiProjectId) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", apiProjectId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Direct project verification failed for ${apiProjectId}: ${error.message}`,
    );
  }
  return Boolean(data?.id);
}

async function getDatabaseProject(apiProjectId) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, title, client_name, description")
    .eq("id", apiProjectId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Direct project ownership query failed for ${apiProjectId}: ${error.message}`,
    );
  }
  return data
    ? {
        id: data.id,
        name: data.title ?? "",
        customer_name: data.client_name ?? "",
        description: data.description ?? "",
      }
    : null;
}

function isRunOwnedProject(project, runId) {
  const name = String(project?.name ?? "");
  const description = String(project?.description ?? "");
  return (
    name.startsWith(`[${runId}] `) &&
    description.startsWith(
      `Automated full Vurdering/Krav og svar API benchmark run ${runId}, row `,
    )
  );
}

function checkpointArtifactPaths(project, options) {
  return {
    requirementResponseMarkdown: path.join(
      options.artifactsRoot,
      "kravsvar",
      `${project.id}-${slug(project.name)}.md`,
    ),
    solutionEvaluationJson: path.join(
      options.artifactsRoot,
      "evaluations",
      `${project.id}.json`,
    ),
  };
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function checkpointArtifactHashes(project, options) {
  const paths = checkpointArtifactPaths(project, options);
  return {
    requirementResponseMarkdownSha256: await sha256File(
      paths.requirementResponseMarkdown,
    ),
    solutionEvaluationJsonSha256: await sha256File(
      paths.solutionEvaluationJson,
    ),
  };
}

async function reusableCheckpointIssue({
  checkpoint,
  options,
  project,
  getLiveProject = getDatabaseProject,
}) {
  const qualityGate = strictProjectGate(checkpoint);
  if (!qualityGate.passed) {
    return `checkpoint strict quality gate failed: ${qualityGate.issues.join(", ")}`;
  }
  if (!normalizeInlineText(checkpoint.apiProjectId)) {
    return "checkpoint is missing apiProjectId";
  }
  const expectedPaths = checkpointArtifactPaths(project, options);
  if (
    !checkpoint.kravSvar?.markdownPath ||
    path.resolve(checkpoint.kravSvar.markdownPath) !==
      path.resolve(expectedPaths.requirementResponseMarkdown)
  ) {
    return "checkpoint requirement-response artifact path is stale";
  }
  if (
    !checkpoint.evaluationPath ||
    path.resolve(checkpoint.evaluationPath) !==
      path.resolve(expectedPaths.solutionEvaluationJson)
  ) {
    return "checkpoint evaluation artifact path is stale";
  }
  const expectedSourceDocumentIds = [
    checkpoint.kravSvar?.customerDocumentId,
    checkpoint.kravSvar?.sourceDocumentId,
  ]
    .map(normalizeInlineText)
    .filter(Boolean);
  if (expectedSourceDocumentIds.length !== 2) {
    return "checkpoint is missing canonical customer/Bilag 2 source IDs";
  }
  for (const field of [
    "requestedSourceDocumentIds",
    "requestedSourceSnapshotDocumentIds",
  ]) {
    const requestedSourceDocumentIds = Array.isArray(
      checkpoint.kravSvar?.[field],
    )
      ? checkpoint.kravSvar[field].map(normalizeInlineText).filter(Boolean)
      : [];
    if (
      requestedSourceDocumentIds.length !== 1 ||
      requestedSourceDocumentIds[0] !== expectedSourceDocumentIds[1]
    ) {
      return `checkpoint is missing formal-only requested artifact scope metadata in ${field}`;
    }
  }
  for (const field of [
    "sourceDocumentIds",
    "sourceSnapshotDocumentIds",
    "sourceRoleDocumentIds",
  ]) {
    const values = Array.isArray(checkpoint.kravSvar?.[field])
      ? checkpoint.kravSvar[field].map(normalizeInlineText).filter(Boolean)
      : [];
    if (
      values.length !== expectedSourceDocumentIds.length ||
      values.some((value, index) => value !== expectedSourceDocumentIds[index])
    ) {
      return `checkpoint is missing canonical artifact scope metadata in ${field}`;
    }
  }
  const expectedHashes = checkpoint.localArtifactHashes;
  if (
    !/^[0-9a-f]{64}$/.test(
      expectedHashes?.requirementResponseMarkdownSha256 ?? "",
    ) ||
    !/^[0-9a-f]{64}$/.test(expectedHashes?.solutionEvaluationJsonSha256 ?? "")
  ) {
    return "checkpoint is missing local artifact hashes";
  }
  let actualHashes;
  try {
    actualHashes = await checkpointArtifactHashes(project, options);
  } catch (error) {
    return `checkpoint local artifact is missing: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (
    actualHashes.requirementResponseMarkdownSha256 !==
      expectedHashes.requirementResponseMarkdownSha256 ||
    actualHashes.solutionEvaluationJsonSha256 !==
      expectedHashes.solutionEvaluationJsonSha256
  ) {
    return "checkpoint local artifact hash mismatch";
  }
  const liveProject = await getLiveProject(checkpoint.apiProjectId);
  if (!liveProject) {
    return `checkpoint apiProjectId ${checkpoint.apiProjectId} no longer exists`;
  }
  const expectedDescription = `Automated full Vurdering/Krav og svar API benchmark run ${options.runId}, row ${project.id}`;
  if (
    !isRunOwnedProject(liveProject, options.runId) ||
    liveProject.description !== expectedDescription
  ) {
    return `checkpoint apiProjectId ${checkpoint.apiProjectId} is not owned by run ${options.runId} row ${project.id}`;
  }
  return null;
}

function protectedPetoroProjectsFromBaseline(projects, runId) {
  return projects
    .filter((project) =>
      /petoro/i.test(`${project?.name ?? ""} ${project?.customer_name ?? ""}`),
    )
    .filter((project) => !isRunOwnedProject(project, runId))
    .map((project) => ({
      id: project.id,
      name: project.name ?? "",
      customerName: project.customer_name ?? "",
      description: project.description ?? "",
    }))
    .filter((project) => project.id);
}

function analyzeCleanupBaseline({
  currentProjects,
  baselineProjects,
  registeredProjectIds,
  runId,
}) {
  const currentProjectsById = new Map(
    currentProjects.map((project) => [project.id, project]),
  );
  const currentProjectIds = new Set(currentProjectsById.keys());
  const baselineProjectIds = new Set(
    baselineProjects.map((project) => project.id).filter(Boolean),
  );
  const missingBaselineProjectIds = baselineProjects
    .filter((project) => !currentProjectIds.has(project.id))
    .map((project) => project.id);
  const changedBaselineProjectIds = baselineProjects
    .filter((project) => {
      const current = currentProjectsById.get(project.id);
      return (
        current &&
        (String(current.name ?? "") !== String(project.name ?? "") ||
          String(current.customer_name ?? "") !==
            String(project.customerName ?? "") ||
          String(current.description ?? "") !==
            String(project.description ?? ""))
      );
    })
    .map((project) => project.id);
  const unexpectedProjectIds = currentProjects
    .filter((project) => !baselineProjectIds.has(project.id))
    .map((project) => project.id);
  const remainingRegisteredProjectIds = [...registeredProjectIds].filter(
    (projectId) =>
      currentProjectIds.has(projectId) && !baselineProjectIds.has(projectId),
  );
  const remainingRunOwnedProjectIds = currentProjects
    .filter((project) => isRunOwnedProject(project, runId))
    .map((project) => project.id);
  return {
    currentProjectsById,
    currentProjectIds,
    baselineProjectIds,
    missingBaselineProjectIds,
    changedBaselineProjectIds,
    unexpectedProjectIds,
    remainingRegisteredProjectIds,
    remainingRunOwnedProjectIds,
  };
}

async function recordProtectedPetoroSnapshot(options) {
  const projects = await listDatabaseProjects();
  const baselineProjects = projects.filter(
    (project) => !isRunOwnedProject(project, options.runId),
  );
  options.baselineProjectIds = new Set(
    baselineProjects.map((project) => project.id).filter(Boolean),
  );
  const protectedProjects = protectedPetoroProjectsFromBaseline(
    projects,
    options.runId,
  );
  await appendCleanupEvent(options, {
    event: "protected-petoro-snapshot",
    baselineProjectIds: baselineProjects
      .map((project) => project.id)
      .filter(Boolean),
    baselineProjects: baselineProjects.map((project) => ({
      id: project.id,
      name: project.name ?? "",
      customerName: project.customer_name ?? "",
      description: project.description ?? "",
    })),
    protectedProjects,
  });
  if (options.requireProtectedPetoro && protectedProjects.length === 0) {
    throw new Error(
      "No pre-existing Petoro project was found in the direct database baseline.",
    );
  }
  return protectedProjects;
}

async function cleanupTargetsFromEventsAndDatabase(
  events,
  databaseProjects,
  runId,
  protectedProjectIds = [],
) {
  const protectedIds = new Set(protectedProjectIds.filter(Boolean));
  const liveProjectsById = new Map(
    databaseProjects
      .filter((project) => project?.id)
      .map((project) => [project.id, project]),
  );
  const targets = new Map();
  for (const project of await cleanupProjectsFromEventLog({ runId }, events)) {
    const liveProject = liveProjectsById.get(project.apiProjectId);
    if (
      !liveProject ||
      protectedIds.has(project.apiProjectId) ||
      !isRunOwnedProject(liveProject, runId)
    ) {
      continue;
    }
    targets.set(project.apiProjectId, project);
  }
  for (const project of databaseProjects) {
    if (
      !project?.id ||
      protectedIds.has(project.id) ||
      !isRunOwnedProject(project, runId) ||
      targets.has(project.id)
    ) {
      continue;
    }
    targets.set(project.id, {
      event: "recovered-run-owned-project",
      apiProjectId: project.id,
      sourceProjectId: "recovered-from-direct-database-baseline",
      sourceProjectName: project.name ?? "",
      cleanupStatus: "recovered",
    });
  }
  return [...targets.values()];
}

async function cleanupCreatedProjects(options, api) {
  if (!existsSync(options.cleanupManifestPath)) {
    throw new Error(
      `Cleanup manifest not found: ${options.cleanupManifestPath}`,
    );
  }
  await ensureCleanupManifestReadyForAppend(options);
  const events = await cleanupEventsFromEventLog(options);
  const databaseProjectsBeforeCleanup = await listDatabaseProjects();
  const databaseProjectsById = new Map(
    databaseProjectsBeforeCleanup.map((project) => [project.id, project]),
  );
  const manifestProtectedProjects = [
    ...new Map(
      events
        .filter((event) => event.event === "protected-petoro-snapshot")
        .flatMap((event) => event.protectedProjects ?? [])
        .filter((project) => project?.id)
        .map((project) => [project.id, project]),
    ).values(),
  ];
  const manifestBaselineProjects = [
    ...new Map(
      events
        .filter((event) => event.event === "protected-petoro-snapshot")
        .flatMap((event) => event.baselineProjects ?? [])
        .filter((project) => project?.id)
        .map((project) => [project.id, project]),
    ).values(),
  ];
  const protectedProjects = [
    ...new Map(
      [
        ...manifestProtectedProjects.filter((project) => {
          const liveProject = databaseProjectsById.get(project.id);
          return liveProject && !isRunOwnedProject(liveProject, options.runId);
        }),
        ...protectedPetoroProjectsFromBaseline(
          databaseProjectsBeforeCleanup,
          options.runId,
        ),
      ].map((project) => [project.id, project]),
    ).values(),
  ];

  if (
    options.requireProtectedPetoro &&
    (manifestProtectedProjects.length === 0 ||
      protectedProjects.length === 0 ||
      manifestBaselineProjects.length === 0)
  ) {
    throw new Error(
      "Cleanup manifest has no pre-existing Petoro snapshot for this run.",
    );
  }
  const projects = await cleanupTargetsFromEventsAndDatabase(
    events,
    databaseProjectsBeforeCleanup,
    options.runId,
    [
      ...protectedProjects.map((project) => project.id),
      ...manifestBaselineProjects.map((project) => project.id),
    ],
  );

  const registeredProjectIds = new Set(
    (await cleanupProjectsFromEventLog(options, events)).map(
      (project) => project.apiProjectId,
    ),
  );
  for (const project of projects) {
    if (!registeredProjectIds.has(project.apiProjectId)) {
      await appendCleanupEvent(options, project);
    }
  }

  const cleanupFailures = [];
  const protectedProjectIds = new Set([
    ...protectedProjects.map((project) => project.id),
    ...manifestBaselineProjects.map((project) => project.id),
  ]);

  for (const project of projects) {
    if (!project?.apiProjectId) continue;
    try {
      const liveProject = await getDatabaseProject(project.apiProjectId);
      if (!liveProject) {
        await appendCleanupEvent(options, {
          event: "deleted",
          apiProjectId: project.apiProjectId,
          sourceProjectId: project.sourceProjectId,
          cleanupStatus: "already-absent",
        });
        continue;
      }
      if (
        protectedProjectIds.has(project.apiProjectId) ||
        !isRunOwnedProject(liveProject, options.runId)
      ) {
        throw new Error(
          "Cleanup ownership verification rejected a non-run-owned or protected project.",
        );
      }
      await api.json(`/api/projects/${project.apiProjectId}`, {
        method: "DELETE",
        projectKey: project.sourceProjectId || project.apiProjectId,
      });
      await appendCleanupEvent(options, {
        event: "deleted",
        apiProjectId: project.apiProjectId,
        sourceProjectId: project.sourceProjectId,
        cleanupStatus: "deleted",
      });
    } catch (error) {
      if (
        /feilet 404\b/.test(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        try {
          await appendCleanupEvent(options, {
            event: "deleted",
            apiProjectId: project.apiProjectId,
            sourceProjectId: project.sourceProjectId,
            cleanupStatus: "already-absent",
          });
        } catch (manifestError) {
          cleanupFailures.push({
            apiProjectId: project.apiProjectId,
            phase: "record-already-absent",
            error:
              manifestError instanceof Error
                ? manifestError.message
                : String(manifestError),
          });
        }
      } else {
        const cleanupError =
          error instanceof Error ? error.message : String(error);
        cleanupFailures.push({
          apiProjectId: project.apiProjectId,
          phase: "delete",
          error: cleanupError,
        });
        try {
          await appendCleanupEvent(options, {
            event: "cleanup-failed",
            apiProjectId: project.apiProjectId,
            sourceProjectId: project.sourceProjectId,
            cleanupStatus: "failed",
            cleanupError,
          });
        } catch (manifestError) {
          cleanupFailures.push({
            apiProjectId: project.apiProjectId,
            phase: "record-delete-failure",
            error:
              manifestError instanceof Error
                ? manifestError.message
                : String(manifestError),
          });
        }
      }
    }
  }

  const databaseProjectsAfterCleanup = await listDatabaseProjects();
  const {
    currentProjectsById,
    currentProjectIds,
    baselineProjectIds,
    missingBaselineProjectIds,
    changedBaselineProjectIds,
    unexpectedProjectIds,
    remainingRegisteredProjectIds,
    remainingRunOwnedProjectIds: remaining,
  } = analyzeCleanupBaseline({
    currentProjects: databaseProjectsAfterCleanup,
    baselineProjects: manifestBaselineProjects,
    registeredProjectIds,
    runId: options.runId,
  });
  const missingProtectedProjectIds = [
    ...new Set(
      protectedProjects
        .map((project) => project.id)
        .filter((id) => id && !currentProjectIds.has(id)),
    ),
  ];
  const changedProtectedProjectIds = protectedProjects
    .filter((project) => {
      const current = currentProjectsById.get(project.id);
      return (
        current &&
        (String(current.name ?? "") !== String(project.name ?? "") ||
          String(current.customer_name ?? "") !==
            String(project.customerName ?? "") ||
          String(current.description ?? "") !==
            String(project.description ?? ""))
      );
    })
    .map((project) => project.id);
  const remainingStorageObjects = [];
  const storageClient = createServiceClient();
  const runOwnedStorageProjectIds = new Set([
    ...registeredProjectIds,
    ...projects.map((project) => project.apiProjectId).filter(Boolean),
  ]);
  for (const projectId of runOwnedStorageProjectIds) {
    if (!projectId || protectedProjectIds.has(projectId)) continue;
    try {
      const paths = await listStoragePrefixFiles({
        supabase: storageClient,
        prefix: `projects/${projectId}`,
      });
      if (paths.length) {
        remainingStorageObjects.push({ projectId, paths });
        cleanupFailures.push({
          apiProjectId: projectId,
          phase: "verify-storage-empty",
          error: `${paths.length} storage object(s) remain: ${paths
            .slice(0, 10)
            .join(", ")}`,
        });
      }
    } catch (error) {
      cleanupFailures.push({
        apiProjectId: projectId,
        phase: "verify-storage-empty",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await appendCleanupEvent(options, {
    event: "cleanup-verified",
    registeredProjectCount: projects.length,
    remainingProjectIds: remaining,
    protectedProjectIds: protectedProjects.map((project) => project.id),
    missingProtectedProjectIds,
    changedProtectedProjectIds,
    baselineProjectIds: [...baselineProjectIds],
    missingBaselineProjectIds,
    changedBaselineProjectIds,
    unexpectedProjectIds,
    remainingRegisteredProjectIds,
    remainingStorageObjects,
    cleanupFailures,
  });
  if (
    cleanupFailures.length ||
    remaining.length ||
    missingProtectedProjectIds.length ||
    changedProtectedProjectIds.length ||
    missingBaselineProjectIds.length ||
    changedBaselineProjectIds.length ||
    unexpectedProjectIds.length ||
    remainingRegisteredProjectIds.length
  ) {
    throw new Error(
      [
        cleanupFailures.length
          ? `cleanup errors: ${cleanupFailures
              .map(
                (failure) =>
                  `${failure.apiProjectId ?? "global"}/${failure.phase}: ${failure.error}`,
              )
              .join(" | ")}`
          : "",
        remaining.length
          ? `remaining test projects: ${remaining.join(", ")}`
          : "",
        missingProtectedProjectIds.length
          ? `missing protected Petoro projects: ${missingProtectedProjectIds.join(", ")}`
          : "",
        changedProtectedProjectIds.length
          ? `changed protected Petoro projects: ${changedProtectedProjectIds.join(", ")}`
          : "",
        missingBaselineProjectIds.length
          ? `missing baseline projects: ${missingBaselineProjectIds.join(", ")}`
          : "",
        changedBaselineProjectIds.length
          ? `changed baseline projects: ${changedBaselineProjectIds.join(", ")}`
          : "",
        unexpectedProjectIds.length
          ? `unexpected projects after cleanup: ${unexpectedProjectIds.join(", ")}`
          : "",
        remainingRegisteredProjectIds.length
          ? `registered test projects still present: ${remainingRegisteredProjectIds.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
  console.log(
    `CLEANUP run=${options.runId} registered=${projects.length} remaining=0 protected=${protectedProjects.length}`,
  );
}

async function waitForJob(api, { projectId, jobId, projectKey, label }) {
  const started = Date.now();
  let workerKicks = 0;
  while (Date.now() - started < 20 * 60_000) {
    const { job } = await api.json(`/api/projects/${projectId}/jobs/${jobId}`, {
      projectKey,
    });
    if (job?.status === "completed") return job;
    if (job?.status === "failed") {
      throw new Error(`${label} feilet: ${job.error || "ukjent feil"}`);
    }
    if (
      job?.status === "queued" &&
      workerKicks < 2 &&
      Date.now() - started > 3000
    ) {
      workerKicks += 1;
      await api
        .json("/api/project-jobs/worker", {
          method: "POST",
          body: { limit: 1 },
          projectKey,
          headers: process.env.PROJECT_JOB_WORKER_TOKEN
            ? { "x-worker-token": process.env.PROJECT_JOB_WORKER_TOKEN }
            : {},
        })
        .catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`${label} ble ikke ferdig innen tidsgrensen.`);
}

async function uploadAndIngest(api, input) {
  const uploaded = await api.uploadDocument(input);
  const job = await waitForJob(api, {
    projectId: input.projectId,
    jobId: uploaded.job.id,
    projectKey: input.projectKey,
    label: `Ingest ${input.fileName}`,
  });
  return {
    upload: uploaded,
    job,
    document: job.result?.document ?? uploaded.document,
  };
}

async function seedCustomerAnalysis({
  project,
  projectId,
  customerDocumentId,
  customerDocument,
  sourceLedger,
}) {
  const analysis = buildCustomerAnalysis({
    projectName: project.name,
    customerDocument,
    ledger: sourceLedger,
  });
  const supabase = createServiceClient();
  await supabase.from("customer_analyses").delete().eq("project_id", projectId);
  const { error } = await supabase.from("customer_analyses").insert({
    project_id: projectId,
    source_document_ids: [customerDocumentId],
    result_json: encryptJson(analysis),
    provenance_verified: true,
  });
  if (error) {
    throw new Error(error.message || "Kunne ikke seed-e kundeanalyse.");
  }
  const update = await supabase
    .from("projects")
    .update({
      customer_analysis_generated: true,
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", projectId);
  if (update.error) {
    throw new Error(
      update.error.message || "Kunne ikke markere kundeanalyse klar.",
    );
  }
  return analysis;
}

async function runProjectCore(project, options, api) {
  const artifactPath = path.join(
    options.artifactsRoot,
    "projects",
    `${project.id}.json`,
  );
  const model = requestedModel(options);
  const checkpointContext = await projectCheckpointContext(project, options);
  const checkpointIdentityFields = checkpointIdentity(
    options,
    checkpointContext,
  );
  if (options.resume && existsSync(artifactPath)) {
    const loaded = await readJsonCheckpoint(artifactPath);
    if (loaded.error) {
      console.warn(
        `Ignoring invalid checkpoint for ${project.id}; the row will run again: ${loaded.error}`,
      );
    } else {
      const previous = loaded.checkpoint;
      const identityMismatch = checkpointIdentityMismatch(
        previous,
        options,
        checkpointContext,
      );
      const retryableFailure = previous.ok !== true;
      if (!identityMismatch && (!retryableFailure || !options.retryFailures)) {
        if (!retryableFailure) {
          const reuseIssue = await reusableCheckpointIssue({
            checkpoint: previous,
            options,
            project,
          });
          if (reuseIssue) {
            throw new Error(
              `Checkpoint reuse rejected for ${project.id}: ${reuseIssue}.`,
            );
          }
        }
        return previous;
      }
    }
  }

  const durations = {};
  const projectStartedAt = Date.now();
  let stageStartedAt = Date.now();
  const localProjectId = `api-full-251-${project.id}`;
  const [requirementDocumentForLedger, customerDocumentForAnalysis] =
    await Promise.all([
      loadProjectDocument({
        filePath: project.requirementPath,
        fileNameOverride: project.fileNameOverride,
        projectId: localProjectId,
        role: "supporting_document",
        supportingSubtype: "kravdokument",
      }),
      loadProjectDocument({
        filePath: project.customerPath,
        fileNameOverride: project.customerFileNameOverride,
        projectId: localProjectId,
        role: "primary_customer_document",
      }).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
    ]);
  const localCustomerDocument =
    "error" in customerDocumentForAnalysis
      ? await buildSyntheticCustomerDocument({
          projectId: localProjectId,
          projectName: project.name,
          reason: customerDocumentForAnalysis.error,
        })
      : customerDocumentForAnalysis;
  const [bilag2SourceLedger, customerSourceLedger] = await Promise.all([
    extractRequirementLedgerForDocument(requirementDocumentForLedger),
    extractRequirementLedgerForDocument(localCustomerDocument),
  ]);
  const canonicalRequirementScope = buildHarnessCanonicalRequirementScope({
    customerDocument: localCustomerDocument,
    formalRequirementDocuments: [requirementDocumentForLedger],
    requirementLedgerResults: [
      { document: localCustomerDocument, ledger: customerSourceLedger },
      { document: requirementDocumentForLedger, ledger: bilag2SourceLedger },
    ],
  });
  const canonicalEvaluationSourceLedger = canonicalRequirementScope.ledger;
  const canonicalCustomerRequirementCount =
    canonicalEvaluationSourceLedger.filter(
      (entry) => entry.documentId === localCustomerDocument.id,
    ).length;
  if (
    project.id === "petoro" &&
    canonicalEvaluationSourceLedger.length !==
      PETORO_GOLDEN_REQUIREMENT_IDS_V1.length
  ) {
    throw new Error(
      `Petoro canonical evaluation scope drifted to ${canonicalEvaluationSourceLedger.length}; expected ${PETORO_GOLDEN_REQUIREMENT_IDS_V1.length}.`,
    );
  }
  durations.localPreparationMs = Date.now() - stageStartedAt;

  stageStartedAt = Date.now();
  const created = await api.json("/api/projects", {
    method: "POST",
    projectKey: project.id,
    body: {
      name: `[${options.runId}] ${project.name}`,
      customer_name: project.name,
      description: `Automated full Vurdering/Krav og svar API benchmark run ${options.runId}, row ${project.id}`,
      industry: project.corpus,
      selected_service_ids: [],
    },
  });
  const apiProjectId = created.id;
  if (options.baselineProjectIds?.has(apiProjectId)) {
    throw new Error(
      `Project creation returned pre-existing baseline id ${apiProjectId}; refusing to mutate or delete it.`,
    );
  }
  try {
    await registerCreatedProject(options, project, apiProjectId);
  } catch (manifestError) {
    let rollbackError = null;
    try {
      await api.json(`/api/projects/${apiProjectId}`, {
        method: "DELETE",
        projectKey: project.id,
      });
      if (await databaseProjectExists(apiProjectId)) {
        rollbackError = "project still exists after DELETE";
      }
    } catch (error) {
      rollbackError = error instanceof Error ? error.message : String(error);
    }
    throw new Error(
      [
        `Failed to register created project ${apiProjectId} in cleanup manifest: ${
          manifestError instanceof Error
            ? manifestError.message
            : String(manifestError)
        }`,
        rollbackError
          ? `Immediate exact-ID rollback also failed: ${rollbackError}`
          : "Immediate exact-ID rollback succeeded.",
      ].join(" "),
    );
  }
  durations.projectCreationMs = Date.now() - stageStartedAt;
  const projectKey = `${project.id}-${apiProjectId}`;

  stageStartedAt = Date.now();
  let bilag1Fallback = null;
  let uploadedCustomer;
  if ("error" in customerDocumentForAnalysis) {
    bilag1Fallback = customerDocumentForAnalysis.error;
    const markdown = syntheticCustomerMarkdown({
      projectName: project.name,
      reason: bilag1Fallback,
    });
    uploadedCustomer = await uploadAndIngest(api, {
      projectId: apiProjectId,
      projectKey,
      fileName: SYNTHETIC_CUSTOMER_FILE_NAME,
      title: SYNTHETIC_CUSTOMER_DOCUMENT_TITLE,
      role: "primary_customer_document",
      buffer: Buffer.from(markdown, "utf8"),
      contentType: "text/markdown",
    });
  } else {
    const customerBuffer = await readFile(project.customerPath);
    const customerFileName =
      project.customerFileNameOverride ?? path.basename(project.customerPath);
    const customerFormat = inferUploadFileFormat({
      fileName: customerFileName,
    });
    try {
      uploadedCustomer = await uploadAndIngest(api, {
        projectId: apiProjectId,
        projectKey,
        fileName: customerFileName,
        title: documentTitleForUpload(customerFileName),
        role: "primary_customer_document",
        buffer: customerBuffer,
        contentType: contentTypeForUploadFormat(customerFormat),
      });
    } catch (error) {
      bilag1Fallback = error instanceof Error ? error.message : String(error);
      const markdown = syntheticCustomerMarkdown({
        projectName: project.name,
        reason: bilag1Fallback,
      });
      uploadedCustomer = await uploadAndIngest(api, {
        projectId: apiProjectId,
        projectKey,
        fileName: SYNTHETIC_CUSTOMER_FILE_NAME,
        title: SYNTHETIC_CUSTOMER_DOCUMENT_TITLE,
        role: "primary_customer_document",
        buffer: Buffer.from(markdown, "utf8"),
        contentType: "text/markdown",
      });
    }
  }
  durations.customerDocumentIngestionMs = Date.now() - stageStartedAt;

  stageStartedAt = Date.now();
  const requirementBuffer = await readFile(project.requirementPath);
  const requirementFileName =
    project.fileNameOverride ?? path.basename(project.requirementPath);
  const requirementFormat = inferUploadFileFormat({
    fileName: requirementFileName,
  });
  const uploadedRequirement = await uploadAndIngest(api, {
    projectId: apiProjectId,
    projectKey,
    fileName: requirementFileName,
    title: documentTitleForUpload(requirementFileName),
    role: "supporting_document",
    supportingSubtype: "kravdokument",
    buffer: requirementBuffer,
    contentType: contentTypeForUploadFormat(requirementFormat),
  });
  durations.requirementDocumentIngestionMs = Date.now() - stageStartedAt;

  stageStartedAt = Date.now();
  if (options.customerAnalysisApi) {
    await api.json(`/api/projects/${apiProjectId}/customer-analysis`, {
      method: "POST",
      projectKey,
      body: {},
      headers: options.model ? { "x-openai-model": options.model } : {},
    });
  } else {
    await seedCustomerAnalysis({
      project,
      projectId: apiProjectId,
      customerDocumentId: uploadedCustomer.document.id,
      customerDocument: localCustomerDocument,
      sourceLedger: canonicalEvaluationSourceLedger,
    });
  }
  durations.customerAnalysisMs = Date.now() - stageStartedAt;

  stageStartedAt = Date.now();
  const generatedJobStart = await api.json(
    `/api/projects/${apiProjectId}/jobs`,
    {
      method: "POST",
      projectKey,
      body: {
        kind: "artifact_generation",
        artifact_type: "forbedret_kravsvar",
        // The API request explicitly selects formal requirement documents.
        // The product canonicalizer adds the primary customer document to the
        // persisted source scope, which is verified below.
        source_document_ids: [uploadedRequirement.document.id],
        instructions:
          "Lag en komplett, sporbar kravbesvarelse. Bevar kravrekkefolge, krav-ID og underoverskrift der dette finnes i kravdokumentet.",
        use_solution_evaluation_context: false,
      },
      headers: options.model ? { "x-openai-model": options.model } : {},
    },
  );
  const generatedJob = await waitForJob(api, {
    projectId: apiProjectId,
    jobId: generatedJobStart.job.id,
    projectKey,
    label: "Krav og svar",
  });
  const generated = generatedJob.result;
  const artifact = generated.artifact;
  const artifactMarkdown = artifact?.content_markdown ?? "";
  if (!artifactMarkdown.trim()) {
    throw new Error("Krav og svar API returnerte tomt artefakt.");
  }
  const artifactSourceScope = assertGeneratedArtifactSourceScope({
    artifact,
    expectedRequestedDocumentIds: [uploadedRequirement.document.id],
    expectedDocumentIds: [
      uploadedCustomer.document.id,
      uploadedRequirement.document.id,
    ],
  });
  durations.requirementResponseMs = Date.now() - stageStartedAt;
  const markdownPath = path.join(
    options.artifactsRoot,
    "kravsvar",
    `${project.id}-${slug(project.name)}.md`,
  );
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, artifactMarkdown, "utf8");

  stageStartedAt = Date.now();
  const solutionFileName = `${project.id}-${slug(project.name)}-kravsvar.md`;
  const solutionDocumentTitle = `API-generert Krav og svar - ${project.name}`;
  const uploadedSolution = await uploadAndIngest(api, {
    projectId: apiProjectId,
    projectKey,
    fileName: solutionFileName,
    title: solutionDocumentTitle,
    role: "primary_solution_document",
    buffer: Buffer.from(artifactMarkdown, "utf8"),
    contentType: "text/markdown",
  });
  const integrityLedger =
    await buildIntegrityLedgerFromGeneratedSolutionArtifact({
      sourceLedger: canonicalEvaluationSourceLedger,
      artifactMarkdown,
      solutionFileName,
      solutionDocumentId: uploadedSolution.document.id,
      solutionDocumentTitle,
      projectId: localProjectId,
    });
  durations.solutionDocumentIngestionMs = Date.now() - stageStartedAt;

  stageStartedAt = Date.now();
  let evaluationResult;
  if (options.directSolutionEvaluation) {
    evaluationResult = await api.json(
      `/api/projects/${apiProjectId}/solution-evaluation`,
      {
        method: "POST",
        projectKey,
        body: {
          solution_document_id: uploadedSolution.document.id,
        },
        headers: options.model ? { "x-openai-model": options.model } : {},
        expectedStatus: 200,
        timeoutMs: HARNESS_DIRECT_EVALUATION_TIMEOUT_MS,
      },
    );
    if (
      !evaluationResult?.evaluation ||
      !evaluationResult?.project ||
      evaluationResult.artifact !== null ||
      evaluationResult.used_generated_solution !== false ||
      evaluationResult.job
    ) {
      throw new Error(
        "Direkte løsningsvurdering returnerte ikke den synkrone legacy-kontrakten.",
      );
    }
  } else {
    const evaluationJobStart = await api.json(
      `/api/projects/${apiProjectId}/jobs`,
      {
        method: "POST",
        projectKey,
        body: {
          kind: "solution_evaluation",
          solution_document_id: uploadedSolution.document.id,
        },
        headers: options.model ? { "x-openai-model": options.model } : {},
      },
    );
    const evaluationJob = await waitForJob(api, {
      projectId: apiProjectId,
      jobId: evaluationJobStart.job.id,
      projectKey,
      label: "Vurdering",
    });
    evaluationResult = evaluationJob.result;
  }
  durations.solutionEvaluationMs = Date.now() - stageStartedAt;
  const evaluation = evaluationResult.evaluation;
  const coverage = evaluation?.requirement_coverage;
  const integrity = analyzeRequirementCoverageIntegrity({
    sourceLedger: integrityLedger,
    coverage,
  });
  const fasitComparison = project.hasFasit
    ? compareLedgerWithFasitRows(bilag2SourceLedger, project.fasitRows, {
        sourceFormat: path.extname(project.requirementPath).slice(1),
      })
    : null;
  const oracleComparison = compareLedgerWithRequirementOracle(
    bilag2SourceLedger,
    project.requirementOracle,
  );
  const requirementResponseMetadata =
    artifact.input_snapshot?.generation_metadata?.requirement_response ??
    artifact.input_snapshot?.requirement_response ??
    null;
  const scoring = scoreProject({
    sourceCount: canonicalEvaluationSourceLedger.length,
    coverage,
    integrity,
    fasitComparison,
    oracleComparison,
    requirementResponseMetadata,
    bilag1Fallback,
    documentFindings: evaluation?.document_findings,
    evaluation,
    artifactMarkdown,
    expectedSolutionDocumentId: uploadedSolution.document.id,
  });
  durations.totalMs = Date.now() - projectStartedAt;
  const evaluationPath = path.join(
    options.artifactsRoot,
    "evaluations",
    `${project.id}.json`,
  );
  await writeJson(evaluationPath, evaluation);
  const localArtifactHashes = await checkpointArtifactHashes(project, options);

  const summary = {
    checkpointSchemaVersion: HARNESS_CHECKPOINT_SCHEMA_VERSION,
    runId: options.runId,
    checkpointProjectId: checkpointIdentityFields.projectId,
    sourceFingerprint: checkpointIdentityFields.sourceFingerprint,
    codeRevision: checkpointIdentityFields.codeRevision,
    configurationRevision: checkpointIdentityFields.configurationRevision,
    backendIdentity: checkpointIdentityFields.backendIdentity,
    ...selectionProfileIdentity(options),
    id: project.id,
    corpus: project.corpus,
    projectNumber: project.projectNumber,
    sourceNumber: project.sourceNumber,
    name: project.name,
    documentName: project.documentName,
    requirementPath: project.requirementPath,
    customerPath: project.customerPath,
    apiProjectId,
    apiBaseUrl: api.baseUrl,
    model,
    customerAnalysisMode: customerAnalysisMode(options),
    solutionEvaluationMode: solutionEvaluationMode(options),
    bilag1Fallback,
    sourceRequirementCount: canonicalEvaluationSourceLedger.length,
    canonicalRequirementCount: canonicalEvaluationSourceLedger.length,
    bilag2RequirementCount: bilag2SourceLedger.length,
    customerRequirementCount: canonicalCustomerRequirementCount,
    customerParsedRequirementCount: customerSourceLedger.length,
    requirementOracle: oracleComparison,
    kravSvar: {
      artifactId: artifact.id,
      title: artifact.title,
      markdownPath,
      customerDocumentId: uploadedCustomer.document.id,
      sourceDocumentId: uploadedRequirement.document.id,
      requestedSourceDocumentIds: artifactSourceScope.requested,
      requestedSourceSnapshotDocumentIds:
        artifactSourceScope.requestedSourceSnapshot,
      sourceDocumentIds: artifactSourceScope.topLevel,
      sourceSnapshotDocumentIds: artifactSourceScope.sourceSnapshot,
      sourceRoleDocumentIds: artifactSourceScope.roleManifest,
      solutionDocumentId: uploadedSolution.document.id,
      totalRequirements:
        requirementResponseMetadata?.total_requirements ?? null,
      generationMetadata: requirementResponseMetadata,
    },
    coverage: {
      total_requirements: coverage?.total_requirements ?? 0,
      assessed_requirements: coverage?.assessed_requirements ?? 0,
      good: coverage?.good ?? 0,
      weak: coverage?.weak ?? 0,
      missing: coverage?.missing ?? 0,
      unclear: coverage?.unclear ?? 0,
      itemCount: coverage?.items?.length ?? 0,
      missingSubtitles:
        coverage?.items?.filter(
          (item) =>
            !normalizeInlineText(item.requirement_subtitle) &&
            !normalizeInlineText(item.table_id),
        ).length ?? 0,
    },
    integrity,
    fasitComparison,
    documentFindingTraceability: scoring.documentFindingTraceability,
    answerEvidenceGrounding: scoring.answerEvidenceGrounding,
    holisticEvaluation: scoring.holisticEvaluation,
    score: scoring.score,
    scoreBand: scoreBand(scoring.score, scoring.acceptance),
    scoreComponents: scoring.components,
    acceptance: scoring.acceptance,
    durations,
    evaluationPath,
    localArtifactHashes,
    completedAt: new Date().toISOString(),
  };
  summary.qualityGate = strictProjectGate(summary, {
    requireDeclaredOk: false,
  });
  summary.ok = summary.qualityGate.passed;

  await writeJson(artifactPath, summary);
  return summary;
}

async function runProject(project, options, api) {
  return api.withProjectDeadline(() => runProjectCore(project, options, api));
}

async function buildFailureCheckpoint({ project, options, error, totalMs }) {
  const identity = checkpointIdentity(
    options,
    await projectCheckpointContext(project, options),
  );
  return {
    checkpointSchemaVersion: identity.schemaVersion,
    runId: identity.runId,
    model: identity.model,
    customerAnalysisMode: identity.customerAnalysisMode,
    ...(identity.solutionEvaluationMode
      ? { solutionEvaluationMode: identity.solutionEvaluationMode }
      : {}),
    checkpointProjectId: identity.projectId,
    sourceFingerprint: identity.sourceFingerprint,
    codeRevision: identity.codeRevision,
    configurationRevision: identity.configurationRevision,
    backendIdentity: identity.backendIdentity,
    ...selectionProfileIdentity(options),
    id: project.id,
    corpus: project.corpus,
    projectNumber: project.projectNumber,
    sourceNumber: project.sourceNumber,
    name: project.name,
    documentName: project.documentName,
    requirementPath: project.requirementPath,
    customerPath: project.customerPath,
    durations: { totalMs },
    ok: false,
    checkpointReuseRejected: /^Checkpoint reuse rejected\b/.test(
      error instanceof Error ? error.message : String(error),
    ),
    error: error instanceof Error ? error.message : String(error),
    completedAt: new Date().toISOString(),
  };
}

function aggregateProjects(projects, { acceptanceMode = "proposal" } = {}) {
  const bucket = {
    acceptanceMode,
    projects: projects.length,
    sourceRequirements: 0,
    canonicalRequirements: 0,
    bilag2Requirements: 0,
    customerParsedRequirements: 0,
    coverageItems: 0,
    integrityIssues: 0,
    scoreTotal: 0,
    strong: 0,
    pipelinePassed: 0,
    proposalReadinessFailures: 0,
    usable: 0,
    needsReview: 0,
    notReady: 0,
    bilag1Fallbacks: 0,
    executionFailures: 0,
    failures: 0,
    acceptanceFailures: 0,
    fasitExpected: 0,
    fasitRawUnorderedMatched: 0,
    fasitUnorderedMatched: 0,
    fasitRawOrderedMatched: 0,
    fasitOrderedMatched: 0,
    fasitIdComparable: 0,
    fasitIdMatched: 0,
    fasitHeadingComparable: 0,
    fasitHeadingMatched: 0,
  };
  for (const item of projects) {
    if (item.error) {
      bucket.executionFailures += 1;
      bucket.failures += 1;
      continue;
    }
    const proposalGate = strictProjectGate(item);
    const pipelineGate = technicalProjectGate(item);
    const isStrong = proposalGate.passed;
    const isAccepted =
      acceptanceMode === "pipeline" ? pipelineGate.passed : isStrong;
    if (!isAccepted) {
      bucket.acceptanceFailures += 1;
      bucket.failures += 1;
    }
    if (pipelineGate.passed) bucket.pipelinePassed += 1;
    if (!isStrong) bucket.proposalReadinessFailures += 1;
    const canonicalRequirementCount =
      item.canonicalRequirementCount ?? item.sourceRequirementCount ?? 0;
    bucket.sourceRequirements += canonicalRequirementCount;
    bucket.canonicalRequirements += canonicalRequirementCount;
    bucket.bilag2Requirements += item.bilag2RequirementCount ?? 0;
    bucket.customerParsedRequirements +=
      item.customerParsedRequirementCount ?? item.customerRequirementCount ?? 0;
    bucket.coverageItems += item.coverage?.itemCount ?? 0;
    bucket.integrityIssues += item.integrity?.issueCount ?? 0;
    bucket.scoreTotal += item.score ?? 0;
    if (isStrong) bucket.strong += 1;
    else if (item.score >= 85) bucket.usable += 1;
    else if (item.score >= 75) bucket.needsReview += 1;
    else bucket.notReady += 1;
    if (item.bilag1Fallback) bucket.bilag1Fallbacks += 1;
    if (item.fasitComparison) {
      bucket.fasitExpected += item.fasitComparison.expectedCount;
      bucket.fasitRawUnorderedMatched +=
        item.fasitComparison.rawUnorderedMatched ??
        item.fasitComparison.unorderedMatched;
      bucket.fasitUnorderedMatched += item.fasitComparison.unorderedMatched;
      bucket.fasitRawOrderedMatched +=
        item.fasitComparison.rawOrderedMatched ??
        item.fasitComparison.orderedMatched;
      bucket.fasitOrderedMatched += item.fasitComparison.orderedMatched;
      bucket.fasitIdComparable += item.fasitComparison.idComparable;
      bucket.fasitIdMatched += item.fasitComparison.idMatched;
      bucket.fasitHeadingComparable += item.fasitComparison.headingComparable;
      bucket.fasitHeadingMatched += item.fasitComparison.headingMatched;
    }
  }
  const completed = bucket.projects - bucket.executionFailures;
  bucket.averageScore = completed
    ? Math.round(bucket.scoreTotal / completed)
    : 0;
  bucket.ok =
    bucket.projects > 0 &&
    bucket.failures === 0 &&
    bucket.executionFailures === 0 &&
    bucket.acceptanceFailures === 0 &&
    (acceptanceMode === "pipeline"
      ? bucket.pipelinePassed === bucket.projects
      : bucket.strong === bucket.projects);
  return bucket;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

function summarizeProjectDurations(projects) {
  const completed = projects.filter(
    (project) => project.durations?.totalMs >= 0,
  );
  const stageNames = [
    ...new Set(
      completed.flatMap((project) => Object.keys(project.durations ?? {})),
    ),
  ];
  return {
    measuredProjects: completed.length,
    byStage: Object.fromEntries(
      stageNames.map((stage) => {
        const values = completed
          .map((project) => Number(project.durations?.[stage]))
          .filter((value) => Number.isFinite(value) && value >= 0);
        return [
          stage,
          {
            samples: values.length,
            minMs: values.length ? Math.min(...values) : null,
            p50Ms: percentile(values, 0.5),
            p95Ms: percentile(values, 0.95),
            maxMs: values.length ? Math.max(...values) : null,
            averageMs: values.length
              ? Math.round(
                  values.reduce((sum, value) => sum + value, 0) / values.length,
                )
              : null,
          },
        ];
      }),
    ),
  };
}

function tableRows(projects) {
  return projects
    .map((item, index) => {
      if (item.error) {
        return `<tr data-project-row="1" data-corpus="${escapeHtml(item.corpus)}" data-score="0" data-strong="0" data-search="${escapeHtml(`${item.name} ${item.documentName} ${item.corpus}`.toLowerCase())}">
          <td class="num">${index + 1}</td>
          <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.documentName)}</span></td>
          <td>${escapeHtml(item.corpus)}</td>
          <td class="num">0</td>
          <td class="num">0</td>
          <td><span class="bad">Failed</span></td>
          <td>0%</td>
          <td><span class="bad">n/a</span></td>
          <td><span class="badge bad">Not ready</span></td>
          <td class="num score">0</td>
          <td>${escapeHtml(item.error)}</td>
        </tr>`;
      }
      const isStrong = strictProjectGate(item).passed;
      const statusClass = isStrong
        ? "good"
        : Number(item.score) >= 75
          ? "warn"
          : "bad";
      const displayedBand = isStrong
        ? "Strong"
        : Number(item.score) >= 85
          ? "Usable"
          : Number(item.score) >= 75
            ? "Needs review"
            : "Not ready";
      const fasit = item.fasitComparison;
      const fasitText = fasit
        ? [
            `${fasit.unorderedMatched}/${fasit.expectedCount} canonical text`,
            `${fasit.rawUnorderedMatched ?? fasit.unorderedMatched}/${
              fasit.expectedCount
            } raw text`,
            `${fasit.orderedMatched}/${fasit.expectedCount} canonical source-row binding`,
            `${fasit.rawOrderedMatched ?? fasit.orderedMatched}/${
              fasit.expectedCount
            } raw source-row binding`,
            `${fasit.workbookOrderedMatched ?? fasit.orderedMatched}/${
              fasit.expectedCount
            } workbook row-order (diagnostic only)`,
            `${fasit.sourceGeometryOrderedPairs ?? 0}/${
              fasit.sourceGeometryComparablePairs ?? 0
            } source-geometry pairs`,
            fasit.idComparable
              ? `${fasit.idMatched}/${fasit.idComparable} ID`
              : "ID n/a",
            fasit.headingComparable
              ? `${fasit.headingMatched}/${fasit.headingComparable} heading`
              : "heading n/a",
          ].join("; ")
        : "No fasit; integrity only";
      const actionability = Math.round(
        (item.scoreComponents?.actionableRatio ?? 0) * 100,
      );
      const subtitle = Math.round(
        (item.scoreComponents?.subtitleRatio ?? 0) * 100,
      );
      const note = [
        `Actionability ${actionability}%, subtitle/reference signal ${subtitle}%.`,
        item.integrity?.ok
          ? "Strict integrity clean."
          : `${item.integrity?.issueCount ?? 0} strict integrity issues.`,
        item.documentFindingTraceability?.ok
          ? "Document finding traceability clean."
          : `${item.documentFindingTraceability?.issueCount ?? 0} document finding traceability issues.`,
        item.bilag1Fallback ? "Bilag 1 synthetic fallback used." : "",
        item.customerAnalysisMode === "deterministic-seed"
          ? "Customer analysis seeded deterministically."
          : "",
        Number.isFinite(item.durations?.totalMs)
          ? `Total runtime ${item.durations.totalMs} ms.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");

      return `<tr data-project-row="1" data-corpus="${escapeHtml(item.corpus)}" data-score="${item.score}" data-strong="${isStrong ? "1" : "0"}" data-requirements="${item.sourceRequirementCount}" data-search="${escapeHtml(`${item.name} ${item.documentName} ${item.corpus}`.toLowerCase())}">
        <td class="num">${index + 1}</td>
        <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.documentName)}</span></td>
        <td>${escapeHtml(item.corpus)}</td>
        <td class="num">${item.sourceRequirementCount}</td>
        <td class="num">${item.bilag2RequirementCount ?? "n/a"}</td>
        <td><span class="${item.coverage.itemCount === item.sourceRequirementCount ? "good" : "warn"}">${item.coverage.itemCount}/${item.sourceRequirementCount}</span></td>
        <td>${escapeHtml(fasitText)}<br><span class="muted">source-order readiness from API evaluation ledger</span></td>
        <td>${item.integrity.issueCount === 0 ? '<span class="good">0</span>' : `<span class="warn">${item.integrity.issueCount}</span>`}</td>
        <td><span class="badge ${statusClass}">${displayedBand}</span></td>
        <td class="num score">${item.score}</td>
        <td>${escapeHtml(note)}</td>
      </tr>`;
    })
    .join("\n");
}

function corpusRows(projects) {
  const corpora = [...new Set(projects.map((item) => item.corpus))];
  return corpora
    .map((corpus) => {
      const items = projects.filter(
        (item) => item.corpus === corpus && !item.error,
      );
      const aggregate = aggregateProjects(items);
      const pct = (matched, total) =>
        total ? `${Math.round((matched / total) * 100)}%` : "n/a";
      return `<tr>
        <td>${escapeHtml(corpus)}</td>
        <td>${aggregate.projects}</td>
        <td>${aggregate.canonicalRequirements}</td>
        <td>${aggregate.bilag2Requirements}</td>
        <td><span class="${aggregate.coverageItems === aggregate.sourceRequirements ? "good" : "warn"}">${aggregate.coverageItems}/${aggregate.sourceRequirements}</span></td>
        <td>${aggregate.fasitExpected ? `${aggregate.fasitUnorderedMatched}/${aggregate.fasitExpected} canonical (${pct(aggregate.fasitUnorderedMatched, aggregate.fasitExpected)}); ${aggregate.fasitRawUnorderedMatched}/${aggregate.fasitExpected} raw (${pct(aggregate.fasitRawUnorderedMatched, aggregate.fasitExpected)})` : "No fasit"}</td>
        <td>${aggregate.fasitExpected ? `${aggregate.fasitOrderedMatched}/${aggregate.fasitExpected} canonical (${pct(aggregate.fasitOrderedMatched, aggregate.fasitExpected)}); ${aggregate.fasitRawOrderedMatched}/${aggregate.fasitExpected} raw (${pct(aggregate.fasitRawOrderedMatched, aggregate.fasitExpected)})` : "No fasit"}</td>
        <td>${aggregate.fasitIdComparable ? `${aggregate.fasitIdMatched}/${aggregate.fasitIdComparable} (${pct(aggregate.fasitIdMatched, aggregate.fasitIdComparable)})` : "n/a"}</td>
        <td>${aggregate.fasitHeadingComparable ? `${aggregate.fasitHeadingMatched}/${aggregate.fasitHeadingComparable} (${pct(aggregate.fasitHeadingMatched, aggregate.fasitHeadingComparable)})` : "n/a"}</td>
        <td>${aggregate.integrityIssues}</td>
        <td>${aggregate.averageScore}</td>
      </tr>`;
    })
    .join("\n");
}

async function writeHtmlReport({ filePath, summary }) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const aggregate = summary.aggregate;
  const generated = new Date(summary.generatedAt).toISOString().slice(0, 19);
  const modelList = summary.telemetry.byModel
    .map((item) => `${item.model}: ${item.requests}`)
    .join(", ");
  const totalDuration = summary.performance?.byStage?.totalMs;
  const completedRequestCount =
    summary.telemetry.completedRequestCount ?? summary.telemetry.totalRequests ?? 0;
  const failedRequestCount = summary.telemetry.failedRequestCount ?? 0;
  const incompleteRequestCount = summary.telemetry.incompleteRequestCount ?? 0;
  const usageBasis = summary.telemetry.usageBasis ?? "estimated";
  const unknownCostInvocationCount =
    summary.telemetry.unknownCostInvocationCount ?? 0;
  const modelConfiguration =
    summary.modelConfiguration ?? resolveRunnerModelPlan({
      model: summary.modelRequested ?? undefined,
    });
  const costCap = summary.costCap;
  const projectLabel = `${summary.scope?.requestedProjects ?? aggregate.projects} Project`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(projectLabel)} Vurdering Answer Quality Report</title>
  <style>
    :root { --paper:#f7f5ef; --ink:#17201b; --muted:#5f6860; --line:#d9d3c7; --panel:#fffefa; --band:#ece7dc; --green:#126a55; --ok:#27636d; --amber:#9a5a10; --red:#9e2f2f; --shadow:rgba(44,36,24,.08); }
    * { box-sizing: border-box; }
    body { margin:0; color:var(--ink); background:var(--paper); font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif; line-height:1.5; }
    main { width:min(1320px, calc(100% - 32px)); margin:0 auto; padding:32px 0 56px; }
    h1,h2,h3,p { margin:0; }
    h1 { max-width:940px; font-size:clamp(2.2rem, 5vw, 4.6rem); line-height:.98; letter-spacing:0; }
    h2 { margin-top:34px; font-size:clamp(1.35rem, 2vw, 1.9rem); letter-spacing:0; }
    h3 { font-size:1rem; letter-spacing:.02em; text-transform:uppercase; }
    p { color:var(--muted); }
    code { display:inline-block; max-width:100%; overflow-wrap:anywhere; border:1px solid var(--line); border-radius:4px; background:#faf6ee; padding:1px 5px; color:#24332c; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.9em; }
    .masthead { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(280px,.8fr); gap:24px; align-items:stretch; padding:28px; border:1px solid var(--line); border-radius:8px; background:rgba(255,254,250,.95); box-shadow:0 18px 45px var(--shadow); }
    .masthead p { max-width:900px; margin-top:18px; font-size:1.05rem; }
    .stamp { display:flex; min-height:250px; flex-direction:column; justify-content:space-between; border:1px solid #253b31; border-radius:8px; background:var(--ink); padding:20px; color:#f7f1e6; }
    .stamp p,.stamp span { color:#d8d0bf; }
    .stamp strong { display:block; font-size:clamp(4rem, 10vw, 7.2rem); line-height:.85; color:#fffaf0; }
    .meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:22px; }
    .tag { display:inline-flex; min-height:30px; align-items:center; border:1px solid var(--line); border-radius:999px; background:#fffaf0; padding:4px 11px; color:#3d493f; font-size:.84rem; font-weight:700; }
    .metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:18px; }
    .metric { min-height:124px; border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:16px; box-shadow:0 10px 22px var(--shadow); }
    .metric strong { display:block; color:var(--ink); font-size:2.1rem; line-height:1; }
    .metric span { display:block; margin-top:9px; color:var(--muted); font-size:.94rem; }
    .section { margin-top:18px; border:1px solid var(--line); border-radius:8px; background:rgba(255,254,250,.95); box-shadow:0 10px 24px var(--shadow); overflow:hidden; }
    .section-header { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); background:var(--band); padding:14px 16px; }
    .section-header span { color:var(--muted); font-size:.92rem; font-weight:700; }
    .controls { display:grid; grid-template-columns:minmax(220px,1fr) auto auto auto; gap:10px; padding:14px; border-bottom:1px solid var(--line); background:#fffaf0; }
    input,select { min-height:40px; border:1px solid var(--line); border-radius:6px; background:#fffefa; padding:8px 10px; color:var(--ink); font:.95rem/1.2 ui-serif, Georgia, Cambria, "Times New Roman", serif; }
    table { width:100%; border-collapse:collapse; background:var(--panel); }
    th,td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { position:sticky; top:0; z-index:1; background:#f5efe5; color:#34433a; font-size:.76rem; letter-spacing:.05em; text-transform:uppercase; }
    td { color:var(--muted); }
    td strong { display:block; color:var(--ink); }
    td span { display:block; }
    .table-wrap { max-height:760px; overflow:auto; }
    .num { color:var(--ink); font-weight:850; white-space:nowrap; }
    .score { font-size:1.2rem; }
    .muted { color:var(--muted); }
    .good { color:var(--green); font-weight:850; }
    .ok { color:var(--ok); font-weight:850; }
    .warn { color:var(--amber); font-weight:850; }
    .bad { color:var(--red); font-weight:850; }
    .badge { display:inline-flex; min-width:84px; min-height:28px; align-items:center; justify-content:center; border-radius:999px; padding:4px 9px; color:#fff; font-size:.82rem; font-weight:800; }
    .badge.good { background:var(--green); color:#fff; } .badge.ok { background:var(--ok); color:#fff; } .badge.warn { background:var(--amber); color:#fff; } .badge.bad { background:var(--red); color:#fff; }
    .rubric { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; padding:14px; background:var(--panel); }
    .rubric-item { border:1px solid var(--line); border-radius:8px; background:#fffaf0; padding:13px; }
    .rubric-item strong { display:block; color:var(--ink); font-size:1.25rem; line-height:1; }
    .rubric-item span { display:block; margin-top:8px; color:var(--muted); font-size:.9rem; }
    .callout { margin-top:18px; border-left:6px solid var(--ok); border-radius:8px; background:#edf3f5; padding:14px 16px; }
    .callout.warning { border-left-color:var(--amber); background:#fff5df; }
    .callout strong { display:block; margin-bottom:4px; color:var(--ink); }
    .footnotes { display:grid; gap:8px; margin-top:18px; color:var(--muted); font-size:.94rem; }
    @media (max-width:980px) { .masthead,.metric-grid { grid-template-columns:1fr; } .controls { grid-template-columns:1fr 1fr; } .rubric { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:680px) { main { width:min(100% - 20px,1320px); padding-top:18px; } .masthead { padding:16px; } .controls,.rubric { grid-template-columns:1fr; } table { min-width:1220px; } .stamp strong { font-size:3.6rem; } }
  </style>
</head>
<body>
  <main>
    <section class="masthead">
      <div>
        <h1>${escapeHtml(projectLabel)} Vurdering Answer Quality Report</h1>
        <p>
          Actual local web-server/API run for Vurdering and Krav og svar. Each project was created through the API, documents were uploaded through the API, Krav og svar was generated through the durable <code>/api/projects/:id/jobs</code> flow, the generated markdown was uploaded as the primary solution document, and Vurdering was run ${summary.solutionEvaluationMode === "direct" ? "through the legacy-compatible synchronous <code>/api/projects/:id/solution-evaluation</code> contract" : "through the jobs endpoint with <code>kind=solution_evaluation</code>"}.
        </p>
        <div class="meta">
          <span class="tag">Generated: ${escapeHtml(generated)}</span>
          <span class="tag">Strict status: ${summary.ok ? "PASS" : "FAIL"}</span>
          <span class="tag">Acceptance mode: ${escapeHtml(summary.acceptanceMode ?? "proposal")}</span>
          <span class="tag">Projects: ${aggregate.projects}</span>
          <span class="tag">Calls: ${summary.telemetry.totalRequests} (${completedRequestCount} success / ${failedRequestCount} failed / ${incompleteRequestCount} incomplete)</span>
          <span class="tag">Usage basis: ${escapeHtml(usageBasis)}</span>
          <span class="tag">Unknown file costs: ${unknownCostInvocationCount}</span>
          <span class="tag">Models: ${escapeHtml(modelList || "none")}</span>
          <span class="tag">Requested model: ${escapeHtml(modelConfiguration.requestedModel)}</span>
          <span class="tag">Effective default/analysis: ${escapeHtml(`${modelConfiguration.effectiveDefaultModel} / ${modelConfiguration.effectiveAnalysisModel}`)}</span>
          <span class="tag">Cost cap: ${costCap?.enabled ? `$${escapeHtml(costCap.limitUsd)} (${escapeHtml(costCap.enforcement)})` : "disabled"}</span>
          <span class="tag">Project time p50/p95: ${totalDuration?.p50Ms ?? "n/a"}/${totalDuration?.p95Ms ?? "n/a"} ms</span>
        </div>
      </div>
      <aside class="stamp" aria-label="Overall score">
        <div><span>${summary.ok ? "PASS" : "FAIL"} · Average score</span><strong>${aggregate.averageScore}</strong></div>
        <p>${aggregate.pipelinePassed} pipeline-passed, ${aggregate.strong} proposal-ready/all-Godt, ${aggregate.acceptanceFailures} selected-gate failures, ${aggregate.executionFailures} execution failures.</p>
      </aside>
    </section>

    <section class="metric-grid" aria-label="Top metrics">
      <div class="metric"><strong>${aggregate.pipelinePassed}/${aggregate.projects}</strong><span>Technically complete, grounded and integrity-clean evaluation pipelines.</span></div>
      <div class="metric"><strong>${aggregate.coverageItems}/${aggregate.canonicalRequirements}</strong><span>Vurdering coverage rows against the canonical customer + Bilag 2 requirement scope.</span></div>
      <div class="metric"><strong>${aggregate.integrityIssues}</strong><span>Strict integrity issues from evaluation-coverage-integrity.ts.</span></div>
      <div class="metric"><strong>$${summary.cost.estimatedCostUsd}</strong><span>Approximate cost from chat request telemetry (${escapeHtml(usageBasis)} usage basis${unknownCostInvocationCount ? "; file-input cost has an unknown component" : ""}).</span></div>
    </section>

    <section class="section">
      <div class="section-header"><h3>Scoring Rubric</h3><span>100 possible points</span></div>
      <div class="rubric">
        <div class="rubric-item"><strong>20</strong><span>Complete coverage of all source requirements.</span></div>
        <div class="rubric-item"><strong>10</strong><span>Stable ID/reference fields.</span></div>
        <div class="rubric-item"><strong>5</strong><span>Useful subtitle or table/source headline.</span></div>
        <div class="rubric-item"><strong>15</strong><span>Specific rationale, evidence, and recommendation.</span></div>
        <div class="rubric-item"><strong>20</strong><span>Strict integrity result.</span></div>
        <div class="rubric-item"><strong>10</strong><span>Fasit text, ID, and heading match where available.</span></div>
        <div class="rubric-item"><strong>20</strong><span>Strong requirement assessments.</span></div>
      </div>
    </section>

    <h2>Corpus Summary</h2>
    <section class="section">
      <p class="muted">Canonical requirements are the deduplicated customer + formal requirement scope consumed by Vurdering. Bilag 2 rows remain a separate fasit/oracle inventory. Source-row binding follows extracted document order; PDF order is additionally fenced by physical page/source ordinals.</p>
      <table>
        <thead><tr><th>Scope</th><th>Projects</th><th>Canonical requirements</th><th>Bilag 2 / oracle rows</th><th>Coverage</th><th>Fasit text match</th><th>Source-row binding</th><th>Fasit ID</th><th>Fasit heading</th><th>Integrity issues</th><th>Average score</th></tr></thead>
        <tbody>${corpusRows(summary.projects)}</tbody>
      </table>
    </section>

    <h2>All Project Scores</h2>
    <section class="section">
      <div class="section-header"><h3>${summary.projects.length} rows</h3><span id="visibleCount">Showing ${summary.projects.length} projects</span></div>
      <div class="controls">
        <input id="search" type="search" placeholder="Search project or document">
        <select id="corpus">
          <option value="">All corpora</option>
          <option value="50-folder">50-folder</option>
          <option value="100-folder">100-folder</option>
          <option value="rekkefolge-100">rekkefolge-100</option>
          <option value="Petoro">Petoro</option>
        </select>
        <select id="band">
          <option value="">All strict statuses</option>
          <option value="strong">Strict PASS (100)</option>
          <option value="85">Strict FAIL, score 85+</option>
          <option value="0">Strict FAIL, score below 85</option>
        </select>
        <select id="sort">
          <option value="index">Original order</option>
          <option value="score-asc">Score ascending</option>
          <option value="score-desc">Score descending</option>
          <option value="requirements-desc">Requirements descending</option>
        </select>
      </div>
      <div class="table-wrap">
        <table id="projectTable">
          <thead><tr><th>#</th><th>Project</th><th>Corpus</th><th>Canonical source</th><th>Bilag 2 / oracle</th><th>Coverage</th><th>Fasit / readiness</th><th>Integrity</th><th>Status</th><th>Score</th><th>Actionability note</th></tr></thead>
          <tbody>${tableRows(summary.projects)}</tbody>
        </table>
      </div>
    </section>

    <div class="callout">
      <strong>Source order vs fasit row order</strong>
      Fasit row order is diagnostic information. Vurdering readiness uses the canonical customer + Bilag 2 ledger; Excel/Petoro identity checks continue to use the separate Bilag 2 ledger.
    </div>
    <div class="callout warning">
      <strong>Petoro caveat</strong>
      Petoro has no spreadsheet fasit. Release acceptance therefore uses the independently source-verified petoro-manual-gold-v4-source-verified Bilag 2 oracle: exactly 74 ordered requirement identities, canonicalized full-text hashes, and thirty-three exact text anchors. Typography is normalized without changing source meaning. The canonical combined evaluation scope must also remain exactly 74 after customer/formal duplicate suppression. Any count, order, identity, full-text, anchor, coverage, grounding, or integrity mismatch fails the row.
    </div>
    <div class="callout">
      <strong>Run provenance</strong>
      This report is from an actual full local web-server/API Vurdering and Krav og svar run, not deterministic readiness scoring. Customer analysis was ${summary.customerAnalysisMode === "api" ? "generated through the API" : "seeded deterministically as a prerequisite"} so the requested benchmark focuses on Vurdering and Krav og svar.
    </div>

    <section class="footnotes">
      <p>Raw summary: <code>${escapeHtml(summary.outputPath)}</code>.</p>
      <p>Per-project artifacts: <code>${escapeHtml(summary.artifactsRoot)}</code>.</p>
      <p>Server log: <code>${escapeHtml(summary.serverLogPath)}</code>.</p>
      <p>Cost note: ${escapeHtml(summary.telemetry.note)} ${escapeHtml(summary.cost.assumption)}</p>
    </section>
  </main>
  <script>
    const searchInput = document.getElementById("search");
    const corpusSelect = document.getElementById("corpus");
    const bandSelect = document.getElementById("band");
    const sortSelect = document.getElementById("sort");
    const tableBody = document.querySelector("#projectTable tbody");
    const visibleCount = document.getElementById("visibleCount");
    const originalRows = Array.from(tableBody.querySelectorAll("tr"));
    function rowBandMatches(row, band) {
      if (!band) return true;
      const score = Number(row.dataset.score || 0);
      const strong = row.dataset.strong === "1";
      if (band === "strong") return strong;
      if (band === "85") return !strong && score >= 85;
      return !strong && score < 85;
    }
    function applyFilters() {
      const query = searchInput.value.trim().toLowerCase();
      const corpus = corpusSelect.value;
      const band = bandSelect.value;
      const sort = sortSelect.value;
      let rows = originalRows.filter((row) => {
        const matchesSearch = !query || row.dataset.search.includes(query);
        const matchesCorpus = !corpus || row.dataset.corpus === corpus;
        return matchesSearch && matchesCorpus && rowBandMatches(row, band);
      });
      if (sort === "score-asc") rows = rows.sort((a, b) => Number(a.dataset.score) - Number(b.dataset.score));
      else if (sort === "score-desc") rows = rows.sort((a, b) => Number(b.dataset.score) - Number(a.dataset.score));
      else if (sort === "requirements-desc") rows = rows.sort((a, b) => Number(b.dataset.requirements || 0) - Number(a.dataset.requirements || 0));
      else rows = rows.sort((a, b) => originalRows.indexOf(a) - originalRows.indexOf(b));
      tableBody.replaceChildren(...rows);
      visibleCount.textContent = "Showing " + rows.length + " project" + (rows.length === 1 ? "" : "s");
    }
    [searchInput, corpusSelect, bandSelect, sortSelect].forEach((control) => {
      control.addEventListener("input", applyFilters);
      control.addEventListener("change", applyFilters);
    });
  </script>
</body>
</html>
`;
  await writeFile(filePath, html, "utf8");
}

async function discoverProjects(options) {
  const [projects50, projects100, rekkefolge] = await Promise.all([
    discoverLegacyFasitProjects({
      corpus: "50-folder",
      root: options.corpus50Root,
      fasitPath: path.join(
        options.corpus50Root,
        "Fasit_50_skyprosjekter_bilag2.xlsx",
      ),
    }),
    discoverLegacyFasitProjects({
      corpus: "100-folder",
      root: options.corpus100Root,
      fasitPath: path.join(
        options.corpus100Root,
        "03_Fasit",
        "Fasit_100_skyprosjekter_bilag2.xlsx",
      ),
    }),
    discoverRekkefolgeProjects({ root: options.rekkefolgeRoot }),
  ]);

  const petoro = {
    id: "petoro",
    corpus: "Petoro",
    projectNumber: 251,
    sourceNumber: "251",
    name: "Petoro",
    documentName: "Kravdokument - Bilag 2 - Petoro",
    requirementPath: options.petoroRequirement,
    customerPath: options.petoroCustomer,
    fileNameOverride: "Kravdokument - Bilag 2 - Petoro.pdf",
    customerFileNameOverride: "Bilag 1 - Petoro.pdf",
    fasitRows: [],
    hasFasit: false,
    requirementOracle: {
      version: PETORO_GOLDEN_ORACLE_VERSION,
      orderedIds: PETORO_GOLDEN_REQUIREMENT_IDS_V1,
      orderedTextSha256: PETORO_GOLDEN_TEXT_SHA256_V1,
      textAnchors: PETORO_GOLDEN_TEXT_ANCHORS_V1,
    },
  };

  const projects = [...projects50, ...projects100, ...rekkefolge, petoro];
  return { projects, projects50, projects100, rekkefolge };
}

function validateSelectionOptions(options) {
  const selectionProfile = selectionProfileDefinition(
    options.selectionProfile,
  );
  if (
    !new Set(["proposal", "pipeline"]).has(
      options.acceptanceMode ?? "proposal",
    )
  ) {
    throw new Error(
      "--acceptance-mode must be either proposal or pipeline.",
    );
  }
  if (!options.runIdExplicit && !options.discoverOnly) {
    throw new Error(
      "--run-id is required for live, resume, merge, manifest validation, and cleanup runs.",
    );
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(options.runId)) {
    throw new Error(
      "--run-id must contain only letters, numbers, dot, underscore, or dash.",
    );
  }
  if (options.shardCount !== null || options.shardIndex !== null) {
    if (
      !Number.isInteger(options.shardCount) ||
      options.shardCount < 1 ||
      !Number.isInteger(options.shardIndex) ||
      options.shardIndex < 0 ||
      options.shardIndex >= options.shardCount
    ) {
      throw new Error(
        "--shard-index must be 0-based and smaller than --shard-count.",
      );
    }
    if (
      options.shardCount > 1 &&
      !options.discoverOnly &&
      !String(options.baseUrl ?? "").trim()
    ) {
      throw new Error(
        "--shard-count greater than 1 requires an explicit --base-url for one shared, already-started server.",
      );
    }
  }
  if (
    options.fromIndex !== null &&
    (!Number.isInteger(options.fromIndex) || options.fromIndex < 1)
  ) {
    throw new Error("--from-index must be a positive 1-based index.");
  }
  if (
    options.toIndex !== null &&
    (!Number.isInteger(options.toIndex) || options.toIndex < 1)
  ) {
    throw new Error("--to-index must be a positive 1-based index.");
  }
  if (
    options.expectSelected !== null &&
    (!Number.isInteger(options.expectSelected) || options.expectSelected < 1)
  ) {
    throw new Error("--expect-selected must be a positive integer.");
  }
  if (selectionProfile) {
    const incompatibleOptions = [
      ["--only", Boolean(options.only)],
      ["--limit", options.limit !== null],
      ["--from-index", options.fromIndex !== null],
      ["--to-index", options.toIndex !== null],
    ]
      .filter(([, present]) => present)
      .map(([name]) => name);
    if (incompatibleOptions.length) {
      throw new Error(
        `--selection-profile cannot be combined with ${incompatibleOptions.join(", ")}.`,
      );
    }
    if (options.corpus && options.corpus !== "100-folder") {
      throw new Error(
        `Selection profile ${selectionProfile.name} only supports --corpus 100-folder.`,
      );
    }
    if (options.expectSelected !== selectionProfile.expectedSelected) {
      throw new Error(
        `Selection profile ${selectionProfile.name} requires --expect-selected ${selectionProfile.expectedSelected}.`,
      );
    }
    if (!options.discoverOnly && !options.requireProtectedPetoro) {
      throw new Error(
        `Live selection profile ${selectionProfile.name} requires --require-protected-petoro.`,
      );
    }
  }
}

function projectsForSelectionProfile(projects, profile) {
  const expectedCorpusProjectIds = Array.from(
    { length: 100 },
    (_, index) => `100-folder-${String(index + 1).padStart(3, "0")}`,
  );
  const expectedCorpusProjectIdSet = new Set(expectedCorpusProjectIds);
  const corpusProjects = projects.filter(
    (project) => project.corpus === "100-folder",
  );
  const corpusProjectIds = corpusProjects.map((project) => project.id);
  const uniqueCorpusProjectIds = new Set(corpusProjectIds);
  const missingCorpusProjectIds = expectedCorpusProjectIds.filter(
    (projectId) => !uniqueCorpusProjectIds.has(projectId),
  );
  const unexpectedCorpusProjectIds = [...uniqueCorpusProjectIds].filter(
    (projectId) => !expectedCorpusProjectIdSet.has(projectId),
  );
  if (
    corpusProjects.length !== 100 ||
    uniqueCorpusProjectIds.size !== 100 ||
    missingCorpusProjectIds.length ||
    unexpectedCorpusProjectIds.length
  ) {
    throw new Error(
      `Selection profile ${profile.name} requires the exact 100-folder corpus (100 unique IDs 001-100); found ${corpusProjects.length} rows and ${uniqueCorpusProjectIds.size} unique IDs. Missing: ${missingCorpusProjectIds.join(", ") || "none"}. Unexpected: ${unexpectedCorpusProjectIds.join(", ") || "none"}.`,
    );
  }

  const petoroProjects = projects.filter((project) => project.id === "petoro");
  if (
    petoroProjects.length !== 1 ||
    petoroProjects[0]?.corpus !== "Petoro"
  ) {
    throw new Error(
      `Selection profile ${profile.name} requires exactly one petoro project in the Petoro corpus.`,
    );
  }

  const projectsById = new Map(
    [...corpusProjects, petoroProjects[0]].map((project) => [
      project.id,
      project,
    ]),
  );
  const selected = profile.orderedProjectIds.map((projectId) =>
    projectsById.get(projectId),
  );
  if (
    selected.some((project) => !project) ||
    selected.length !== profile.expectedSelected ||
    new Set(selected.map((project) => project.id)).size !== selected.length
  ) {
    throw new Error(
      `Selection profile ${profile.name} did not resolve to ${profile.expectedSelected} unique projects.`,
    );
  }
  return selected;
}

async function computeSelectionProfileSourceHashes(options, projects) {
  const profile = selectionProfileDefinition(options.selectionProfile);
  if (!profile) return null;
  const selected = projectsForSelectionProfile(projects, profile);
  const corpusProjects = selected.filter(
    (project) => project.corpus === "100-folder",
  );
  const sourceFiles = corpusProjects.flatMap((project) => [
    project.customerPath,
    project.requirementPath,
  ]);
  if (
    sourceFiles.length !== 50 ||
    sourceFiles.some((filePath) => !normalizeInlineText(filePath)) ||
    new Set(sourceFiles.map((filePath) => path.resolve(filePath))).size !== 50
  ) {
    throw new Error(
      `Selection profile ${profile.name} requires exactly 50 unique Bilag 1/2 source files.`,
    );
  }
  const sourceFileRecords = await Promise.all(
    sourceFiles.map(async (filePath) => ({
      basename: path.basename(filePath),
      sha256: await sha256File(filePath),
    })),
  );
  sourceFileRecords.sort((left, right) =>
    left.basename < right.basename
      ? -1
      : left.basename > right.basename
        ? 1
        : 0,
  );
  if (
    new Set(sourceFileRecords.map((record) => record.basename)).size !==
    sourceFileRecords.length
  ) {
    throw new Error(
      `Selection profile ${profile.name} source basenames are not unique.`,
    );
  }
  const selectedSourceFilesSha256 = createHash("sha256")
    .update(
      `${sourceFileRecords
        .map((record) => `${record.basename}\t${record.sha256}`)
        .join("\n")}\n`,
    )
    .digest("hex");
  const petoro = selected.find((project) => project.id === "petoro");
  const corpusFasitPath = path.join(
    options.corpus100Root,
    "03_Fasit",
    "Fasit_100_skyprosjekter_bilag2.xlsx",
  );
  const [corpusFasitSha256, petoroRequirementSha256, petoroCustomerSha256] =
    await Promise.all([
      sha256File(corpusFasitPath),
      sha256File(petoro.requirementPath),
      sha256File(petoro.customerPath),
    ]);
  return {
    corpusFasitSha256,
    selectedSourceFilesSha256,
    petoroRequirementSha256,
    petoroCustomerSha256,
  };
}

async function validateSelectionProfileSources(
  options,
  projects,
  runtime = {},
) {
  const profile = selectionProfileDefinition(options.selectionProfile);
  if (!profile) return null;
  projectsForSelectionProfile(projects, profile);
  const computeHashes =
    runtime.computeHashes ?? computeSelectionProfileSourceHashes;
  const actualHashes = await computeHashes(options, projects);
  const expectedHashes = {
    corpusFasitSha256: profile.corpusFasitSha256,
    selectedSourceFilesSha256: profile.selectedSourceFilesSha256,
    petoroRequirementSha256: profile.petoroRequirementSha256,
    petoroCustomerSha256: profile.petoroCustomerSha256,
  };
  for (const [field, expected] of Object.entries(expectedHashes)) {
    const actual = actualHashes?.[field] ?? null;
    if (actual !== expected) {
      throw new Error(
        `Selection profile ${profile.name} source hash mismatch for ${field}: expected ${expected}, found ${actual ?? "missing"}.`,
      );
    }
  }
  return {
    name: profile.name,
    profileSha256: profile.profileSha256,
    orderedProjectIds: [...profile.orderedProjectIds],
    sourceHashes: { ...actualHashes },
  };
}

function selectProjects(projects, options) {
  validateSelectionOptions(options);
  const selectionProfile = selectionProfileDefinition(
    options.selectionProfile,
  );
  let selected = selectionProfile
    ? projectsForSelectionProfile(projects, selectionProfile)
    : [...projects];
  if (!selectionProfile && options.corpus) {
    const requestedCorpora = options.corpus
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const unknownCorpora = requestedCorpora.filter(
      (corpus) => !KNOWN_CORPORA.has(corpus),
    );
    if (unknownCorpora.length) {
      throw new Error(
        `Unknown --corpus value(s): ${unknownCorpora.join(", ")}. Expected one or more of ${[
          ...KNOWN_CORPORA,
        ].join(", ")}.`,
      );
    }
    const corpora = new Set(requestedCorpora);
    selected = selected.filter(
      (project) =>
        corpora.has(project.corpus) ||
        (options.includePetoro && project.id === "petoro"),
    );
  }
  if (!selectionProfile && options.only) {
    selected = selected.filter((project) => project.id === options.only);
  }
  if (
    !selectionProfile &&
    (options.fromIndex !== null || options.toIndex !== null)
  ) {
    const from = options.fromIndex ?? 1;
    const to = options.toIndex ?? projects.length;
    selected = selected.filter((_, index) => {
      const oneBased = index + 1;
      return oneBased >= from && oneBased <= to;
    });
  }
  if (selected.length === 0) {
    throw new Error("Project selection is empty before sharding.");
  }
  for (const [label, values] of [
    ["project id", selected.map((project) => project.id)],
    [
      "requirement path",
      selected.map((project) => path.resolve(project.requirementPath)),
    ],
    [
      "source/document identity",
      selected.map(
        (project) =>
          `${normalizeInlineText(project.sourceNumber)}::${normalizeInlineText(
            project.documentName,
          )}`,
      ),
    ],
  ]) {
    const seen = new Set();
    const duplicates = values.filter((value) => {
      if (seen.has(value)) return true;
      seen.add(value);
      return false;
    });
    if (duplicates.length) {
      throw new Error(
        `Project selection has duplicate ${label}: ${[
          ...new Set(duplicates),
        ].join(", ")}.`,
      );
    }
  }
  const baseSelectionCount = selected.length;
  if (options.shardCount !== null) {
    selected = selected.filter(
      (_, index) => index % options.shardCount === options.shardIndex,
    );
  }
  if (options.limit) {
    selected = selected.slice(0, options.limit);
  }
  if (selected.length === 0) {
    throw new Error("Project selection is empty after sharding/limit.");
  }
  if (options.expectSelected !== null) {
    const actual =
      options.shardCount !== null ? baseSelectionCount : selected.length;
    if (actual !== options.expectSelected) {
      throw new Error(
        `Selected project count mismatch: expected ${options.expectSelected}, found ${actual}${
          options.shardCount !== null ? " before sharding" : ""
        }.`,
      );
    }
  }
  return selected;
}

function selectedScope(projects, options) {
  return {
    requestedProjects: projects.length,
    fullScopeExpectedProjects: options.expectSelected ?? projects.length,
    corpus50: projects.filter((project) => project.corpus === "50-folder")
      .length,
    corpus100: projects.filter((project) => project.corpus === "100-folder")
      .length,
    rekkefolge100: projects.filter(
      (project) => project.corpus === "rekkefolge-100",
    ).length,
    petoro: projects.filter((project) => project.id === "petoro").length,
  };
}

async function mergeExistingProjectArtifacts({
  options,
  projects,
  getLiveProject = getDatabaseProject,
}) {
  const results = [];
  let validatedLiveProjectCount = 0;
  for (const project of projects) {
    const artifactPath = path.join(
      options.artifactsRoot,
      "projects",
      `${project.id}.json`,
    );
    if (existsSync(artifactPath)) {
      const checkpointContext = await projectCheckpointContext(
        project,
        options,
      );
      const loaded = await readJsonCheckpoint(artifactPath);
      if (loaded.error) {
        results.push({
          id: project.id,
          corpus: project.corpus,
          projectNumber: project.projectNumber,
          sourceNumber: project.sourceNumber,
          name: project.name,
          documentName: project.documentName,
          requirementPath: project.requirementPath,
          customerPath: project.customerPath,
          error: `Invalid project checkpoint: ${loaded.error}`,
          completedAt: new Date().toISOString(),
        });
        continue;
      }
      const checkpoint = loaded.checkpoint;
      const identityMismatch = checkpointIdentityMismatch(
        checkpoint,
        options,
        checkpointContext,
      );
      if (identityMismatch) {
        results.push({
          id: project.id,
          corpus: project.corpus,
          projectNumber: project.projectNumber,
          sourceNumber: project.sourceNumber,
          name: project.name,
          documentName: project.documentName,
          requirementPath: project.requirementPath,
          customerPath: project.customerPath,
          error: `Checkpoint identity mismatch: ${identityMismatch}.`,
          completedAt: new Date().toISOString(),
        });
        continue;
      }
      if (checkpoint.ok === true) {
        const reuseIssue = await reusableCheckpointIssue({
          checkpoint,
          options,
          project,
          getLiveProject,
        });
        if (reuseIssue) {
          results.push({
            id: project.id,
            corpus: project.corpus,
            projectNumber: project.projectNumber,
            sourceNumber: project.sourceNumber,
            name: project.name,
            documentName: project.documentName,
            requirementPath: project.requirementPath,
            customerPath: project.customerPath,
            error: `Checkpoint reuse rejected: ${reuseIssue}.`,
            completedAt: new Date().toISOString(),
          });
          continue;
        }
        validatedLiveProjectCount += 1;
      }
      results.push(checkpoint);
      continue;
    }
    results.push({
      id: project.id,
      corpus: project.corpus,
      projectNumber: project.projectNumber,
      sourceNumber: project.sourceNumber,
      name: project.name,
      documentName: project.documentName,
      requirementPath: project.requirementPath,
      customerPath: project.customerPath,
      error: "Missing project checkpoint; shard did not complete this row.",
      completedAt: new Date().toISOString(),
    });
  }

  const telemetry = summarizeTelemetry(
    telemetryEventsFromLog(options.serverLogPath),
  );
  const actualLiveRun =
    projects.length > 0 &&
    validatedLiveProjectCount === projects.length &&
    results.length === projects.length &&
    results.every((project) => !project.error);
  const aggregate = aggregateProjects(results, {
    acceptanceMode: options.acceptanceMode ?? "proposal",
  });
  const summary = {
    generatedAt: new Date().toISOString(),
    outputPath: options.outputPath,
    artifactsRoot: options.artifactsRoot,
    reportPath: options.reportPath,
    serverLogPath: options.serverLogPath,
    baseUrl: options.baseUrl || null,
    actualLocalApiRun: actualLiveRun,
    actualFullVurderingRun: actualLiveRun,
    actualKravSvarRun: actualLiveRun,
    ok:
      actualLiveRun &&
      results.length === projects.length &&
      aggregate.ok === true,
    runId: options.runId,
    cleanupManifestPath: options.cleanupManifestPath,
    mergeOnly: true,
    acceptanceMode: aggregate.acceptanceMode,
    customerAnalysisMode: customerAnalysisMode(options),
    solutionEvaluationMode: solutionEvaluationMode(options),
    modelRequested: options.model ?? null,
    configuredModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.4",
    modelConfiguration: resolveRunnerModelPlan(options),
    selectionProfile: selectionProfileMetadata(options),
    scope: {
      ...selectedScope(projects, options),
    },
    aggregate,
    performance: summarizeProjectDurations(results),
    telemetry,
    cost: approximateCost(telemetry),
    costCap: sharedEstimatedCostStatus(options),
    projects: results,
  };

  await writeJson(options.outputPath, summary);
  if (!options.skipReport) {
    await writeHtmlReport({ filePath: options.reportPath, summary });
  }
  const html = await readFile(options.reportPath, "utf8").catch(() => "");
  const rows = html.match(/data-project-row="1"/g)?.length ?? 0;
  const totalDuration = summary.performance.byStage.totalMs;
  console.log(
    `MERGED status=${summary.ok ? "PASS" : "FAIL"} mode=${summary.acceptanceMode} projects=${results.length} pipeline=${summary.aggregate.pipelinePassed}/${summary.aggregate.projects} proposalReady=${summary.aggregate.strong}/${summary.aggregate.projects} failures=${summary.aggregate.failures} executionFailures=${summary.aggregate.executionFailures} acceptanceFailures=${summary.aggregate.acceptanceFailures} reportRows=${rows} calls=${telemetry.totalRequests} callSuccess=${telemetry.completedRequestCount} callFailed=${telemetry.failedRequestCount} callIncomplete=${telemetry.incompleteRequestCount} usageBasis=${telemetry.usageBasis} unknownFileCosts=${telemetry.unknownCostInvocationCount} projectP50Ms=${totalDuration?.p50Ms ?? "n/a"} projectP95Ms=${totalDuration?.p95Ms ?? "n/a"} estCost=$${summary.cost.estimatedCostUsd}`,
  );
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs();
  const modelPlan = resolveRunnerModelPlan(options);

  if (options.validateCleanupManifestOnly) {
    validateSelectionOptions(options);
    if (!existsSync(options.cleanupManifestPath)) {
      throw new Error(
        `Cleanup manifest not found: ${options.cleanupManifestPath}`,
      );
    }
    const events = await cleanupEventsFromEventLog(options);
    const projects = await cleanupProjectsFromEventLog(options, events);
    console.log(
      JSON.stringify(
        {
          runId: options.runId,
          cleanupManifestPath: options.cleanupManifestPath,
          events: events.length,
          registeredProjects: projects.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  await mkdir(path.join(options.artifactsRoot, "projects"), {
    recursive: true,
  });
  await mkdir(path.join(options.artifactsRoot, "evaluations"), {
    recursive: true,
  });
  await mkdir(path.join(options.artifactsRoot, "kravsvar"), {
    recursive: true,
  });

  if (options.cleanupOnly) {
    validateSelectionOptions(options);
    // Cleanup must remain available even if corpus files drift or disappear
    // after a live run created its test projects.
    const server = await startLocalServer(options);
    const api = new ApiClient(server.baseUrl);
    try {
      await api.login();
      await cleanupCreatedProjects(options, api);
    } finally {
      if (server.child && !options.keepServer) {
        server.child.kill("SIGTERM");
      }
    }
    return;
  }
  const discovered = await discoverProjects(options);
  const projects = selectProjects(discovered.projects, options);
  options.selectionProfileVerification =
    await validateSelectionProfileSources(options, discovered.projects);
  if (options.discoverOnly) {
    const scope = selectedScope(projects, options);
    const profileMetadata = selectionProfileMetadata(options);
    const discovery = {
      selectedProjects: projects.length,
      totalProjects: discovered.projects.length,
      corpus50: scope.corpus50,
      corpus100: scope.corpus100,
      rekkefolge100: scope.rekkefolge100,
      petoro: scope.petoro,
      runId: options.runId,
      cleanupManifestPath: options.cleanupManifestPath,
      selectionProfile: profileMetadata?.name ?? null,
      selectionProfileHash: profileMetadata?.profileSha256 ?? null,
      orderedProjectIds:
        profileMetadata?.orderedProjectIds ??
        projects.map((project) => project.id),
      selectedProjectIds: projects.map((project) => project.id),
      selectionProfileSourceHashes:
        options.selectionProfileVerification?.sourceHashes ?? null,
      first: discoveryProjectSummary(projects[0]),
      last: discoveryProjectSummary(projects[projects.length - 1]),
    };
    console.log(JSON.stringify(discovery, null, 2));
    return;
  }
  if (options.mergeOnly) {
    options.resolvedBaseUrl = options.baseUrl || "";
    await mergeExistingProjectArtifacts({ options, projects, discovered });
    return;
  }
  assertRunnerModelPreflight(options);
  console.log(
    `MODEL requested=${modelPlan.requestedModel} default=${modelPlan.configuredDefaultModel} analysis=${modelPlan.configuredAnalysisModel} effectiveDefault=${modelPlan.effectiveDefaultModel} effectiveAnalysis=${modelPlan.effectiveAnalysisModel} strict=${options.strictModel ? "yes" : "no"}`,
  );
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY mangler. Legg nokkelen i .env eller apps/frontend/.env.local.",
    );
  }
  const server = await startLocalServer(options);
  options.resolvedBaseUrl = server.baseUrl;
  const api = new ApiClient(server.baseUrl);
  let protectedPetoroProjects = [];
  const results = [];
  let stoppedOnFailure = null;
  try {
    await api.login();
    protectedPetoroProjects = await recordProtectedPetoroSnapshot(options);
    for (const [index, project] of projects.entries()) {
      const costCapStop = sharedCostCapStopReason(options, project.id);
      if (costCapStop) {
        stoppedOnFailure = costCapStop;
        console.error(
          `  STOPPED ${project.id}: ${costCapStop.issues.join(" ")}`,
        );
        break;
      }
      console.log(
        `\n[${index + 1}/${projects.length}] ${project.id} ${project.name}`,
      );
      const projectRunStartedAt = Date.now();
      try {
        const result = await runProject(project, options, api);
        results.push(result);
        const stopReason = shardStopReason(result, options.acceptanceMode);
        if (stopReason) {
          stoppedOnFailure = {
            projectId: project.id,
            ...stopReason,
          };
          console.error(
            `  STOPPED ${project.id}: ${stopReason.kind} gate failed (${stopReason.issues.join(", ")}).`,
          );
          break;
        }
      } catch (error) {
        const failure = await buildFailureCheckpoint({
          project,
          options,
          error,
          totalMs: Date.now() - projectRunStartedAt,
        });
        results.push(failure);
        await writeJson(
          path.join(options.artifactsRoot, "projects", `${project.id}.json`),
          failure,
        );
        console.error(`  FAILED ${project.id}: ${failure.error}`);
        stoppedOnFailure = {
          projectId: project.id,
          ...shardStopReason(failure, options.acceptanceMode),
        };
        break;
      }
    }
  } finally {
    if (server.child && !options.keepServer) {
      server.child.kill("SIGTERM");
    }
  }

  const telemetry = summarizeTelemetry(
    telemetryEventsFromLog(options.serverLogPath),
  );
  const actualLiveRun =
    results.length === projects.length &&
    !results.some(
      (result) =>
        result.error || result.checkpointReuseRejected === true,
    );
  const aggregate = aggregateProjects(results, {
    acceptanceMode: options.acceptanceMode ?? "proposal",
  });
  const summary = {
    generatedAt: new Date().toISOString(),
    outputPath: options.outputPath,
    artifactsRoot: options.artifactsRoot,
    reportPath: options.reportPath,
    serverLogPath: options.serverLogPath,
    baseUrl: server.baseUrl,
    actualLocalApiRun: actualLiveRun,
    actualFullVurderingRun: actualLiveRun,
    actualKravSvarRun: actualLiveRun,
    ok:
      actualLiveRun &&
      results.length === projects.length &&
      aggregate.ok === true,
    runId: options.runId,
    acceptanceMode: aggregate.acceptanceMode,
    cleanupManifestPath: options.cleanupManifestPath,
    stopOnFirstFailure: true,
    stoppedEarly: results.length < projects.length,
    stoppedOnFailure,
    plannedProjects: projects.length,
    protectedPetoroProjects,
    customerAnalysisMode: customerAnalysisMode(options),
    solutionEvaluationMode: solutionEvaluationMode(options),
    modelRequested: options.model ?? null,
    configuredModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.4",
    modelConfiguration: modelPlan,
    selectionProfile: selectionProfileMetadata(options),
    scope: selectedScope(projects, options),
    aggregate,
    performance: summarizeProjectDurations(results),
    telemetry,
    cost: approximateCost(telemetry),
    costCap: sharedEstimatedCostStatus(options),
    projects: results,
  };

  await writeJson(options.outputPath, summary);
  if (!options.skipReport) {
    await writeHtmlReport({ filePath: options.reportPath, summary });
  }

  const html = await readFile(options.reportPath, "utf8").catch(() => "");
  const rows = html.match(/data-project-row="1"/g)?.length ?? 0;
  const totalDuration = summary.performance.byStage.totalMs;
  console.log(
    `\nDONE status=${summary.ok ? "PASS" : "FAIL"} mode=${summary.acceptanceMode} projects=${results.length} pipeline=${summary.aggregate.pipelinePassed}/${summary.aggregate.projects} proposalReady=${summary.aggregate.strong}/${summary.aggregate.projects} failures=${summary.aggregate.failures} executionFailures=${summary.aggregate.executionFailures} acceptanceFailures=${summary.aggregate.acceptanceFailures} reportRows=${rows} calls=${telemetry.totalRequests} callSuccess=${telemetry.completedRequestCount} callFailed=${telemetry.failedRequestCount} callIncomplete=${telemetry.incompleteRequestCount} usageBasis=${telemetry.usageBasis} unknownFileCosts=${telemetry.unknownCostInvocationCount} projectP50Ms=${totalDuration?.p50Ms ?? "n/a"} projectP95Ms=${totalDuration?.p95Ms ?? "n/a"} estCost=$${summary.cost.estimatedCostUsd}`,
  );
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  await main();
}

export {
  ApiClient,
  HARNESS_CHECKPOINT_SCHEMA_VERSION,
  PETORO_GOLDEN_REQUIREMENT_IDS_V1,
  PETORO_GOLDEN_ORACLE_VERSION,
  PETORO_GOLDEN_TEXT_SHA256_V1,
  PETORO_GOLDEN_TEXT_ANCHORS_V1,
  RELEVANT_25_V1_PROFILE,
  SYNTHETIC_CUSTOMER_DOCUMENT_TITLE,
  SYNTHETIC_CUSTOMER_FILE_NAME,
  aggregateProjects,
  analyzeCleanupBaseline,
  analyzeRequirementCoverageIntegrity,
  assertGeneratedArtifactSourceScope,
  approximateCost,
  buildFailureCheckpoint,
  buildHarnessCanonicalRequirementScope,
  buildLocalPetoroCanonicalPreflight,
  buildIntegrityLedgerFromGeneratedSolutionArtifact,
  buildSyntheticCustomerDocument,
  buildRequirementCoverageLedgerFromDocuments,
  checkpointArtifactHashes,
  checkpointConfigurationRevision,
  checkpointIdentity,
  checkpointIdentityMismatch,
  computeSelectionProfileSourceHashes,
  compareLedgerWithFasitRows,
  compareLedgerWithRequirementOracle,
  cleanupTargetsFromEventsAndDatabase,
  documentTitleForUpload,
  isRunOwnedProject,
  listStoragePrefixFiles,
  mergeExistingProjectArtifacts,
  normalizeRequirementMeaning,
  parseRetryAfterMs,
  protectedPetoroProjectsFromBaseline,
  projectDocumentDetailFromParsed,
  projectCheckpointContext,
  readJsonCheckpoint,
  reusableCheckpointIssue,
  resolveRunnerModelPlan,
  assertRunnerModelPreflight,
  scoreProject,
  selectProjects,
  selectionProfileMetadata,
  selectedScope,
  shardStopReason,
  strictProjectGate,
  sharedEstimatedCostStatus,
  sharedCostCapStopReason,
  technicalProjectGate,
  summarizeTelemetry,
  validateSelectionProfileSources,
  waitForHealth,
  writeHtmlReport,
  writeJson,
};
