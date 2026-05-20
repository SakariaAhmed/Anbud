import "server-only";

import { stripCustomerAnalysisHistory } from "@/lib/customer-analysis-history";
import {
  buildChatPrompt,
  buildCustomerAnalysisPrompt,
  buildDelimitedContext,
  buildExecutiveSummaryPrompt,
  buildGeneratorPrompt,
  buildHighLevelDesignPrompt,
  buildPromptTemplate,
  buildProjectMetadataPrompt,
  buildSyntheticSolutionEvaluationPrompt,
  buildSolutionEvaluationPrompt,
} from "@/lib/server/prompts";
import { normalizeTechnologySignalWords } from "@/lib/signal-words";
import type {
  ChatMessage,
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  ExecutiveSummaryResult,
  GeneratedArtifact,
  GeneratedArtifactType,
  ProjectMetadataInference,
  ProjectDocumentDetail,
  ServiceDocument,
  ServiceDocumentDetail,
  SolutionEvaluationResult,
  ValueCategory,
  ValueOpportunity,
} from "@/lib/types";

export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5.4";
export const WORKSPACE_MODEL_IDS = [
  "gpt-5-mini",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
];
const ANALYSIS_MODEL = DEFAULT_OPENAI_MODEL;
const FAST_MODEL = "gpt-5.4-mini";
type ReasoningEffort = "low" | "medium" | "high";
const ANALYSIS_REASONING_EFFORT: ReasoningEffort = "medium";
const FAST_REASONING_EFFORT: ReasoningEffort = "low";
const GPT_MODELS_USE_DEFAULT_TEMPERATURE = /^gpt-5/i;
const VALUE_CATEGORIES: ValueCategory[] = [
  "Høyere produktivitet",
  "Lavere kostnader",
  "Redusert risiko",
  "Bedre brukeropplevelse",
];

type OpenAIClient = {
  models: {
    list: () => Promise<{
      data: Array<{
        id: string;
        created?: number | null;
        owned_by?: string | null;
      }>;
    }>;
  };
  chat: {
    completions: {
      create: (input: Record<string, unknown>) => Promise<{
        choices: Array<{ message?: { content?: string | null } | null }>;
      }>;
    };
  };
  responses: {
    create: (input: Record<string, unknown>) => Promise<{
      output_text?: string;
    }>;
  };
};

export type OpenAIModelSummary = {
  id: string;
  created: number | null;
  owned_by: string | null;
};

type DocumentInsightDigest = {
  document_summary: string;
  important_requirements: string[];
  implicit_needs: string[];
  risks: string[];
  evaluation_criteria: string[];
  architecture_and_solution_signals: string[];
  technologies_and_standards: string[];
  value_signals: string[];
  visual_or_table_notes: string[];
  source_references: string[];
};

type DocumentTextChunk = {
  label: string;
  text: string;
  references: string[];
};

type DocumentInsightCache = Map<string, Promise<string | null>>;
type RequirementLedgerEntry = {
  id: string;
  text: string;
  pages: number[];
  heading: string;
  documentTitle?: string;
  tableId?: string;
  service?: string;
};
type RequirementBatchAnswer = {
  nr?: number;
  ref?: string;
  svar?: string;
  answer?: string;
};
type PageHeadingEntry = {
  page: number;
  headingPath: string;
  text: string;
};
type MammothHtmlModule = {
  convertToHtml: (input: { buffer: Buffer }) => Promise<{ value: string }>;
};

let cachedClientPromise: Promise<OpenAIClient> | null = null;
let cachedMammothHtmlPromise: Promise<MammothHtmlModule> | null = null;
let cachedModels:
  | {
      expiresAt: number;
      models: OpenAIModelSummary[];
    }
  | null = null;

declare global {
  // eslint-disable-next-line no-var
  var __anbudDocumentInsightCache: DocumentInsightCache | undefined;
}

const LARGE_DOCUMENT_ANALYSIS_THRESHOLD = 18000;
const CHUNK_TEXT_LIMIT = 6500;
const MAX_DOCUMENT_CHUNKS = 8;
const CHUNK_CONCURRENCY = 3;
const REQUIREMENT_RESPONSE_BATCH_SIZE = 22;
const LARGE_REQUIREMENT_RESPONSE_BATCH_SIZE = 30;
const REQUIREMENT_RESPONSE_BATCH_CONCURRENCY = 4;
const REQUIREMENT_RETRIEVAL_STOP_WORDS = new Set([
  "atea",
  "eller",
  "etter",
  "for",
  "fra",
  "gjennom",
  "hvor",
  "ikke",
  "innen",
  "krav",
  "kravet",
  "kunde",
  "kunden",
  "kunne",
  "med",
  "mot",
  "skal",
  "som",
  "the",
  "til",
  "ved",
]);

function getDocumentInsightCache() {
  if (!globalThis.__anbudDocumentInsightCache) {
    globalThis.__anbudDocumentInsightCache = new Map();
  }

  return globalThis.__anbudDocumentInsightCache;
}

function rememberDocumentInsight(
  key: string,
  value: Promise<string | null>,
) {
  const cache = getDocumentInsightCache();
  cache.set(key, value);

  if (cache.size > 50) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  return value;
}

async function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  if (!cachedClientPromise) {
    cachedClientPromise = import("openai").then(
      ({ default: OpenAI }) =>
        new OpenAI({ apiKey }) as unknown as OpenAIClient,
    );
  }

  return cachedClientPromise;
}

async function getMammothHtml() {
  if (!cachedMammothHtmlPromise) {
    cachedMammothHtmlPromise = import("mammoth").then(
      (module) => module as unknown as MammothHtmlModule,
    );
  }

  return cachedMammothHtmlPromise;
}

function normalizeModelId(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > 120 || /[\s<>"'`]/.test(normalized)) {
    throw new Error("Ugyldig modellvalg.");
  }

  return normalized;
}

export async function listAvailableOpenAIModels(): Promise<OpenAIModelSummary[]> {
  if (cachedModels && cachedModels.expiresAt > Date.now()) {
    return cachedModels.models;
  }

  const client = await getClient();
  const response = await client.models.list();

  const models = response.data
    .map((model) => ({
      id: model.id,
      created: model.created ?? null,
      owned_by: model.owned_by ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  cachedModels = {
    expiresAt: Date.now() + 15 * 60 * 1000,
    models,
  };

  return models;
}

export async function resolveOpenAIModelOverride(
  value: string | null | undefined,
) {
  const modelId = normalizeModelId(value);
  if (!modelId) {
    return undefined;
  }

  if (/\bpro\b|5\.5/i.test(modelId)) {
    console.info(
      JSON.stringify({
        event: "openai_model_override_normalized",
        requested_model: modelId,
        selected_model: DEFAULT_OPENAI_MODEL,
        reason: "slow_or_expensive_model",
      }),
    );
    return DEFAULT_OPENAI_MODEL;
  }

  if (![...WORKSPACE_MODEL_IDS, DEFAULT_OPENAI_MODEL].includes(modelId)) {
    throw new Error("Valgt modell er ikke tilgjengelig for denne API-nøkkelen.");
  }

  return modelId;
}

function compactText(value: unknown, limit = 16000) {
  const source = typeof value === "string" ? value : "";
  const normalized = source.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}…`;
}

function documentContext(
  label: string,
  document: ProjectDocumentDetail,
  options?: {
    textLimit?: number;
    structureLimit?: number;
    structureTextLimit?: number;
  },
) {
  const structureLimit = options?.structureLimit ?? 12;
  const structureTextLimit = options?.structureTextLimit ?? 220;
  const structurePreview = document.structure_map
    .slice(0, structureLimit)
    .map(
      (section) =>
        `- ${section.reference}: ${compactText(section.text, structureTextLimit)}`,
    )
    .join("\n");

  return [
    buildDelimitedContext(
      `${label} metadata`,
      [
        `Tittel: ${document.title}`,
        `Filnavn: ${document.file_name}`,
        `Format: ${document.file_format.toUpperCase()}`,
        `Rolle: ${document.role}`,
      ].join("\n"),
    ),
    buildDelimitedContext(
      `${label} struktur`,
      structurePreview || "Ingen struktur tilgjengelig.",
    ),
    buildDelimitedContext(
      `${label} tekst`,
      compactText(document.raw_text, options?.textLimit ?? 22000),
    ),
  ].join("\n\n");
}

function serviceDocumentAsProjectDocument(
  document: ServiceDocumentDetail,
): ProjectDocumentDetail {
  return {
    id: document.id,
    project_id: "global-service-description",
    role: "supporting_document",
    supporting_subtype: null,
    title: document.title,
    file_name: document.file_name,
    file_format: document.file_format,
    content_type: document.content_type,
    file_size_bytes: document.file_size_bytes,
    file_base64: document.file_base64,
    raw_text: document.raw_text,
    structure_map: document.structure_map,
    created_at: document.created_at,
    updated_at: document.updated_at,
  };
}

function fallbackServiceDocumentSummary(document: ServiceDocumentDetail) {
  const structure = document.structure_map
    .slice(0, 4)
    .map((entry) => `${entry.reference}: ${compactText(entry.text, 220)}`)
    .join(" | ");

  return compactText(
    [
      document.title,
      structure,
      compactText(document.raw_text, 900),
    ].filter(Boolean).join("\n"),
    1200,
  );
}

export async function summarizeServiceDocumentForAi(input: {
  title: string;
  fileName: string;
  rawText: string;
}) {
  return createTextCompletion({
    system: buildPromptTemplate({
      role: "Du lager korte, presise AI-sammendrag av tjenestebeskrivelser for tilbudsarbeid.",
      task: [
        "Oppsummer tjenestedokumentet slik at en senere AI raskt kan vurdere om tjenesten er relevant for et kundeprosjekt.",
      ],
      rules: [
        "Skriv på norsk.",
        "Maks 140 ord.",
        "Fokuser på leveranseområde, ansvar, driftsmodell, sikkerhet, SLA, avgrensninger, kundebidrag, verktøy og typiske krav tjenesten besvarer.",
        "Ikke skriv markedsføring eller generiske kvalitetsutsagn.",
      ],
      outputContract: ["Returner ren tekst, ikke JSON."],
      exampleOutput:
        "Tjenesten dekker <leveranseområde>, med ansvar for <ansvar>, typiske krav om <kravtyper> og avgrensninger rundt <avgrensning>.",
    }),
    user: [
      buildDelimitedContext(
        "Dokumentmetadata",
        [`Tittel: ${input.title}`, `Filnavn: ${input.fileName}`].join("\n"),
      ),
      buildDelimitedContext("Dokumenttekst", compactText(input.rawText, 10000)),
    ].join("\n\n"),
    temperature: 0.1,
    model: FAST_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
  });
}

function splitPdfPages(rawText: string) {
  const parts = rawText.split(/\[\[SIDE:(\d+)\]\]/g);
  const pages: Array<{ page: number; text: string }> = [];

  for (let index = 1; index < parts.length; index += 2) {
    const page = Number(parts[index]);
    const text = normalizePageText(parts[index + 1] ?? "");

    if (Number.isFinite(page) && text) {
      pages.push({ page, text });
    }
  }

  return pages;
}

function splitPdfPagesPreservingLines(rawText: string) {
  const parts = rawText.split(/\[\[SIDE:(\d+)\]\]/g);
  const pages: Array<{ page: number; text: string }> = [];

  for (let index = 1; index < parts.length; index += 2) {
    const page = Number(parts[index]);
    const text = (parts[index + 1] ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\bSide\s+\d+\s+av\s+\d+\b/gi, " ")
      .replace(/\bKonfidensiell\b/gi, " ")
      .replace(/\bRA-\d+\s+BILAG\s+[\d,]+\s+TIL\s+SSA-D\s+\d{4}\b/gi, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (Number.isFinite(page) && text) {
      pages.push({ page, text });
    }
  }

  return pages;
}

function normalizePageText(value: string) {
  return value
    .replace(/\bSide\s+\d+\s+av\s+\d+\b/gi, " ")
    .replace(/\bKonfidensiell\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRequirementId(value: string) {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*\.\s*/g, ".")
    .trim()
    .replace(/^krav\s*(?:nr\.?|nummer)?\s*/i, "Krav ")
    .replace(/^id\s*/i, "ID ")
    .replace(/^req\s*[- ]?\s*/i, "REQ-");

  if (/^Krav\b/i.test(cleaned)) {
    return cleaned.replace(/^krav\b/i, "Krav");
  }

  if (/^ID\b/i.test(cleaned)) {
    return cleaned.replace(/^id\b/i, "ID");
  }

  if (/^REQ-/i.test(cleaned)) {
    return cleaned.toUpperCase();
  }

  return cleaned.toUpperCase();
}

function documentRequirementId(value: string) {
  return normalizePageText(value)
    .replace(/\s+([,;:])/g, "$1")
    .trim();
}

function requirementIdPattern() {
  return /\bKrav\s*(?:nr\.?|nummer)?\s*\d{1,3}(?:\s*[.-]\s*\d{1,3}){0,5}[A-Z]?\b|\bID\s*\d{1,3}(?:\s*[.-]\s*\d{1,3}){1,5}[A-Z]?\b|\bREQ\s*[- ]?\s*\d{1,5}[A-Z]?\b|\b(?:[A-ZÆØÅ]{1,5}\s*)?\d{1,3}(?:\s*[.-]\s*\d{1,3}){1,5}[A-Z]?\b/gi;
}

function detectRequirementIds(text: string) {
  const normalized = normalizePageText(text);
  const matches = normalized.matchAll(requirementIdPattern());
  const ids: string[] = [];

  for (const match of matches) {
    const id = documentRequirementId(match[0]);
    const normalizedId = normalizeRequirementId(id);
    if (!ids.some((existing) => normalizeRequirementId(existing) === normalizedId)) {
      ids.push(id);
    }
  }

  return ids;
}

function hasRequirementSignal(value: string) {
  const text = normalizePageText(value);
  if (text.length < 18 || text.length > 1600) {
    return false;
  }

  return /\b(skal|må|bør|bes|krever|forutsetter|ønsker|etterspør|skal kunne|må kunne|shall|must|should|required|responsible)\b/i.test(
    text,
  );
}

function isStructuredRequirementStart(value: string) {
  const text = normalizePageText(value);
  return (
    detectRequirementIds(text).length > 0 ||
    /^\s*(?:[-*•]|\d{1,3}[.)]|\d+(?:\.\d+){1,4})\s+/.test(value) ||
    /^\s*(?:Krav|Requirement|Leverandøren|Tilbyder|Løsningen|Tjenesten|Systemet|Plattformen|Kunden)\b/i.test(
      text,
    )
  );
}

function syntheticRequirementId(page: number, index: number) {
  return `Side ${page} krav ${index}`;
}

function pageExcerpt(text: string, position: "start" | "end") {
  const normalized = normalizePageText(text);
  if (normalized.length <= 260) {
    return normalized;
  }

  return position === "start"
    ? `${normalized.slice(0, 260)}...`
    : `...${normalized.slice(-260)}`;
}

function buildRequirementContinuityContext(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return "";
  }

  const pages = splitPdfPages(document.raw_text);
  if (!pages.length) {
    return "";
  }

  const lines: string[] = [
    `Dokument: ${document.title}`,
    "Denne kontrollen styrer kravdeling over sideskift:",
    "- Opprett ny kravrad bare når en ny krav-ID er synlig i kravdokumentet, eller når teksten åpenbart starter et nytt selvstendig krav med egen markør.",
    "- Ikke finn opp neste løpenummer. Tekst på ny side uten synlig krav-ID er fortsettelse av forrige krav.",
    "- Hvis en side starter med kravtekst, men uten ny ID, skal teksten slås sammen med forrige krav og samme krav-ID beholdes.",
    "",
  ];
  let lastExplicitId: string | null = null;

  for (const page of pages.slice(0, 60)) {
    const ids = detectRequirementIds(page.text);

    if (ids.length) {
      lastExplicitId = ids[ids.length - 1] ?? lastExplicitId;
      lines.push(
        `Side ${page.page}: synlige krav-ID-er: ${ids.join(", ")}. Start: ${pageExcerpt(page.text, "start")}`,
      );
      continue;
    }

    if (lastExplicitId) {
      lines.push(
        `Side ${page.page}: ingen ny synlig krav-ID. Behandle teksten som fortsettelse av ${lastExplicitId}, ikke som nytt krav. Start: ${pageExcerpt(page.text, "start")}`,
      );
    } else {
      lines.push(
        `Side ${page.page}: ingen synlig krav-ID. Ikke opprett krav-ID basert på antatt løpenummer. Start: ${pageExcerpt(page.text, "start")}`,
      );
    }
  }

  return buildDelimitedContext(
    `Sideskift- og krav-ID-kontroll for ${document.title}`,
    lines.join("\n"),
  );
}

function stripRequirementChrome(text: string) {
  return normalizePageText(text)
    .replace(/\bLeverandørens\s+besvarelse\b/gi, " ")
    .replace(/\bRA-\d+\s+BILAG\s+[\d,]+\s+TIL\s+SSA-D\s+\d{4}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHeadingCandidate(value: string) {
  return stripRequirementChrome(value)
    .replace(/\bLeverandørens\s+besvarelse\s+ID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?\b/gi, " ")
    .replace(/\bID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?\b/gi, " ")
    .replace(/^[•\-–—:;.,\s]+|[•\-–—:;.,\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyHeadingLine(line: string) {
  if (/^\s*[•\-–—]/.test(line)) {
    return false;
  }

  const cleaned = cleanHeadingCandidate(line);
  if (!cleaned || cleaned.length < 4 || cleaned.length > 90) {
    return false;
  }

  if (/^ID\b/i.test(cleaned) || /^[\d\s.-]+$/.test(cleaned)) {
    return false;
  }

  if (/[.!?]$/.test(cleaned)) {
    return false;
  }

  const wordCount = cleaned.split(/\s+/).length;
  if (wordCount > 9) {
    return false;
  }

  if (/^(og|eller|som|for|til|i|av|på|med)\b/i.test(cleaned)) {
    return false;
  }

  if (/\b(skal|må|kan|bes|forbeholder|innebærer|ansvarlig|tilgjengelig)\b/i.test(cleaned)) {
    return false;
  }

  return (
    /^[A-ZÆØÅ0-9]/.test(cleaned) &&
    (wordCount <= 5 ||
      /^[A-ZÆØÅ][A-ZÆØÅ0-9\s/().,-]{4,}$/.test(cleaned) ||
      /^\d+(\.\d+)*\s+\S+/.test(cleaned))
  );
}

function headingLevel(heading: string) {
  const cleaned = cleanHeadingCandidate(heading);

  if (/^\d+\.\d+/.test(cleaned)) {
    return 2;
  }
  if (/^\d+/.test(cleaned) || /krav\b/i.test(cleaned)) {
    return 1;
  }
  return 2;
}

function buildHeadingPath(stack: string[]) {
  return stack.filter(Boolean).slice(-3).join(" > ");
}

function normalizeTableId(value: string) {
  const match = value.match(/(?:tabell\s*)?ID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?/i);
  return match ? documentRequirementId(match[0]) : "";
}

function normalizePdfSpacing(value: string) {
  return value
    .replace(/\bPetor\s*os\b/gi, "Petoros")
    .replace(/\bI\s*D\b/gi, "ID")
    .replace(/\bkr\s*a\s*v\b/gi, "krav")
    .replace(/\bTa\s*b\s*e\s*ll\b/gi, "Tabell")
    .replace(/\bD\s*el\b/gi, "Del")
    .replace(/\bL\s*ever\s*a\s*ndør\s*ens\s*sva\s*r\b/gi, "Leverandørens svar")
    .replace(/\bT\s*j\s*eneste\b/gi, "Tjeneste")
    .replace(/\bSpesi\s*f\s*i\s*ser\s*te\s*kr\s*a\s*v\b/gi, "Spesifiserte krav")
    .replace(/\bD\s*eta\s*l\s*j\s*er\s*i\s*ng\s*er\b/gi, "Detaljeringer")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTableId(line: string) {
  const normalized = normalizePdfSpacing(line);
  const match = normalized.match(
    /\bTabell\s*ID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?/i,
  );
  return match ? normalizeTableId(match[0]) : "";
}

function isTableHeaderOrAnswerLine(line: string) {
  return /^(Tjeneste|Spesifiserte krav|Ja|Nei|Del\b|-vis|Detaljeringer\b|Leverandørens svar)/i.test(
    normalizePdfSpacing(line),
  );
}

function tableRequirementStartIndex(line: string) {
  const normalized = normalizePdfSpacing(line);
  const patterns = [
    /\b(?:Leverandøren|Tilbyder|Oppdragstaker|Avtalepart|Leverandør)\s+(?:skal|må|bes|bør|har|kan)\b/i,
    /\b(?:Løsningen|Løsningene|Tjenesten|Tjenestene|Systemet|Plattformen)\s+(?:skal|må|bør|kan)\b/i,
    /\bKunden\s+(?:skal|kan|må)\b/i,
    /\bAll\s+drifts-/i,
    /\bOversikt\s+over\b/i,
    /\bI\s+samråd\s+med\s+Kunden\b/i,
    /\bFølgende\s+oppgaver\b/i,
    /\bDet\s+(?:skal|er)\b/i,
    /\bKrav(?:et|ene)?\s+(?:skal|må|bør)\b/i,
  ];

  const indexes = patterns
    .map((pattern) => normalized.search(pattern))
    .filter((index) => index >= 0);

  return indexes.length ? Math.min(...indexes) : -1;
}

function cleanTableService(value: string) {
  return normalizePdfSpacing(value)
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTableRequirement(value: string) {
  return normalizePdfSpacing(value)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRequirementLedgerText(value: string) {
  return normalizePdfSpacing(value)
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function isTableOfContentsLine(value: string) {
  const text = normalizePdfSpacing(value);
  return (
    /^Table of Contents$/i.test(text) ||
    /\.{5,}\s*\d{1,4}\s*$/.test(text)
  );
}

function isTableOfContentsRequirementCandidate(entry: RequirementLedgerEntry) {
  const text = normalizePdfSpacing(entry.text);
  return (
    /table of contents/i.test(entry.heading) ||
    (isTableOfContentsLine(text) && !hasRequirementSignal(text))
  );
}

function isTableContainerRequirement(entry: RequirementLedgerEntry) {
  if (entry.tableId) {
    return false;
  }

  const text = normalizeRequirementLedgerText(entry.text);
  const tableMarkerCount = (
    text.match(/\btabell\s+id\s+\d{1,3}-\d{1,3}[a-z]?\b/g) ?? []
  ).length;

  const hasTableIntroLanguage =
    /\b(følgende|nedenfor|under|tabell|tabellene|oversikt|oppgaver|aktiviteter|krav)\b/i.test(
      text,
    );
  const hasManyRequirementSignals =
    (text.match(/\b(?:skal|må|bes|bør)\b/g) ?? []).length >= 4;

  return (
    tableMarkerCount >= 2 ||
    (tableMarkerCount >= 1 &&
      text.length >= 700 &&
      hasTableIntroLanguage &&
      hasManyRequirementSignals)
  );
}

function isLikelyTableServiceLine(line: string) {
  const cleaned = cleanTableService(line);
  if (!cleaned || cleaned.length > 70 || /[.!?]$/.test(cleaned)) {
    return false;
  }

  const wordCount = cleaned.split(/\s+/).length;
  return wordCount <= 5 && !/\b(skal|må|kan|bes|følge|sikre|utføre)\b/i.test(cleaned);
}

function buildPageHeadingMap(document: ProjectDocumentDetail) {
  const map = new Map<number, string>();
  const stack: string[] = [];

  for (const page of splitPdfPagesPreservingLines(document.raw_text).slice(0, 120)) {
    const lines = page.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines.slice(0, 30)) {
      if (!isLikelyHeadingLine(line)) {
        continue;
      }

      const level = headingLevel(line);
      stack[level - 1] = line;
      stack.length = level;
    }

    const path = buildHeadingPath(stack);
    if (path) {
      map.set(page.page, path);
    }
  }

  return map;
}

function findHeadingBeforeOffset(
  pageText: string,
  offset: number,
  fallback: string,
) {
  const before = pageText.slice(0, Math.max(0, offset));
  const lines = before
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headings = lines.filter(isLikelyHeadingLine);

  if (!headings.length) {
    return fallback;
  }

  return buildHeadingPath(headings.slice(-3)) || fallback;
}

function buildTableRequirementLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const pageHeadingMap = buildPageHeadingMap(document);
  const requirements: RequirementLedgerEntry[] = [];
  let activeTableId = "";
  let current:
    | {
        tableId: string;
        service: string;
        text: string;
        pages: number[];
        heading: string;
      }
    | null = null;
  let serviceBuffer: string[] = [];
  let pendingServiceBuffer: string[] = [];

  function flushCurrent() {
    if (!current) {
      return;
    }

    const text = cleanTableRequirement(current.text);
    if (text.length >= 20) {
      requirements.push({
        id: `${current.tableId}${current.service ? ` - ${current.service}` : ""}`,
        text,
        pages: current.pages,
        heading: current.heading,
        tableId: current.tableId,
        service: current.service,
      });
    }
    current = null;
  }

  function flushPendingServiceIntoCurrent() {
    if (current && pendingServiceBuffer.length) {
      current.text = [current.text, pendingServiceBuffer.join(" ")]
        .filter(Boolean)
        .join(" ");
    }
    pendingServiceBuffer = [];
  }

  function startRow(input: {
    tableId: string;
    service: string;
    text: string;
    page: number;
    heading: string;
  }) {
    flushCurrent();
    current = {
      tableId: input.tableId,
      service: cleanTableService(input.service),
      text: cleanTableRequirement(input.text),
      pages: [input.page],
      heading: input.heading,
    };
    serviceBuffer = [];
    pendingServiceBuffer = [];
  }

  function appendToCurrent(line: string, page: number, heading: string) {
    if (!current) {
      serviceBuffer.push(line);
      return;
    }

    flushPendingServiceIntoCurrent();
    current.text = [current.text, line].filter(Boolean).join(" ");
    if (!current.pages.includes(page)) {
      current.pages.push(page);
    }
    if (heading) {
      current.heading = heading;
    }
  }

  for (const page of splitPdfPagesPreservingLines(document.raw_text).slice(0, 120)) {
    const pageHeading = pageHeadingMap.get(page.page) ?? "";
    const lines = page.text
      .split("\n")
      .map((line) => normalizePdfSpacing(line))
      .filter(Boolean);

    for (const line of lines) {
      const tableId = detectTableId(line);
      if (tableId) {
        if (current && tableId === activeTableId) {
          serviceBuffer = [];
          pendingServiceBuffer = [];
          continue;
        }

        flushPendingServiceIntoCurrent();
        flushCurrent();
        activeTableId = tableId;
        serviceBuffer = [];
        pendingServiceBuffer = [];
        continue;
      }

      if (!activeTableId || isTableHeaderOrAnswerLine(line)) {
        continue;
      }

      if (/^Leverandørens\s+besvarelse\b/i.test(line)) {
        flushPendingServiceIntoCurrent();
        flushCurrent();
        activeTableId = "";
        serviceBuffer = [];
        pendingServiceBuffer = [];
        continue;
      }

      const requirementIndex = tableRequirementStartIndex(line);
      if (requirementIndex >= 0) {
        const beforeRequirement = cleanTableService(line.slice(0, requirementIndex));
        const requirementText = cleanTableRequirement(line.slice(requirementIndex));
        const rowService =
          /^[A-ZÆØÅ]/.test(beforeRequirement) &&
          isLikelyTableServiceLine(beforeRequirement)
            ? beforeRequirement
            : "";
        const service = [
          serviceBuffer.join(" "),
          pendingServiceBuffer.join(" "),
          rowService,
        ]
          .map(cleanTableService)
          .filter(Boolean)
          .join(" ");

        if (current && (service || pendingServiceBuffer.length) && requirementIndex >= 0) {
          startRow({
            tableId: activeTableId,
            service,
            text: requirementText,
            page: page.page,
            heading: pageHeading,
          });
          continue;
        }

        if (!current) {
          startRow({
            tableId: activeTableId,
            service,
            text: requirementText,
            page: page.page,
            heading: pageHeading,
          });
          continue;
        }
      }

      if (
        current &&
        isLikelyTableServiceLine(line) &&
        (/^[A-ZÆØÅ]/.test(line) || pendingServiceBuffer.length > 0)
      ) {
        pendingServiceBuffer.push(line);
        continue;
      }

      appendToCurrent(line, page.page, pageHeading);
    }
  }

  flushCurrent();
  return requirements;
}

function splitDocumentPagesForRequirementScan(document: ProjectDocumentDetail) {
  if (document.file_format === "pdf") {
    const pages = splitPdfPagesPreservingLines(document.raw_text);
    if (pages.length) {
      return pages;
    }
  }

  return [{ page: 1, text: document.raw_text.replace(/\r\n/g, "\n").trim() }];
}

function dedupeRequirementLedger(entries: RequirementLedgerEntry[]) {
  const seen = new Set<string>();
  const result: RequirementLedgerEntry[] = [];

  for (const entry of entries) {
    if (isTableOfContentsRequirementCandidate(entry)) {
      continue;
    }

    const id = normalizeRequirementId(entry.id);
    const text = normalizeEvidenceText(entry.text);
    const key = id ? `${id}:${text.slice(0, 120)}` : text.slice(0, 180);
    if (!text || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(entry);
  }

  return result;
}

function buildStructuredRequirementLedger(document: ProjectDocumentDetail) {
  const pageHeadingMap =
    document.file_format === "pdf" ? buildPageHeadingMap(document) : new Map<number, string>();
  const requirements: RequirementLedgerEntry[] = [];
  let sequence = 1;

  for (const page of splitDocumentPagesForRequirementScan(document).slice(0, 160)) {
    const pageHeading = pageHeadingMap.get(page.page) ?? "";
    const blocks = page.text
      .split(/\n{2,}|(?=\n\s*(?:[-*•]|\d{1,3}[.)]|\d+(?:\.\d+){1,4})\s+)/g)
      .map((block) => block.replace(/\n+/g, " ").trim())
      .filter(Boolean);

    for (const block of blocks) {
      const text = stripRequirementChrome(block);
      if (!hasRequirementSignal(text) || !isStructuredRequirementStart(block)) {
        continue;
      }

      const explicitId = detectRequirementIds(text)[0] ?? "";
      requirements.push({
        id: explicitId || syntheticRequirementId(page.page, sequence),
        text,
        pages: [page.page],
        heading: pageHeading,
      });
      sequence += 1;
    }
  }

  return dedupeRequirementLedger(requirements);
}

function isRequirementTableHeaderLabel(line: string) {
  return /^(Req\.?\s*No\.?|Requirement text|Type|Response instruction|Y\/N|Detailed response)$/i.test(
    line.trim(),
  );
}

function isRequirementTypeOrInstructionLine(line: string) {
  const trimmed = line.trim();
  return (
    /^(M|E|O|A|B|C|D|K|S)$/i.test(trimmed) ||
    /^(M|E|O|A|B|C|D|K|S)\s+TK\s*\d+$/i.test(trimmed) ||
    /^TK\s*\d+$/i.test(trimmed) ||
    /^Relevant experience,\s*technical depth,\s*delivery\s+capability$/i.test(
      trimmed,
    )
  );
}

function buildLinearTableRequirementLedger(document: ProjectDocumentDetail) {
  const lines = document.raw_text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizePageText(line))
    .filter(Boolean);
  const requirements: RequirementLedgerEntry[] = [];
  let activeHeading = "";
  let inRequirementTable = false;
  let sequence = 1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";

    if (/^Req\.?\s*No\.?$/i.test(line)) {
      inRequirementTable = true;
      activeHeading = lines[index - 1] && !isRequirementTableHeaderLabel(lines[index - 1])
        ? lines[index - 1]
        : activeHeading;
      continue;
    }

    if (!inRequirementTable) {
      continue;
    }

    if (
      isRequirementTableHeaderLabel(line) ||
      isRequirementTypeOrInstructionLine(line) ||
      /^(Requirements to|Competence requirements to)\b/i.test(line)
    ) {
      continue;
    }

    if (/^Req\.?\s*No\.?$/i.test(next)) {
      activeHeading = line;
      continue;
    }

    if (line.length < 18) {
      continue;
    }

    requirements.push({
      id: syntheticRequirementId(1, sequence),
      text: line,
      pages: [1],
      heading: activeHeading,
    });
    sequence += 1;
  }

  return dedupeRequirementLedger(requirements);
}

function isPdfRequirementTableHeaderStart(lines: string[], index: number) {
  const current = normalizePdfSpacing(lines[index] ?? "");
  const next = normalizePdfSpacing(lines[index + 1] ?? "");
  const windowText = normalizePdfSpacing(lines.slice(index, index + 8).join(" "));

  return (
    /^Req\.?\s*No\.?$/i.test(windowText) ||
    (/^Req\.?$/i.test(current) &&
      /^No\.?$/i.test(next) &&
      /Requirement text/i.test(windowText)) ||
    (/^Req\.?\s*No\.?$/i.test(current) && /Requirement text/i.test(windowText))
  );
}

function isPdfRequirementSectionHeading(line: string) {
  const text = normalizePdfSpacing(line);
  if (
    isTableOfContentsLine(text) ||
    isRequirementTableHeaderLabel(text) ||
    /^Page\s+\d+\s+of\s+\d+$/i.test(text) ||
    /^Operational\s+Services\s+Agreement$/i.test(text) ||
    /^Annex\s+\d+[A-Z]?\b/i.test(text)
  ) {
    return false;
  }

  return /^\d{1,3}(?:\.\d{1,3}){0,4}\s+\S/.test(text);
}

function pdfRequirementRowId(line: string) {
  const text = documentRequirementId(line);
  if (
    /^Krav\s*(?:nr\.?|nummer)?\s*\d{1,4}(?:[.-]\d{1,4}){0,5}[A-Z]?$/i.test(text) ||
    /^ID\s*\d{1,4}(?:[.-]\d{1,4}){1,5}[A-Z]?$/i.test(text) ||
    /^REQ\s*[- ]?\s*\d{1,5}[A-Z]?$/i.test(text) ||
    /^\d{1,4}(?:[.-]\d{1,4}){1,5}[A-Z]?$/.test(text)
  ) {
    return text;
  }

  return "";
}

function isPdfRequirementTypeLine(line: string) {
  const text = normalizePdfSpacing(line);
  return (
    /^(M|E|O|A|B|C|D|K|S)$/i.test(text) ||
    /^(M|E|O|A|B|C|D|K|S),?$/i.test(text) ||
    /^(M|E|O|A|B|C|D|K|S),?\s*TK\s*\d+$/i.test(text) ||
    /^TK\s*\d+$/i.test(text)
  );
}

function isPdfRequirementBoilerplateLine(line: string) {
  const text = normalizePdfSpacing(line);
  return (
    !text ||
    isTableOfContentsLine(text) ||
    isRequirementTableHeaderLabel(text) ||
    /^(Req\.?|No\.?|Requirement text(?:\s+Type)?|Type|Response|instruction|Y\/N|Detailed|response)$/i.test(
      text,
    ) ||
    /^Page\s+\d+\s+of\s+\d+$/i.test(text) ||
    /^Operational\s+Services\s+Agreement$/i.test(text) ||
    /^Annex\s+\d+[A-Z]?\b/i.test(text)
  );
}

function cleanPdfRequirementText(lines: string[]) {
  return lines
    .map((line) => normalizePdfSpacing(line))
    .filter((line) => line && !isPdfRequirementBoilerplateLine(line))
    .join(" ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPdfRequirementTableLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const pageHeadingMap = buildPageHeadingMap(document);
  const requirements: RequirementLedgerEntry[] = [];
  let activeHeading = "";
  let inRequirementTable = false;
  let current:
    | {
        id: string;
        textLines: string[];
        instructionLines: string[];
        pages: number[];
        heading: string;
        phase: "text" | "instruction";
      }
    | null = null;

  function flushCurrent() {
    if (!current) {
      return;
    }

    const text = cleanPdfRequirementText(current.textLines);
    const responseInstruction = cleanPdfRequirementText(current.instructionLines);
    if (text.length >= 18) {
      requirements.push({
        id: current.id,
        text: responseInstruction
          ? `${text} Responsinstruks: ${responseInstruction}`
          : text,
        pages: current.pages,
        heading: current.heading,
        tableId: "PDF kravtabell",
      });
    }
    current = null;
  }

  for (const page of splitPdfPagesPreservingLines(document.raw_text).slice(0, 160)) {
    const pageHeading = pageHeadingMap.get(page.page) ?? activeHeading;
    const lines = page.text
      .split("\n")
      .map((line) => normalizePdfSpacing(line))
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";

      if (isPdfRequirementSectionHeading(line)) {
        const rowId = pdfRequirementRowId(line);
        if (!rowId) {
          activeHeading = cleanHeadingCandidate(line);
          inRequirementTable = false;
          flushCurrent();
          continue;
        }
      }

      if (isPdfRequirementTableHeaderStart(lines, index)) {
        inRequirementTable = true;
        if (!activeHeading && pageHeading) {
          activeHeading = pageHeading;
        }
        continue;
      }

      if (!inRequirementTable || isPdfRequirementBoilerplateLine(line)) {
        continue;
      }

      const rowId = pdfRequirementRowId(line);
      if (rowId) {
        flushCurrent();
        current = {
          id: rowId,
          textLines: [],
          instructionLines: [],
          pages: [page.page],
          heading: activeHeading || pageHeading,
          phase: "text",
        };
        continue;
      }

      if (!current) {
        continue;
      }

      if (!current.pages.includes(page.page)) {
        current.pages.push(page.page);
      }
      if (!current.heading && (activeHeading || pageHeading)) {
        current.heading = activeHeading || pageHeading;
      }

      if (isPdfRequirementTypeLine(line)) {
        current.phase = "instruction";
        continue;
      }

      if (current.phase === "instruction") {
        current.instructionLines.push(line);
      } else {
        current.textLines.push(line);
      }
    }
  }

  flushCurrent();
  return dedupeRequirementLedger(requirements);
}

function decodeHtmlText(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    );
}

function htmlCellText(value: string) {
  return decodeHtmlText(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function parseHtmlTableRows(html: string) {
  const rows: string[][] = [];

  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1] ?? "";
    const cells = [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((match) => htmlCellText(match[1] ?? ""));

    if (cells.some((cell) => cell.trim().length > 0)) {
      rows.push(cells);
    }
  }

  return rows;
}

function isRequirementTableHeaderCells(cells: string[]) {
  const normalized = cells.map((cell) => normalizePageText(cell).toLowerCase());
  return (
    normalized.some((cell) => /^req\.?\s*no\.?$/.test(cell)) &&
    normalized.some((cell) => cell === "requirement text")
  );
}

function looksLikeDocxRequirementRow(cells: string[], inRequirementTable: boolean) {
  if (cells.length < 2 || isRequirementTableHeaderCells(cells)) {
    return false;
  }

  const requirementText = normalizePageText(cells[1] ?? "");
  if (requirementText.length < 18) {
    return false;
  }

  if (/^(requirement text|response instruction|detailed response)$/i.test(requirementText)) {
    return false;
  }

  if (cells.length >= 5 && inRequirementTable) {
    return true;
  }

  return (
    cells.length >= 5 &&
    (isRequirementTypeOrInstructionLine(cells[2] ?? "") ||
      /^(yes|no|y|n)$/i.test(normalizePageText(cells[4] ?? "")) ||
      hasRequirementSignal(requirementText))
  );
}

function lastHeadingSegment(heading: string) {
  return heading
    .split(">")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

function shortRequirementName(requirementText: string, responseInstruction: string) {
  const text = normalizePageText(requirementText);
  const instruction = normalizePageText(responseInstruction);
  const patterns = [
    /\bContinuous Services\b/i,
    /\bThird-Party Suppliers?\b/i,
    /\bService Definitions?\b/i,
    /\btechnical platform\b/i,
    /\bon-prem hosting platform to cloud hosting\b/i,
    /\broutine tasks\b/i,
    /\bAzure-environment\b/i,
    /\bsustainability efforts?\b/i,
    /\bpricing of this Tower\b/i,
    /\bSLAs? for this Tower\b/i,
  ];
  const matchedPattern = patterns
    .map((pattern) => text.match(pattern)?.[0])
    .find(Boolean);

  if (matchedPattern) {
    return matchedPattern
      .replace(/\bSLAs?\b/i, "SLA")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (instruction && instruction.length <= 80) {
    return instruction;
  }

  return text
    .replace(/^(The Contractor|Contractor|Leverandøren)\s+(shall|must|skal|må|bør)\s+/i, "")
    .replace(/^(All the|All)\s+/i, "")
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/[.,;:]$/g, "")
    .trim();
}

function docxRequirementId(input: {
  cells: string[];
  sequence: number;
  heading: string;
  responseInstruction: string;
}) {
  const { cells, heading, responseInstruction, sequence } = input;
  const explicitId = normalizePageText(cells[0] ?? "");
  if (
    explicitId &&
    !/^(req\.?\s*no\.?|requirement text)$/i.test(explicitId) &&
    explicitId.length <= 80
  ) {
    return explicitId;
  }

  const section = lastHeadingSegment(heading) || "Kravtabell";
  const name = shortRequirementName(cells[1] ?? "", responseInstruction);

  return [section, String(sequence), name ? `- ${name}` : ""]
    .filter(Boolean)
    .join(" ");
}

function isDocxRequirementHeadingLine(line: string) {
  const normalized = normalizePageText(line).replace(/:$/, "");

  if (
    isRequirementTableHeaderLabel(normalized) ||
    /^(Y\/N|Detailed response|Additional capabilities|Automation|Governance|FinOps|Security|Process|Efforts,\s*impact)$/i.test(
      normalized,
    ) ||
    /^TK\s*\d+$/i.test(normalized) ||
    /^(M|E|O|A|B|C|D|K|S)(?:,\s*TK\s*\d+)?$/i.test(normalized)
  ) {
    return false;
  }

  return /^(ANNEX\s+\d+[A-Z]?|Background and purpose|Services in the Hybrid Infrastructure Tower|Private Cloud|Public Cloud(?:\s+[–-]\s+Azure)?|Data Room|Requirements to|Functional requirements|Commercial requirements)/i.test(
    normalized,
  );
}

function findDocxHeadingForRequirement(
  rawText: string,
  requirementText: string,
  fallback: string,
) {
  const lead = normalizePageText(requirementText)
    .split(/\s+/)
    .slice(0, 10)
    .join(" ");
  if (!lead) {
    return fallback;
  }

  const lines = rawText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const stack: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isLikelyHeadingLine(line) && isDocxRequirementHeadingLine(line)) {
      const level = headingLevel(line);
      stack[level - 1] = cleanHeadingCandidate(line);
      stack.length = level;
    }

    const windowText = normalizePageText(lines.slice(index, index + 8).join(" "));
    if (windowText.includes(lead)) {
      return buildHeadingPath(stack) || fallback;
    }
  }

  return fallback;
}

async function buildDocxTableRequirementLedger(document: ProjectDocumentDetail) {
  if (
    document.file_format !== "docx" ||
    !document.file_base64 ||
    document.file_base64.length < 100
  ) {
    return [];
  }

  try {
    const mammoth = await getMammothHtml();
    const html = await mammoth.convertToHtml({
      buffer: Buffer.from(document.file_base64, "base64"),
    });
    const rows = parseHtmlTableRows(html.value);
    const requirements: RequirementLedgerEntry[] = [];
    let activeHeading = "";
    let inRequirementTable = false;
    let sequence = 1;
    const headingCounts = new Map<string, number>();

    for (const cells of rows) {
      if (isRequirementTableHeaderCells(cells)) {
        inRequirementTable = true;
        continue;
      }

      if (
        cells.length === 1 &&
        /^(Requirements to|Competence requirements to|Functional requirements|Commercial requirements|Annex\s+\d+)/i.test(
          cells[0] ?? "",
        )
      ) {
        activeHeading = normalizePageText(cells[0] ?? "");
        continue;
      }

      if (!looksLikeDocxRequirementRow(cells, inRequirementTable)) {
        continue;
      }

      const requirementText = normalizePageText(cells[1] ?? "");
      const responseInstruction = normalizePageText(cells[3] ?? "");
      const rowHeading = findDocxHeadingForRequirement(
        document.raw_text,
        requirementText,
        activeHeading,
      );
      const headingKey = rowHeading || "Kravtabell";
      const headingSequence = (headingCounts.get(headingKey) ?? 0) + 1;
      headingCounts.set(headingKey, headingSequence);
      const rowNote = responseInstruction
        ? ` Responsinstruks: ${responseInstruction}`
        : "";

      requirements.push({
        id: docxRequirementId({
          cells,
          sequence: headingSequence,
          heading: rowHeading,
          responseInstruction,
        }),
        text: `${requirementText}${rowNote}`,
        pages: [1],
        heading: rowHeading,
        tableId: "DOCX kravtabell",
      });
      sequence += 1;
    }

    return dedupeRequirementLedger(requirements);
  } catch {
    return [];
  }
}

function buildRequirementSourceLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return dedupeRequirementLedger([
      ...buildLinearTableRequirementLedger(document),
      ...buildStructuredRequirementLedger(document),
    ]);
  }

  const pages = splitPdfPages(document.raw_text);
  if (!pages.length) {
    return [];
  }

  const pdfTableRequirements = buildPdfRequirementTableLedger(document);
  if (pdfTableRequirements.length >= 5) {
    return pdfTableRequirements;
  }

  const markerPattern = requirementIdPattern();
  const requirements: RequirementLedgerEntry[] = [];
  const pageHeadingMap = buildPageHeadingMap(document);
  let current: RequirementLedgerEntry | null = null;
  let currentHeading = "";

  function appendToCurrent(text: string, page: number) {
    const cleaned = stripRequirementChrome(text);
    if (!current || !cleaned) {
      return;
    }

    current.text = [current.text, cleaned].filter(Boolean).join(" ");
    if (!current.pages.includes(page)) {
      current.pages.push(page);
    }
  }

  function flushCurrent() {
    if (!current) {
      return;
    }

    const text = stripRequirementChrome(current.text).split(
      /\b(?:[\p{L}\s/-]{0,80}[–-]\s*)?Ta\s*b\s*e\s*ll\s*ID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?/iu,
    )[0]?.trim() ?? "";
    if (text) {
      requirements.push({
        ...current,
        text,
      });
    }
    current = null;
  }

  for (const page of pages.slice(0, 100)) {
    const pageHeading = pageHeadingMap.get(page.page);
    if (pageHeading) {
      currentHeading = pageHeading;
    }

    const matches = [...page.text.matchAll(markerPattern)];
    if (!matches.length) {
      if (current && pageHeading) {
        current.heading = pageHeading;
      }
      appendToCurrent(page.text, page.page);
      continue;
    }

    let cursor = 0;
    for (const match of matches) {
      const markerStart = match.index ?? 0;
      const markerPrefix = page.text.slice(Math.max(0, markerStart - 24), markerStart);
      if (/\bTabell\s*$/i.test(markerPrefix)) {
        continue;
      }

      const beforeMarker = page.text.slice(cursor, markerStart);
      if (current && pageHeading) {
        current.heading = pageHeading;
      }
      appendToCurrent(beforeMarker, page.page);
      flushCurrent();

      current = {
        id: documentRequirementId(match[0]),
        text: "",
        pages: [page.page],
        heading: findHeadingBeforeOffset(
          page.text,
          markerStart,
          pageHeading ?? currentHeading,
        ),
      };
      cursor = markerStart + match[0].length;
    }

    appendToCurrent(page.text.slice(cursor), page.page);
  }

  flushCurrent();

  const tableRequirements = buildTableRequirementLedger(document);
  const regularRequirements = requirements.filter(
    (item) => item.text.length >= 20 && !isTableContainerRequirement(item),
  );
  const structuredRequirements = buildStructuredRequirementLedger(document);
  const linearTableRequirements = buildLinearTableRequirementLedger(document);

  return dedupeRequirementLedger([
    ...regularRequirements,
    ...tableRequirements,
    ...linearTableRequirements,
    ...structuredRequirements,
  ]);
}

async function buildRequirementSourceLedgerWithFiles(
  document: ProjectDocumentDetail,
) {
  const baseLedger = buildRequirementSourceLedger(document);
  const docxTableLedger = await buildDocxTableRequirementLedger(document);
  const ledger =
    document.file_format === "docx" && docxTableLedger.length >= 5
      ? docxTableLedger
      : [...docxTableLedger, ...baseLedger];

  return dedupeRequirementLedger(ledger).map((entry) => ({
    ...entry,
    documentTitle: document.title,
  }));
}

function requirementLedgerSource(entry: RequirementLedgerEntry) {
  const pages = entry.pages.sort((a, b) => a - b);
  const pageLabel =
    pages.length === 1
      ? `Side ${pages[0]}`
      : `Side ${pages[0]}-${pages[pages.length - 1]}`;

  return [
    entry.documentTitle,
    pageLabel,
    entry.heading,
    entry.tableId,
    entry.service,
    entry.tableId ? "" : entry.id,
  ]
    .filter(Boolean)
    .join(", ");
}

function isSyntheticRequirementId(id: string) {
  return /^Side\s+\d+\s+krav\s+\d+$/i.test(id.trim());
}

function isReliableRequirementLedger(ledger: RequirementLedgerEntry[]) {
  if (!ledger.length) {
    return false;
  }

  const tableRows = ledger.filter((entry) => entry.tableId).length;
  const explicitRows = ledger.filter(
    (entry) => !entry.tableId && !isSyntheticRequirementId(entry.id),
  ).length;

  return ledger.length >= 20 || tableRows >= 8 || explicitRows >= 8;
}

function buildRequirementSourceLedgerContext(
  document: ProjectDocumentDetail,
  ledger: RequirementLedgerEntry[],
) {
  if (!isReliableRequirementLedger(ledger)) {
    return "";
  }

  const rows = ledger
    .slice(0, 180)
    .map((item) => {
      return `- ${item.id} | ${requirementLedgerSource(item)} | ${compactText(item.text, 500)}`;
    });

  if (!rows.length) {
    return "";
  }

  return buildDelimitedContext(
    `Kravfasit fra skjemamarkører for ${document.title}`,
    [
      "Bruk denne listen som primær fasit for krav-ID, kravrekkefølge og kravtekst når kravdokumentet har Leverandørens besvarelse-markører.",
      "Listen kan også inneholde syntetiske kravreferanser som 'Side X krav Y' når dokumentet ikke har synlige krav-ID-er. Disse er likevel kravkandidater som skal besvares hvis kravteksten er selvstendig.",
      "Tekst som ligger før neste ID-markør på ny side er behandlet som fortsettelse av forrige krav, ikke som nytt krav.",
      "Hvis denne fasiten finnes, skal kravbesvarelsen følge den fremfor å dele krav på sidebrudd i råteksten. Antall krav i svaret skal minst matche denne listen, med mindre du eksplisitt markerer duplikater.",
      "",
      ...rows,
    ].join("\n"),
  );
}

function buildContinuationPageMap(documents: ProjectDocumentDetail[]) {
  const map = new Map<number, string>();

  for (const document of documents) {
    if (document.file_format !== "pdf") {
      continue;
    }

    let lastExplicitId: string | null = null;
    for (const page of splitPdfPages(document.raw_text).slice(0, 80)) {
      const ids = detectRequirementIds(page.text);

      if (ids.length) {
        lastExplicitId = ids[ids.length - 1] ?? lastExplicitId;
        continue;
      }

      if (lastExplicitId) {
        map.set(page.page, lastExplicitId);
      }
    }
  }

  return map;
}

function normalizeEvidenceText(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[‐‑‒–—]/g, "-")
    .trim();
}

function buildRequirementPageEvidence(documents: ProjectDocumentDetail[]) {
  const map = new Map<number, string>();

  for (const document of documents) {
    if (document.file_format !== "pdf") {
      continue;
    }

    for (const page of splitPdfPages(document.raw_text).slice(0, 100)) {
      const existing = map.get(page.page);
      const text = normalizeEvidenceText(page.text);
      map.set(page.page, existing ? `${existing} ${text}` : text);
    }
  }

  return map;
}

function requirementIdVariants(requirementId: string) {
  const id = normalizeRequirementId(requirementId);
  const compact = id.replace(/\s+/g, "");
  const withoutPrefix = compact.replace(/^ID/, "");
  const variants = [id, compact, withoutPrefix, `ID ${withoutPrefix}`]
    .map((value) => normalizeEvidenceText(value))
    .filter(Boolean);

  return [...new Set(variants)];
}

function requirementLeadVariants(requirementText: string) {
  const words = normalizeEvidenceText(requirementText)
    .split(" ")
    .filter(Boolean);
  const variants: string[] = [];

  for (const length of [10, 8, 6, 4]) {
    if (words.length >= length) {
      variants.push(words.slice(0, length).join(" "));
    }
  }

  return variants;
}

function findFirstIndexOfAny(haystack: string, needles: string[]) {
  let first = -1;

  for (const needle of needles) {
    const index = haystack.indexOf(needle);
    if (index >= 0 && (first < 0 || index < first)) {
      first = index;
    }
  }

  return first;
}

function pageHasRequirementIdBeforeRequirementText(input: {
  pageText: string;
  requirementId: string;
  requirementText: string;
}) {
  const pageText = normalizeEvidenceText(input.pageText);
  const idIndex = findFirstIndexOfAny(
    pageText,
    requirementIdVariants(input.requirementId),
  );

  if (idIndex < 0) {
    return false;
  }

  const leadIndex = findFirstIndexOfAny(
    pageText,
    requirementLeadVariants(input.requirementText),
  );

  if (leadIndex < 0) {
    return true;
  }

  return idIndex <= leadIndex;
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function toMarkdownTableRow(cells: string[]) {
  return `| ${cells.map((cell) => cell.replace(/\s+/g, " ").trim()).join(" | ")} |`;
}

function tableRequirementAnswer(entry: RequirementLedgerEntry) {
  const service = normalizeRequirementLedgerText(entry.service ?? entry.id);
  const text = normalizeRequirementLedgerText(entry.text);
  const sourceSignal = service || text || "kravet";
  const responseFocus = [
    service.includes("tilgang") || text.includes("hjemmekontor")
      ? "tilgangsstyring, sikker autentisering og dokumentert tilgangsprosess"
      : "",
    service.includes("lisens")
      ? "lisensforvaltning, rapportering og kontroll mot faktisk bruk"
      : "",
    service.includes("overvåk") || service.includes("logger")
      ? "overvåking, varsling, hendelsesoppfølging og rapportering"
      : "",
    service.includes("dokumentasjon")
      ? "oppdatert dokumentasjon, eierskap og kontrollert tilgjengelighet"
      : "",
    service.includes("bruker")
      ? "brukeradministrasjon etter godkjent prosess og tydelige roller"
      : "",
    service.includes("vedlikehold") || service.includes("patch")
      ? "vedlikehold, endringskontroll og risikobasert oppdatering"
      : "",
    service.includes("sikkerhet") || service.includes("risiko")
      ? "sikkerhetskontroller, risikostyring og etterprøvbar oppfølging"
      : "",
    service.includes("backup") || service.includes("sikkerhetskopi")
      ? "sikkerhetskopiering, verifikasjon og tilbakelegging"
      : "",
    service.includes("rapportering")
      ? "statusrapportering, avvikshåndtering og styringsdialog"
      : "",
  ].find(Boolean);

  if (responseFocus) {
    return `Atea oppfyller kravet gjennom ${responseFocus}, med ansvar, oppfølging og dokumentasjon tilpasset kundens kravtekst og prosjektgrunnlaget.`;
  }

  return `Atea oppfyller kravet ved å beskrive ansvar, metode, dokumentasjon og eventuelle forbehold for ${sourceSignal}, basert på prosjektgrunnlaget.`;
}

function synthesizeRequirementLedgerRow(
  entry: RequirementLedgerEntry,
  indexes: {
    refIndex: number;
    requirementIndex: number;
    answerIndex: number;
    sourceIndex: number;
  },
  width: number,
) {
  const row = Array.from({ length: width }, () => "");
  row[indexes.refIndex] = entry.id;
  row[indexes.requirementIndex] = entry.text;
  row[indexes.answerIndex] = tableRequirementAnswer(entry);
  row[indexes.sourceIndex] = requirementLedgerSource(entry);
  return row;
}

function isMarkdownSeparatorRow(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function firstSourcePage(source: string) {
  const match = source.match(/\bSide\s+(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function sourcePages(source: string) {
  return [...source.matchAll(/\bSide\s+(\d+)\b/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
}

function maxSourcePage(source: string) {
  const pages = sourcePages(source);
  return pages.length ? Math.max(...pages) : null;
}

function splitRequirementIdParts(requirementId: string) {
  const normalized = normalizeRequirementId(requirementId)
    .replace(/^ID\s*/i, "")
    .replace(/^Krav\s*/i, "")
    .replace(/^REQ-/i, "REQ ");
  const match = normalized.match(/^([A-ZÆØÅ]*\s*)?(\d{1,3}(?:[.-]\d{1,3})*)([A-Z]?)$/i);

  if (!match) {
    return null;
  }

  const numericPath = (match[2] ?? "")
    .split(/[.-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));

  if (numericPath.length < 2) {
    return null;
  }

  return {
    prefix: `${match[1] ?? ""}${numericPath.slice(0, -1).join(".")}`
      .replace(/\s+/g, "")
      .toUpperCase(),
    number: numericPath[numericPath.length - 1] ?? 0,
    suffix: (match[4] ?? "").toUpperCase(),
  };
}

function isImmediateNextRequirementId(previousId: string, currentId: string) {
  const previous = splitRequirementIdParts(previousId);
  const current = splitRequirementIdParts(currentId);

  if (!previous || !current) {
    return false;
  }

  return (
    previous.prefix === current.prefix &&
    previous.suffix === current.suffix &&
    current.number === previous.number + 1
  );
}

function pageStartsWithRequirementText(input: {
  pageText: string;
  requirementText: string;
}) {
  const pageText = normalizeEvidenceText(input.pageText);
  const leadIndex = findFirstIndexOfAny(
    pageText,
    requirementLeadVariants(input.requirementText),
  );

  return leadIndex >= 0 && leadIndex <= 700;
}

function pageEndsWithRequirementText(input: {
  pageText: string;
  requirementText: string;
}) {
  const pageText = normalizeEvidenceText(input.pageText);
  const leadIndex = findFirstIndexOfAny(
    pageText,
    requirementLeadVariants(input.requirementText),
  );

  return leadIndex >= 0 && leadIndex >= Math.max(0, pageText.length - 1200);
}

function appendSentence(left: string, right: string) {
  const cleanLeft = left.trim();
  const cleanRight = right.trim();

  if (!cleanLeft) return cleanRight;
  if (!cleanRight || cleanLeft.includes(cleanRight)) return cleanLeft;

  return `${cleanLeft}${/[.!?]$/.test(cleanLeft) ? " " : ". "}${cleanRight}`;
}

function textCoverageScore(source: string, candidate: string) {
  const sourceWords = normalizeEvidenceText(source)
    .split(" ")
    .filter((word) => word.length > 2);
  const candidateWords = normalizeEvidenceText(candidate)
    .split(" ")
    .filter((word) => word.length > 2);

  if (!sourceWords.length || !candidateWords.length) {
    return 0;
  }

  const sourceSet = new Set(sourceWords);
  const matched = candidateWords.filter((word) => sourceSet.has(word)).length;
  return matched / sourceWords.length;
}

function mergeRequirementSource(
  left: string,
  right: string,
  requirementId: string,
) {
  const pages = [...sourcePages(left), ...sourcePages(right)];
  const uniquePages = [...new Set(pages)].sort((a, b) => a - b);

  if (!uniquePages.length) {
    return left || right;
  }

  const pageLabel =
    uniquePages.length === 1
      ? `Side ${uniquePages[0]}`
      : `Side ${uniquePages[0]}-${uniquePages[uniquePages.length - 1]}`;
  const tail = left
    .replace(/\bSide\s+\d+(?:\s*-\s*\d+)?\s*,?\s*/i, "")
    .trim();
  const tailWithId = tail || requirementId;

  return `${pageLabel}, ${tailWithId}`;
}

function sourceTail(source: string) {
  return source
    .replace(/\bSide\s+\d+(?:\s*-\s*\d+)?\s*,?\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceTailHasRequirementId(source: string, requirementId: string) {
  const sourceText = normalizeEvidenceText(source);
  return requirementIdVariants(requirementId).some((variant) =>
    sourceText.includes(variant),
  );
}

function formatRequirementSource(
  pages: number[],
  tail: string,
  requirementId: string,
) {
  const uniquePages = [...new Set(pages)]
    .filter((page) => Number.isFinite(page))
    .sort((a, b) => a - b);

  if (!uniquePages.length) {
    return tail || requirementId;
  }

  const pageLabel =
    uniquePages.length === 1
      ? `Side ${uniquePages[0]}`
      : `Side ${uniquePages[0]}-${uniquePages[uniquePages.length - 1]}`;
  const idTail = sourceTailHasRequirementId(tail, requirementId)
    ? tail
    : [tail, requirementId].filter(Boolean).join(", ");

  return [pageLabel, idTail].filter(Boolean).join(", ");
}

function includeSourcePage(
  source: string,
  page: number,
  requirementId: string,
) {
  return formatRequirementSource(
    [...sourcePages(source), page],
    sourceTail(source),
    requirementId,
  );
}

function repairContinuationSource(input: {
  source: string;
  requirementId: string;
  requirementText: string;
  continuationPages: Map<number, string>;
  pageEvidence: Map<number, string>;
}) {
  const firstPage = firstSourcePage(input.source);

  if (!firstPage || firstPage <= 1 || !input.requirementId) {
    return input.source;
  }

  const expectedId = input.continuationPages.get(firstPage);
  if (
    !expectedId ||
    normalizeRequirementId(expectedId) !== normalizeRequirementId(input.requirementId)
  ) {
    return input.source;
  }

  const previousPageText = input.pageEvidence.get(firstPage - 1) ?? "";
  const idStartedOnPreviousPage = pageHasRequirementIdBeforeRequirementText({
    pageText: previousPageText,
    requirementId: input.requirementId,
    requirementText: input.requirementText,
  });
  const textStartedOnPreviousPage = pageEndsWithRequirementText({
    pageText: previousPageText,
    requirementText: input.requirementText,
  });

  if (!idStartedOnPreviousPage && !textStartedOnPreviousPage) {
    return input.source;
  }

  return includeSourcePage(input.source, firstPage - 1, input.requirementId);
}

function mergeContinuationRowsInRequirementTable(
  contentMarkdown: string,
  continuationPages: Map<number, string>,
  pageEvidence: Map<number, string>,
) {
  if (!continuationPages.size && !pageEvidence.size) {
    return contentMarkdown;
  }

  const lines = contentMarkdown.split("\n");
  const nextLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim().startsWith("|")) {
      nextLines.push(line);
      index += 1;
      continue;
    }

    const headerCells = splitMarkdownTableRow(line);
    const sourceIndex = headerCells.findIndex((cell) =>
      /kildegrunnlag/i.test(cell),
    );
    const refIndex = headerCells.findIndex((cell) => /kravref/i.test(cell));
    const requirementIndex = headerCells.findIndex((cell) =>
      /^krav$/i.test(cell),
    );
    const answerIndex = headerCells.findIndex((cell) => /^svar$/i.test(cell));

    if (
      sourceIndex < 0 ||
      refIndex < 0 ||
      requirementIndex < 0 ||
      answerIndex < 0 ||
      !isMarkdownSeparatorRow(lines[index + 1] ?? "")
    ) {
      nextLines.push(line);
      index += 1;
      continue;
    }

    const tableLines = [line, lines[index + 1] ?? ""];
    index += 2;
    while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
      tableLines.push(lines[index] ?? "");
      index += 1;
    }

    const rows = tableLines.slice(2).map(splitMarkdownTableRow);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const currentId = normalizeRequirementId(row[refIndex] ?? "");
      if (currentId) {
        row[sourceIndex] = repairContinuationSource({
          source: row[sourceIndex] ?? "",
          requirementId: currentId,
          requirementText: row[requirementIndex] ?? "",
          continuationPages,
          pageEvidence,
        });
      }

      const page = firstSourcePage(row[sourceIndex] ?? "");
      const expectedId = page ? continuationPages.get(page) : null;
      const previousRow = rows[rowIndex - 1];
      const previousId = normalizeRequirementId(previousRow?.[refIndex] ?? "");
      const previousMaxPage = maxSourcePage(previousRow?.[sourceIndex] ?? "");
      const isAdjacentPageContinuation =
        Boolean(page && previousMaxPage && page === previousMaxPage + 1);
      const isExpectedPreviousId = Boolean(
        expectedId && previousId && normalizeRequirementId(expectedId) === previousId,
      );
      const isLikelyInventedNextId = Boolean(
        previousId && currentId && isImmediateNextRequirementId(previousId, currentId),
      );
      const isDuplicateContinuationId = Boolean(
        previousId && currentId && previousId === currentId,
      );
      const currentIdHasPageEvidence =
        page && currentId
          ? pageHasRequirementIdBeforeRequirementText({
              pageText: pageEvidence.get(page) ?? "",
              requirementId: currentId,
              requirementText: row[requirementIndex] ?? "",
            })
          : true;
      const startsAtTopOfContinuationPage =
        page && row[requirementIndex]
          ? pageStartsWithRequirementText({
              pageText: pageEvidence.get(page) ?? "",
              requirementText: row[requirementIndex] ?? "",
            })
          : false;

      const shouldMerge =
        isAdjacentPageContinuation &&
        isExpectedPreviousId &&
        (isLikelyInventedNextId || isDuplicateContinuationId) &&
        !currentIdHasPageEvidence &&
        startsAtTopOfContinuationPage;

      if (!shouldMerge) {
        continue;
      }

      const mergeIntoId = isDuplicateContinuationId ? currentId : previousId;
      if (!mergeIntoId) {
        continue;
      }

      const targetIndex = rows.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex < rowIndex &&
          normalizeRequirementId(candidate[refIndex] ?? "") === mergeIntoId,
      );

      if (targetIndex < 0) {
        row[refIndex] = mergeIntoId;
        continue;
      }

      const target = rows[targetIndex];
      target[requirementIndex] = appendSentence(
        target[requirementIndex] ?? "",
        row[requirementIndex] ?? "",
      );
      target[answerIndex] = appendSentence(
        target[answerIndex] ?? "",
        row[answerIndex] ?? "",
      );
      target[sourceIndex] = mergeRequirementSource(
        target[sourceIndex] ?? "",
        row[sourceIndex] ?? "",
        mergeIntoId,
      );
      rows.splice(rowIndex, 1);
      rowIndex -= 1;
    }

    nextLines.push(tableLines[0] ?? "");
    nextLines.push(tableLines[1] ?? "");
    nextLines.push(...rows.map(toMarkdownTableRow));
  }

  return nextLines.join("\n");
}

function alignRequirementRowsWithLedger(
  contentMarkdown: string,
  ledger: RequirementLedgerEntry[],
) {
  if (!ledger.length) {
    return contentMarkdown;
  }

  const lines = contentMarkdown.split("\n");
  const nextLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim().startsWith("|")) {
      nextLines.push(line);
      index += 1;
      continue;
    }

    const headerCells = splitMarkdownTableRow(line);
    const sourceIndex = headerCells.findIndex((cell) =>
      /kildegrunnlag/i.test(cell),
    );
    const refIndex = headerCells.findIndex((cell) => /kravref/i.test(cell));
    const requirementIndex = headerCells.findIndex((cell) =>
      /^krav$/i.test(cell),
    );
    const answerIndex = headerCells.findIndex((cell) => /^svar$/i.test(cell));

    if (
      sourceIndex < 0 ||
      refIndex < 0 ||
      requirementIndex < 0 ||
      answerIndex < 0 ||
      !isMarkdownSeparatorRow(lines[index + 1] ?? "")
    ) {
      nextLines.push(line);
      index += 1;
      continue;
    }

    const tableLines = [line, lines[index + 1] ?? ""];
    index += 2;
    while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
      tableLines.push(lines[index] ?? "");
      index += 1;
    }

    const rows = tableLines.slice(2).map(splitMarkdownTableRow);
    const alignedRows: string[][] = [];
    let rowCursor = 0;

    for (const entry of ledger) {
      const matchedRows: string[][] = [];
      let combinedRequirementText = "";
      let scan = rowCursor;
      let bestCoverage = 0;

      while (scan < rows.length && matchedRows.length < 4) {
        const candidate = rows[scan];
        const candidateId = normalizeRequirementId(candidate?.[refIndex] ?? "");
        const expectedId = normalizeRequirementId(entry.id);
        const candidateText = candidate?.[requirementIndex] ?? "";
        const nextCombined = appendSentence(combinedRequirementText, candidateText);
        const coverage = textCoverageScore(entry.text, nextCombined);
        const isExpectedId = candidateId === expectedId;
        const improvesCurrentMatch = matchedRows.length > 0 && coverage > bestCoverage;

        if (isExpectedId || coverage >= 0.55 || improvesCurrentMatch) {
          matchedRows.push(candidate);
          combinedRequirementText = nextCombined;
          bestCoverage = Math.max(bestCoverage, coverage);
          scan += 1;
          if (coverage >= 0.88) {
            break;
          }
          continue;
        }

        if (!matchedRows.length) {
          scan += 1;
          continue;
        }
        break;
      }

      if (!matchedRows.length) {
        alignedRows.push(
          synthesizeRequirementLedgerRow(
            entry,
            { refIndex, requirementIndex, answerIndex, sourceIndex },
            headerCells.length,
          ),
        );
        continue;
      }

      rowCursor = scan;
      const base = [...matchedRows[0]];
      base[refIndex] = entry.id;
      base[requirementIndex] = entry.text;
      base[answerIndex] = matchedRows
        .map((row) => row[answerIndex] ?? "")
        .filter(Boolean)
        .reduce((left, right) => appendSentence(left, right), "");
      base[sourceIndex] = requirementLedgerSource(entry);
      alignedRows.push(base);
    }

    nextLines.push(tableLines[0] ?? "");
    nextLines.push(tableLines[1] ?? "");
    nextLines.push(...(alignedRows.length ? alignedRows : rows).map(toMarkdownTableRow));
  }

  return nextLines.join("\n");
}

function shouldUseRequirementLedgerGeneration(ledger: RequirementLedgerEntry[]) {
  return (
    isReliableRequirementLedger(ledger) ||
    ledger.filter((entry) => !isSyntheticRequirementId(entry.id)).length >= 5
  );
}

function requirementResponseBatchModel(model?: string) {
  const normalized = model?.trim();
  if (!normalized || normalized === "gpt-5-mini") {
    return FAST_MODEL;
  }

  if (/mini|nano/i.test(normalized)) {
    return normalized;
  }

  return FAST_MODEL;
}

function requirementBatchSystemPrompt() {
  return buildPromptTemplate({
    role: "Du er en senior tilbudsansvarlig og løsningsarkitekt som skriver profesjonelle kravsvar for norske tilbud.",
    task: [
      "Skriv konkrete svar til en ferdig, uttømmende kravliste.",
      "Du skal ikke finne nye krav, endre kravreferanser eller endre rekkefølge.",
      "Svarene skal kunne limes direkte inn i kundens kravskjema.",
    ],
    rules: [
      "Returner kun gyldig JSON.",
      "Returner nøyaktig én rad per krav i input, i samme rekkefølge.",
      "Bruk ref-verdien fra input uendret.",
      "Skriv på profesjonell norsk, også når kildene er på engelsk.",
      "Svar på vegne av Atea når prosjektgrunnlaget ikke tydelig angir et annet leverandørnavn.",
      "Svar med 1-2 korte setninger per krav. Bruk 3 setninger bare ved tydelige delkrav, avhengigheter eller forbehold.",
      "Vis kort kravforståelse og konkret hvordan kravet oppfylles gjennom leveranse, prosess, ansvar, kontroll eller dokumentasjon.",
      "Ikke gjenta hele kravteksten i svaret.",
      "Ikke bruk generiske ja/nei-svar, markedsføring, superlativer eller udokumenterte påstander.",
      "Hvis grunnlaget ikke dekker kravet sikkert, skriv et tydelig forbehold eller avklaringspunkt i svaret.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøkkelen rows.",
      "rows skal være en liste med objekter som har nr, ref og svar.",
      "nr skal være samme nummer som i input. ref skal være samme kravreferanse som i input.",
    ],
    exampleOutput:
      '{"rows":[{"nr":1,"ref":"Krav 3.1.1","svar":"Atea forstår kravet som ... og oppfyller det gjennom ..."}]}',
  });
}

function chunkRequirements(entries: RequirementLedgerEntry[]) {
  const batchSize =
    entries.length >= 80
      ? LARGE_REQUIREMENT_RESPONSE_BATCH_SIZE
      : REQUIREMENT_RESPONSE_BATCH_SIZE;
  const chunks: Array<{
    startIndex: number;
    entries: RequirementLedgerEntry[];
  }> = [];

  for (
    let startIndex = 0;
    startIndex < entries.length;
    startIndex += batchSize
  ) {
    chunks.push({
      startIndex,
      entries: entries.slice(
        startIndex,
        startIndex + batchSize,
      ),
    });
  }

  return chunks;
}

function answerFromBatchRows(input: {
  rows: RequirementBatchAnswer[];
  entry: RequirementLedgerEntry;
  localIndex: number;
  absoluteIndex: number;
}) {
  const expectedNr = input.absoluteIndex + 1;
  const expectedRef = normalizeRequirementId(input.entry.id);
  const matched =
    input.rows.find((row) => row.nr === expectedNr) ??
    input.rows.find(
      (row) => normalizeRequirementId(row.ref ?? "") === expectedRef,
    ) ??
    input.rows[input.localIndex];
  const answer = (matched?.svar ?? matched?.answer ?? "")
    .replace(/\s+/g, " ")
    .trim();

  return answer || tableRequirementAnswer(input.entry);
}

function markdownTableCell(value: string) {
  return value
    .replace(/\r?\n+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function requirementRetrievalTokens(entries: RequirementLedgerEntry[]) {
  const tokens = entries.flatMap((entry) =>
    tokenizeComparableText(`${entry.id} ${entry.text} ${entry.heading}`),
  );

  return Array.from(
    new Set(
      tokens
        .filter((token) => token.length >= 4)
        .filter((token) => !REQUIREMENT_RETRIEVAL_STOP_WORDS.has(token))
        .slice(0, 140),
    ),
  );
}

function buildRequirementBatchRetrievalContext(input: {
  entries: RequirementLedgerEntry[];
  supportingDocuments: ProjectDocumentDetail[];
  serviceDocuments: ProjectDocumentDetail[];
}) {
  const tokens = requirementRetrievalTokens(input.entries);
  if (!tokens.length) {
    return "";
  }

  const candidates = [
    ...input.serviceDocuments.map((document) => ({
      label: "Tjenesteutdrag",
      document,
      maxChunks: 18,
    })),
    ...input.supportingDocuments.map((document) => ({
      label: "Støtteutdrag",
      document,
      maxChunks: 24,
    })),
  ].flatMap(({ label, document, maxChunks }) =>
    buildDocumentTextChunks(document, {
      maxChunks,
      chunkLimit: 1800,
    }).map((chunk) => {
      const haystack = normalizeComparableText(
        `${document.title} ${chunk.references.join(" ")} ${chunk.text}`,
      );
      const score = tokens.reduce(
        (sum, token) => sum + (haystack.includes(token) ? 1 : 0),
        0,
      );
      return {
        label,
        documentTitle: document.title,
        chunk,
        score,
      };
    }),
  );

  const selected = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 7);

  if (!selected.length) {
    return "";
  }

  return buildDelimitedContext(
    "Relevante utdrag for denne kravbatchen",
    selected
      .map((item, index) =>
        [
          `${index + 1}. ${item.label}: ${item.documentTitle}`,
          `Referanser: ${item.chunk.references.slice(0, 4).join(", ")}`,
          compactText(item.chunk.text, 1100),
        ].join("\n"),
      )
      .join("\n\n"),
  );
}

function requirementCoverageSummary(input: {
  ledger: RequirementLedgerEntry[];
  answers: string[];
}) {
  const explicitRefs = input.ledger.filter(
    (entry) => !isSyntheticRequirementId(entry.id),
  ).length;
  const fallbackAnswers = input.answers.filter((answer, index) => {
    const entry = input.ledger[index];
    return entry ? isNearDuplicate(answer, tableRequirementAnswer(entry), 0.9) : false;
  }).length;

  return [
    `${input.ledger.length} krav er identifisert og besvart.`,
    `${explicitRefs} krav har eksplisitt kravreferanse fra dokumentet.`,
    "Alle kravradene fra kravlisten er inkludert i tabellen.",
    fallbackAnswers
      ? `${fallbackAnswers} svar er markert med konservativt standardsvar fordi AI-raden manglet eller var tom.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function requirementGroupHeading(entry: RequirementLedgerEntry) {
  const heading = lastHeadingSegment(entry.heading);
  if (!heading || /^kravtabell$/i.test(heading)) {
    return "";
  }

  return heading;
}

function requirementTableMarkdown(rows: string[][]) {
  return [
    "| Kravref. | Krav | Svar | Kildegrunnlag |",
    "|---|---|---|---|",
    ...rows.map(toMarkdownTableRow),
  ];
}

function buildRequirementResponseMarkdown(input: {
  ledger: RequirementLedgerEntry[];
  answers: string[];
}) {
  const rows = input.ledger.map((entry, index) => ({
    heading: requirementGroupHeading(entry),
    cells: [
      markdownTableCell(entry.id),
      markdownTableCell(entry.text),
      markdownTableCell(input.answers[index] ?? tableRequirementAnswer(entry)),
      markdownTableCell(requirementLedgerSource(entry)),
    ],
  }));
  const groupedRows: string[] = [];
  const distinctHeadings = new Set(rows.map((row) => row.heading).filter(Boolean));

  if (distinctHeadings.size > 1) {
    let currentHeading: string | null = null;
    let currentRows: string[][] = [];

    function flushGroup() {
      if (!currentRows.length) {
        return;
      }

      if (currentHeading) {
        groupedRows.push(`### ${currentHeading}`, "");
      }
      groupedRows.push(...requirementTableMarkdown(currentRows), "");
      currentRows = [];
    }

    for (const row of rows) {
      if (row.heading !== currentHeading) {
        flushGroup();
        currentHeading = row.heading;
      }
      currentRows.push(row.cells);
    }
    flushGroup();
  } else {
    groupedRows.push(
      ...requirementTableMarkdown(rows.map((row) => row.cells)),
    );
  }

  return [
    "## Status",
    "",
    requirementCoverageSummary({
      ledger: input.ledger,
      answers: input.answers,
    }),
    "",
    "## Kravbesvarelse",
    "",
    ...groupedRows,
  ].join("\n");
}

async function generateRequirementResponseFromLedger(input: {
  projectName: string;
  baseContext: string;
  ledger: RequirementLedgerEntry[];
  supportingDocuments: ProjectDocumentDetail[];
  serviceDocuments: ProjectDocumentDetail[];
  model?: string;
  onProgress?: (message: string) => void;
}) {
  const chunks = chunkRequirements(input.ledger);
  let completedBatches = 0;
  let completedRequirements = 0;

  input.onProgress?.(
    `[32%] Fant ${input.ledger.length} krav. Starter ${chunks.length} parallelle svarbatcher ...`,
  );

  const batchAnswers = await mapWithConcurrency(
    chunks,
    REQUIREMENT_RESPONSE_BATCH_CONCURRENCY,
    async (chunk) => {
      const krav = chunk.entries.map((entry, localIndex) => ({
        nr: chunk.startIndex + localIndex + 1,
        ref: entry.id,
        kravtekst: compactText(entry.text, 1200),
        kildegrunnlag: requirementLedgerSource(entry),
      }));
      const relevantExcerpts = buildRequirementBatchRetrievalContext({
        entries: chunk.entries,
        supportingDocuments: input.supportingDocuments,
        serviceDocuments: input.serviceDocuments,
      });
      const generated = await createJsonCompletion<{ rows?: RequirementBatchAnswer[] }>({
        system: requirementBatchSystemPrompt(),
        user: [
          "Besvar kravene i JSON. Ikke legg til, fjern eller slå sammen krav.",
          input.baseContext,
          relevantExcerpts,
          buildDelimitedContext("Krav som skal besvares", JSON.stringify(krav, null, 2)),
        ]
          .filter(Boolean)
          .join("\n\n"),
        temperature: 0.08,
        model: requirementResponseBatchModel(input.model),
        reasoningEffort: FAST_REASONING_EFFORT,
      });
      const rows = Array.isArray(generated.rows) ? generated.rows : [];
      completedBatches += 1;
      completedRequirements += chunk.entries.length;
      const answeredSoFar = Math.min(input.ledger.length, completedRequirements);
      input.onProgress?.(
        `[${Math.min(
          78,
          32 + Math.round((completedBatches / chunks.length) * 46),
        )}%] Besvart ${answeredSoFar} av ${input.ledger.length} krav ...`,
      );

      return chunk.entries.map((entry, localIndex) =>
        answerFromBatchRows({
          rows,
          entry,
          localIndex,
          absoluteIndex: chunk.startIndex + localIndex,
        }),
      );
    },
  );

  const answers = batchAnswers.flat();
  input.onProgress?.(
    `[84%] Kontrollerer dekning for ${input.ledger.length} krav og bygger kravtabell ...`,
  );

  return {
    title: `Kravbesvarelse - ${input.projectName}`,
    content_markdown: buildRequirementResponseMarkdown({
      ledger: input.ledger,
      answers,
    }),
  };
}

function isRequirementDocument(document: ProjectDocumentDetail) {
  const text = `${document.title} ${document.file_name}`.toLowerCase();
  return (
    text.includes("krav") ||
    text.includes("requirement") ||
    text.includes("requirements")
  );
}

function emptyDocumentInsightDigest(): DocumentInsightDigest {
  return {
    document_summary: "",
    important_requirements: [],
    implicit_needs: [],
    risks: [],
    evaluation_criteria: [],
    architecture_and_solution_signals: [],
    technologies_and_standards: [],
    value_signals: [],
    visual_or_table_notes: [],
    source_references: [],
  };
}

function normalizeDocumentInsightDigest(
  value: Partial<DocumentInsightDigest> | null | undefined,
): DocumentInsightDigest {
  const source = value ?? {};
  return {
    document_summary: compactText(source.document_summary ?? "", 900),
    important_requirements: capNormalizedList(source.important_requirements ?? [], {
      max: 10,
    }),
    implicit_needs: capNormalizedList(source.implicit_needs ?? [], { max: 8 }),
    risks: capNormalizedList(source.risks ?? [], { max: 8 }),
    evaluation_criteria: capNormalizedList(source.evaluation_criteria ?? [], {
      max: 8,
    }),
    architecture_and_solution_signals: capNormalizedList(
      source.architecture_and_solution_signals ?? [],
      { max: 10 },
    ),
    technologies_and_standards: capNormalizedList(
      source.technologies_and_standards ?? [],
      { max: 12 },
    ),
    value_signals: capNormalizedList(source.value_signals ?? [], { max: 8 }),
    visual_or_table_notes: capNormalizedList(source.visual_or_table_notes ?? [], {
      max: 8,
    }),
    source_references: capNormalizedList(source.source_references ?? [], {
      max: 12,
    }),
  };
}

function shouldBuildDocumentInsightDigest(document: ProjectDocumentDetail) {
  return (
    document.raw_text.length > LARGE_DOCUMENT_ANALYSIS_THRESHOLD ||
    document.structure_map.length > 12
  );
}

function buildDocumentTextChunks(
  document: ProjectDocumentDetail,
  options?: { maxChunks?: number; chunkLimit?: number },
): DocumentTextChunk[] {
  const chunkLimit = options?.chunkLimit ?? CHUNK_TEXT_LIMIT;
  const maxChunks = options?.maxChunks ?? MAX_DOCUMENT_CHUNKS;
  const entries = document.structure_map.length
    ? document.structure_map
    : [{ reference: document.title, text: document.raw_text }];
  const chunks: DocumentTextChunk[] = [];
  let currentText = "";
  let currentReferences: string[] = [];

  function flush() {
    if (!currentText.trim()) {
      return;
    }
    chunks.push({
      label: `${document.title} – del ${chunks.length + 1}`,
      text: compactText(currentText, chunkLimit),
      references: currentReferences,
    });
    currentText = "";
    currentReferences = [];
  }

  for (const entry of entries) {
    const entryText = compactText(entry.text, chunkLimit);
    if (!entryText) {
      continue;
    }

    const nextText = [currentText, `${entry.reference}\n${entryText}`]
      .filter(Boolean)
      .join("\n\n");

    if (nextText.length > chunkLimit && currentText) {
      flush();
    }

    currentText = [currentText, `${entry.reference}\n${entryText}`]
      .filter(Boolean)
      .join("\n\n");
    currentReferences.push(entry.reference);

    if (currentText.length >= chunkLimit) {
      flush();
    }

    if (chunks.length >= maxChunks) {
      break;
    }
  }

  flush();
  return chunks.slice(0, maxChunks);
}

function buildDocumentCoverageNotes(document: ProjectDocumentDetail) {
  const notes: string[] = [];
  const sparseEntries = document.structure_map.filter(
    (entry) => entry.text.trim().length > 0 && entry.text.trim().length < 180,
  );
  const emptyLikeCount = document.structure_map.filter(
    (entry) => !entry.text.trim(),
  ).length;

  if (sparseEntries.length || emptyLikeCount) {
    notes.push(
      "Noen sider/blokker har lite maskinlesbar tekst. Dersom disse inneholder grafer, bilder, skannede tabeller eller arkitekturfigurer, må funn verifiseres mot originaldokumentet eller OCR/vision legges til.",
    );
  }

  if (/\b(figur|figure|diagram|graf|graph|tabell|table|illustrasjon|arkitekturdiagram)\b/i.test(document.raw_text)) {
    notes.push(
      "Dokumentet refererer til figurer, grafer, diagrammer eller tabeller. Tekstanalysen bruker maskinlesbar tekst rundt disse elementene, ikke visuell tolking av selve bildet.",
    );
  }

  return notes;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

async function buildDocumentInsightDigestUncached(
  label: string,
  document: ProjectDocumentDetail,
  options?: { force?: boolean; maxChunks?: number },
) {
  if (!options?.force && !shouldBuildDocumentInsightDigest(document)) {
    return null;
  }

  const chunks = buildDocumentTextChunks(document, {
    maxChunks: options?.maxChunks ?? MAX_DOCUMENT_CHUNKS,
  });

  if (!chunks.length) {
    return null;
  }

  const chunkPrompt = buildPromptTemplate({
    role: "Du er en nøyaktig dokumentanalytiker for tilbudsarbeid. Du leser én del av et større dokument og trekker ut bare konkrete, kildebaserte funn.",
    task: [
      "Analyser dokumentdelen og hent ut krav, implisitte behov, risiko, evalueringskriterier, løsningssignaler, teknologier og verdidrivere.",
      "Marker om teksten tyder på tabeller, grafer, figurer, bilder eller diagrammer som kan kreve manuell verifikasjon.",
      "Vær konservativ: ikke finn opp detaljer som ikke står i teksten.",
    ],
    rules: [
      "Returner kun gyldig JSON.",
      "Hold punktene korte, konkrete og kildetette.",
      "Ikke gjenta samme funn med små omskrivinger.",
      "Bruk source_references når funn kan knyttes til side, kapittel eller tekstblokk.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøklene document_summary, important_requirements, implicit_needs, risks, evaluation_criteria, architecture_and_solution_signals, technologies_and_standards, value_signals, visual_or_table_notes og source_references.",
      "Alle felt utenom document_summary skal være lister av strenger.",
    ],
    exampleOutput:
      '{"document_summary":"<tekstnært sammendrag av dokumentdelen>","important_requirements":["<krav eller føring>"],"implicit_needs":["<rimelig tolket behov>"],"risks":["<risiko>"],"evaluation_criteria":["<mulig evalueringskriterium>"],"architecture_and_solution_signals":["<løsningssignal>"],"technologies_and_standards":["<navngitt teknologi eller standard>"],"value_signals":["<verdisignal>"],"visual_or_table_notes":["<observasjon om tabell/figur>"],"source_references":["<kildehenvisning>"]}',
  });

  const chunkDigests = await mapWithConcurrency(
    chunks,
    CHUNK_CONCURRENCY,
    async (chunk) =>
      normalizeDocumentInsightDigest(
        await createJsonCompletion<Partial<DocumentInsightDigest>>({
          system: chunkPrompt,
          user: [
            buildDelimitedContext("Dokument", label),
            buildDelimitedContext("Kildereferanser", chunk.references.join("\n")),
            buildDelimitedContext("Dokumentdel", chunk.text),
          ].join("\n\n"),
          temperature: 0,
          model: FAST_MODEL,
          reasoningEffort: FAST_REASONING_EFFORT,
        }),
      ),
  );

  const merged = normalizeDocumentInsightDigest({
    document_summary: chunkDigests
      .map((digest, index) => `Del ${index + 1}: ${digest.document_summary}`)
      .join("\n"),
    important_requirements: chunkDigests.flatMap(
      (digest) => digest.important_requirements,
    ),
    implicit_needs: chunkDigests.flatMap((digest) => digest.implicit_needs),
    risks: chunkDigests.flatMap((digest) => digest.risks),
    evaluation_criteria: chunkDigests.flatMap(
      (digest) => digest.evaluation_criteria,
    ),
    architecture_and_solution_signals: chunkDigests.flatMap(
      (digest) => digest.architecture_and_solution_signals,
    ),
    technologies_and_standards: chunkDigests.flatMap(
      (digest) => digest.technologies_and_standards,
    ),
    value_signals: chunkDigests.flatMap((digest) => digest.value_signals),
    visual_or_table_notes: [
      ...chunkDigests.flatMap((digest) => digest.visual_or_table_notes),
      ...buildDocumentCoverageNotes(document),
    ],
    source_references: chunkDigests.flatMap((digest) => digest.source_references),
  });

  return buildDelimitedContext(
    `${label} – bred dokumentdekning`,
    JSON.stringify(merged, null, 2),
  );
}

async function buildDocumentInsightDigest(
  label: string,
  document: ProjectDocumentDetail,
  options?: { force?: boolean; maxChunks?: number },
) {
  if (!options?.force && !shouldBuildDocumentInsightDigest(document)) {
    return null;
  }

  const cacheKey = [
    label,
    document.id,
    document.updated_at,
    document.raw_text.length,
    options?.maxChunks ?? MAX_DOCUMENT_CHUNKS,
  ].join(":");
  const cached = getDocumentInsightCache().get(cacheKey);

  if (cached) {
    return cached;
  }

  return rememberDocumentInsight(
    cacheKey,
    buildDocumentInsightDigestUncached(label, document, options),
  );
}

function summarizeCustomerAnalysis(analysis: CustomerAnalysisResult) {
  return JSON.stringify(
    {
      customer_profile_summary: compactText(
        analysis.customer_profile_summary,
        500,
      ),
      customer_goals_summary: compactText(analysis.customer_goals_summary, 500),
      high_level_solution_design: compactText(
        analysis.high_level_solution_design,
        700,
      ),
      high_level_architecture_mermaid: compactText(
        analysis.high_level_architecture_mermaid,
        1000,
      ),
      customer_profile: analysis.customer_profile.slice(0, 5),
      customer_goals: analysis.customer_goals.slice(0, 5),
      implicit_requirements: analysis.implicit_requirements
        .slice(0, 6)
        .map((item) => ({
          title: item.title,
          category: item.category,
          importance: item.importance,
          description: compactText(item.description, 220),
        })),
      risks_for_us: (analysis.risks_for_us ?? []).slice(0, 5),
      risks_for_customer: (analysis.risks_for_customer ?? []).slice(0, 5),
      risks: analysis.risks.slice(0, 5),
      likely_evaluation_criteria: analysis.likely_evaluation_criteria.slice(
        0,
        5,
      ),
      expected_solution_direction: analysis.expected_solution_direction.slice(
        0,
        5,
      ),
      value_opportunities: analysis.value_opportunities.slice(0, 4),
      executive_summary: compactText(analysis.executive_summary, 500),
    },
    null,
    2,
  );
}

function summarizeSolutionEvaluation(evaluation: SolutionEvaluationResult) {
  return JSON.stringify(
    {
      fit_to_customer_needs: compactText(evaluation.fit_to_customer_needs, 500),
      strengths: evaluation.strengths.slice(0, 5),
      weaknesses: evaluation.weaknesses.slice(0, 5),
      missing_elements: evaluation.missing_elements.slice(0, 5),
      risks_to_customer: evaluation.risks_to_customer.slice(0, 5),
      improvement_recommendations: evaluation.improvement_recommendations.slice(
        0,
        5,
      ),
      likely_score_assessment: evaluation.likely_score_assessment,
      executive_summary: compactText(evaluation.executive_summary, 500),
    },
    null,
    2,
  );
}

function parseJson<T>(content: string): T {
  const trimmed = content.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  const candidate = codeBlockMatch?.[1] ?? trimmed;
  return JSON.parse(candidate) as T;
}

function normalizeComparableText(value: string) {
  return value
    .toLowerCase()
    .replace(/[`*#>_[\](){},.:;!?'"“”‘’/\\|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparableText(value: string) {
  return normalizeComparableText(value)
    .split(" ")
    .filter((token) => token.length > 2);
}

function similarityScore(a: string, b: string) {
  const aTokens = new Set(tokenizeComparableText(a));
  const bTokens = new Set(tokenizeComparableText(b));

  if (!aTokens.size || !bTokens.size) {
    return 0;
  }

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.min(aTokens.size, bTokens.size);
}

function isNearDuplicate(a: string, b: string, threshold = 0.72) {
  const normalizedA = normalizeComparableText(a);
  const normalizedB = normalizeComparableText(b);

  if (!normalizedA || !normalizedB) {
    return false;
  }

  if (normalizedA === normalizedB) {
    return true;
  }

  return similarityScore(normalizedA, normalizedB) >= threshold;
}

function normalizeUniqueList(items: string[]) {
  const result: string[] = [];

  for (const rawItem of items) {
    const item = rawItem.replace(/\s+/g, " ").trim();
    if (!item) {
      continue;
    }

    if (result.some((existing) => isNearDuplicate(existing, item))) {
      continue;
    }

    result.push(item);
  }

  return result;
}

function capNormalizedList(items: string[], options?: { max?: number }) {
  const max = options?.max ?? 10;
  return normalizeUniqueList(items).slice(0, max);
}

function splitIntoSentences(value: string) {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function dedupeSummary(value: string, references: string[]) {
  const sentences = splitIntoSentences(value);
  if (!sentences.length) {
    return value.replace(/\s+/g, " ").trim();
  }

  const kept = sentences.filter((sentence) => {
    return !references.some((reference) =>
      isNearDuplicate(sentence, reference, 0.76),
    );
  });

  const normalized = (kept.length ? kept : sentences)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

function normalizeSignalWords(items: string[]) {
  return normalizeTechnologySignalWords(items);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countSignalWordMentions(keyword: string, sourceText: string) {
  const trimmedKeyword = keyword.replace(/\s+/g, " ").trim();
  const normalizedSource = sourceText.replace(/\s+/g, " ").trim();

  if (!trimmedKeyword || !normalizedSource) {
    return 1;
  }

  const flexibleKeyword = escapeRegExp(trimmedKeyword)
    .replace(/\\ /g, "\\s+")
    .replace(/\\-/g, "[-\\s]?");

  try {
    const matcher = new RegExp(
      `(^|[^\\p{L}\\p{N}])(${flexibleKeyword})(?=$|[^\\p{L}\\p{N}])`,
      "giu",
    );
    return Math.max(1, Array.from(normalizedSource.matchAll(matcher)).length);
  } catch {
    const lowerSource = normalizedSource.toLowerCase();
    const lowerKeyword = trimmedKeyword.toLowerCase();
    let count = 0;
    let cursor = 0;

    while (cursor < lowerSource.length) {
      const nextIndex = lowerSource.indexOf(lowerKeyword, cursor);
      if (nextIndex === -1) {
        break;
      }
      count += 1;
      cursor = nextIndex + lowerKeyword.length;
    }

    return Math.max(1, count);
  }
}

function normalizeSignalWordCounts(
  signalWords: string[],
  input?: {
    sourceText?: string;
    existingCounts?: Record<string, unknown>;
  },
) {
  return signalWords.reduce<Record<string, number>>((counts, keyword) => {
    const existingCount = input?.existingCounts?.[keyword];
    counts[keyword] =
      typeof existingCount === "number" && Number.isFinite(existingCount)
        ? Math.max(1, Math.round(existingCount))
        : countSignalWordMentions(keyword, input?.sourceText ?? "");
    return counts;
  }, {});
}

function normalizeMermaidDiagram(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const candidate = trimmed
    .replace(/^```mermaid\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!/^(flowchart|graph)\s+(TB|TD|BT|RL|LR)\b/i.test(candidate)) {
    return "";
  }

  return candidate;
}

function countMermaidComplexity(diagram: string) {
  const lines = diagram
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const edgeCount = lines.filter((line) => /-->|---|-.->/.test(line)).length;
  const subgraphCount = lines.filter((line) =>
    /^subgraph\b/i.test(line),
  ).length;
  const nodeIds = new Set<string>();
  for (const line of lines) {
    const matches = line.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*[\[\(\{]/g);
    for (const match of matches) {
      nodeIds.add(match[1] || "");
    }
  }
  return {
    lineCount: lines.length,
    edgeCount,
    subgraphCount,
    nodeCount: nodeIds.size,
  };
}

function includesSignal(signals: string[], pattern: RegExp) {
  return signals.some((signal) => pattern.test(signal));
}

function buildSimpleArchitectureDiagram(result: CustomerAnalysisResult) {
  const signals = Array.isArray(result.signal_words) ? result.signal_words : [];

  const hasMicrosoftIdentity = includesSignal(
    signals,
    /\bentra\b|active directory|microsoft 365/i,
  );
  const hasAzure = includesSignal(signals, /\bazure\b/i);
  const hasNamedIntegration = includesSignal(
    signals,
    /\bid-?porten\b|noark|api/i,
  );
  const hasNamedData = includesSignal(signals, /\bpower bi\b|data|database/i);
  const hasNamedOps = includesSignal(
    signals,
    /\bci\/?cd\b|monitor|logging|backup/i,
  );

  return [
    "flowchart LR",
    '  subgraph Business["Brukere og forretning"]',
    "    Users[Forretningsbrukere og fagmiljø]",
    "    Apps[Applikasjoner og arbeidsflater]",
    "  end",
    '  subgraph Identity["Identitet"]',
    hasMicrosoftIdentity
      ? "    Identity[Microsoft Entra ID]"
      : "    Identity[Identitet og tilgang]",
    "  end",
    '  subgraph PlatformLayer["Plattform"]',
    hasAzure ? "    Platform[Azure-plattform]" : "    Platform[Plattform]",
    "  end",
    '  subgraph IntegrationLayer["Integrasjon og data"]',
    hasNamedIntegration
      ? "    Integration[API og integrasjoner]"
      : "    Integration[Integrasjonslag]",
    hasNamedData ? "    Data[Data og lagring]" : "    Data[Data og tjenester]",
    "  end",
    '  subgraph Operations["Sikkerhet og drift"]',
    hasNamedOps
      ? "    Ops[Overvåking, logging og backup]"
      : "    Ops[Drift og sikkerhet]",
    "  end",
    "",
    "  Users --> Apps",
    "  Apps --> Platform",
    "  Apps --> Integration",
    "  Identity --> Platform",
    "  Platform --> Integration",
    "  Integration --> Data",
    "  Platform --> Ops",
    "  Data --> Ops",
  ].join("\n");
}

function preferSimpleArchitectureDiagram(
  rawDiagram: string,
  result: CustomerAnalysisResult,
) {
  const normalized = normalizeMermaidDiagram(rawDiagram);
  if (!normalized) {
    return buildSimpleArchitectureDiagram(result);
  }

  const complexity = countMermaidComplexity(normalized);
  if (
    complexity.nodeCount > 10 ||
    complexity.edgeCount > 12 ||
    complexity.subgraphCount > 5 ||
    complexity.lineCount > 28
  ) {
    return buildSimpleArchitectureDiagram(result);
  }

  return normalized;
}

function normalizeRequirementList(
  requirements: CustomerAnalysisResult["implicit_requirements"],
) {
  const result: CustomerAnalysisResult["implicit_requirements"] = [];

  for (const requirement of requirements) {
    const title = requirement.title.replace(/\s+/g, " ").trim();
    const description = requirement.description.replace(/\s+/g, " ").trim();

    if (!title || !description) {
      continue;
    }

    if (
      result.some(
        (existing) =>
          isNearDuplicate(existing.title, title, 0.8) &&
          isNearDuplicate(existing.description, description, 0.72),
      )
    ) {
      continue;
    }

    result.push({
      ...requirement,
      title,
      description,
      source_reference: requirement.source_reference
        .replace(/\s+/g, " ")
        .trim(),
      source_excerpt: requirement.source_excerpt.replace(/\s+/g, " ").trim(),
    });
  }

  return result;
}

function normalizePercentShare(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.min(100, Math.max(1, Math.round(raw)));
}

function isValueCategory(value: unknown): value is ValueCategory {
  return (
    typeof value === "string" &&
    VALUE_CATEGORIES.includes(value as ValueCategory)
  );
}

function inferValueCategory(
  item: Pick<ValueOpportunity, "title" | "description">,
): ValueCategory {
  const text = `${item.title} ${item.description}`.toLowerCase();

  if (
    /risiko|sikkerhet|avbrudd|nedetid|kontroll|compliance|etterlevelse|robust|sårbar/.test(
      text,
    )
  ) {
    return "Redusert risiko";
  }

  if (
    /kost|kostnad|besparelse|økonomi|lisens|driftskost|finops|forbruk|reduser|reducer/.test(
      text,
    )
  ) {
    return "Lavere kostnader";
  }

  if (
    /bruker|opplevelse|selvbetjening|tilgjengelighet|adopsjon|respons|kundeopplevelse/.test(
      text,
    )
  ) {
    return "Bedre brukeropplevelse";
  }

  if (
    /produktiv|effektiv|automatis|arbeidsflyt|prosess|kapasitet|tidsbruk|standardiser/.test(
      text,
    )
  ) {
    return "Høyere produktivitet";
  }

  return "Redusert risiko";
}

function normalizeSingleValueCategory(item: ValueOpportunity): ValueCategory {
  const firstValidCategory = Array.isArray(item.value_categories)
    ? item.value_categories.find(isValueCategory)
    : null;

  return firstValidCategory ?? inferValueCategory(item);
}

function mergeValueOpportunityDescriptions(descriptions: string[]) {
  const mergedSentences: string[] = [];

  for (const description of descriptions) {
    const normalizedDescription = description.replace(/\s+/g, " ").trim();
    const sentences = splitIntoSentences(normalizedDescription);
    const candidates = sentences.length ? sentences : [normalizedDescription];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (
        mergedSentences.some((existing) =>
          isNearDuplicate(existing, candidate, 0.76),
        )
      ) {
        continue;
      }

      mergedSentences.push(candidate);
    }
  }

  return mergedSentences.join(" ").replace(/\s+/g, " ").trim();
}

function normalizeValueOpportunities(
  items: ValueOpportunity[],
): ValueOpportunity[] {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .filter((item) => item && item.title && item.description)
    .filter((item, index, array) => {
      return !array.some(
        (existing, existingIndex) =>
          existingIndex < index &&
          isNearDuplicate(existing.title, item.title, 0.8) &&
          isNearDuplicate(existing.description, item.description, 0.72),
      );
    })
    .map((item) => ({
      title: item.title.replace(/\s+/g, " ").trim(),
      description: item.description.replace(/\s+/g, " ").trim(),
      value_categories: [normalizeSingleValueCategory(item)],
      profit_share_percent:
        normalizePercentShare(
          (item as ValueOpportunity & { profit_share_percent?: unknown })
            .profit_share_percent,
        ) ?? 0,
    }));

  if (!normalizedItems.length) {
    return [];
  }

  const mergedByCategory = new Map<ValueCategory, ValueOpportunity>();

  for (const item of normalizedItems) {
    const category = item.value_categories[0];
    const existing = mergedByCategory.get(category);

    if (!existing) {
      mergedByCategory.set(category, item);
      continue;
    }

    mergedByCategory.set(category, {
      ...existing,
      description: mergeValueOpportunityDescriptions([
        existing.description,
        item.description,
      ]),
      value_categories: [category],
      profit_share_percent:
        existing.profit_share_percent + item.profit_share_percent,
    });
  }

  const filtered = VALUE_CATEGORIES.map((category) =>
    mergedByCategory.get(category),
  )
    .filter((item): item is ValueOpportunity => Boolean(item))
    .slice(0, 4);

  const providedTotal = filtered.reduce(
    (sum, item) => sum + (item.profit_share_percent || 0),
    0,
  );

  const normalizedPercents =
    providedTotal > 0
      ? filtered.map((item) =>
          Math.max(
            1,
            Math.round((item.profit_share_percent / providedTotal) * 100),
          ),
        )
      : filtered.map(() => Math.floor(100 / filtered.length));

  let currentTotal = normalizedPercents.reduce((sum, value) => sum + value, 0);
  let index = 0;
  while (currentTotal !== 100 && filtered.length > 0) {
    const direction = currentTotal < 100 ? 1 : -1;
    const targetIndex = index % filtered.length;
    if (direction > 0 || normalizedPercents[targetIndex] > 1) {
      normalizedPercents[targetIndex] += direction;
      currentTotal += direction;
    }
    index += 1;
  }

  return filtered.map((item, itemIndex) => ({
    ...item,
    profit_share_percent: normalizedPercents[itemIndex] || 1,
  }));
}

function inferRiskAudience(item: string): "us" | "customer" {
  const text = item.toLowerCase();

  if (
    /tilbud|leverandør|leveranse|team|ressurs|kompetanse|kapasitet|scope|omfang|pris|margin|kontrakt|avklaring|posisjonering|forplikt|ansvar/.test(
      text,
    )
  ) {
    return "us";
  }

  return "customer";
}

function normalizeRiskGroups(result: CustomerAnalysisResult) {
  const explicitForUs = capNormalizedList(
    Array.isArray(result.risks_for_us) ? result.risks_for_us : [],
  );
  const explicitForCustomer = capNormalizedList(
    Array.isArray(result.risks_for_customer) ? result.risks_for_customer : [],
  );
  const legacyRisks = capNormalizedList(
    Array.isArray(result.risks) ? result.risks : [],
  );

  if (explicitForUs.length || explicitForCustomer.length) {
    const risks = capNormalizedList([...explicitForCustomer, ...explicitForUs]);
    return {
      risks,
      risksForUs: explicitForUs,
      risksForCustomer: explicitForCustomer,
    };
  }

  const risksForUs: string[] = [];
  const risksForCustomer: string[] = [];

  for (const risk of legacyRisks) {
    if (inferRiskAudience(risk) === "us") {
      risksForUs.push(risk);
    } else {
      risksForCustomer.push(risk);
    }
  }

  return {
    risks: legacyRisks,
    risksForUs: capNormalizedList(risksForUs),
    risksForCustomer: capNormalizedList(risksForCustomer),
  };
}

function normalizeCustomerAnalysisResult(
  result: CustomerAnalysisResult,
  options?: { signalSourceText?: string },
): CustomerAnalysisResult {
  const customerProfile = capNormalizedList(
    Array.isArray(result.customer_profile) ? result.customer_profile : [],
  );
  const customerGoals = capNormalizedList(
    Array.isArray(result.customer_goals) ? result.customer_goals : [],
  );
  const { risks, risksForUs, risksForCustomer } = normalizeRiskGroups(result);
  const likelyEvaluationCriteria = capNormalizedList(
    Array.isArray(result.likely_evaluation_criteria)
      ? result.likely_evaluation_criteria
      : [],
  );
  const signalWords = normalizeSignalWords(
    Array.isArray(result.signal_words) ? result.signal_words : [],
  );
  const signalWordCounts = normalizeSignalWordCounts(signalWords, {
    sourceText: options?.signalSourceText,
    existingCounts: result.signal_word_counts,
  });
  const expectedSolutionDirection = capNormalizedList(
    Array.isArray(result.expected_solution_direction)
      ? result.expected_solution_direction
      : [],
  );
  const positioningRecommendations = capNormalizedList(
    Array.isArray(result.positioning_recommendations)
      ? result.positioning_recommendations
      : [],
  );
  const ambiguities = capNormalizedList(
    Array.isArray(result.ambiguities) ? result.ambiguities : [],
    { max: 12 },
  );
  const prioritizedRequirements = (
    Array.isArray(result.prioritized_requirements)
      ? result.prioritized_requirements
      : []
  )
    .filter((item) => item && item.requirement && item.priority && item.reason)
    .filter((item, index, array) => {
      return !array.some(
        (existing, existingIndex) =>
          existingIndex < index &&
          isNearDuplicate(existing.requirement, item.requirement, 0.8) &&
          isNearDuplicate(existing.reason, item.reason, 0.72),
      );
    })
    .slice(0, 10);
  const valueOpportunities = normalizeValueOpportunities(
    Array.isArray(result.value_opportunities) ? result.value_opportunities : [],
  );

  const customerProfileSummary = dedupeSummary(
    result.customer_profile_summary || customerProfile.slice(0, 2).join(" "),
    [
      ...customerGoals,
      result.customer_goals_summary || "",
      ...positioningRecommendations,
    ],
  );

  const customerGoalsSummary = dedupeSummary(
    result.customer_goals_summary || customerGoals.slice(0, 2).join(" "),
    [customerProfileSummary, ...customerProfile, ...positioningRecommendations],
  );

  const highLevelSolutionDesign = dedupeSummary(
    result.high_level_solution_design ||
      expectedSolutionDirection.slice(0, 2).join(" "),
    [
      customerProfileSummary,
      customerGoalsSummary,
      ...customerProfile,
      ...customerGoals,
      ...positioningRecommendations,
      ...expectedSolutionDirection,
    ],
  );
  const highLevelArchitectureMermaid = preferSimpleArchitectureDiagram(
    result.high_level_architecture_mermaid || "",
    result,
  );

  const executiveSummary = dedupeSummary(result.executive_summary || "", [
    customerProfileSummary,
    customerGoalsSummary,
    highLevelSolutionDesign,
    ...customerProfile,
    ...customerGoals,
    ...risks,
    ...positioningRecommendations,
  ]);

  return {
    ...result,
    customer_profile_summary: customerProfileSummary,
    customer_goals_summary: customerGoalsSummary,
    high_level_solution_design: highLevelSolutionDesign,
    high_level_architecture_mermaid: highLevelArchitectureMermaid,
    customer_profile: customerProfile,
    customer_goals: customerGoals,
    implicit_requirements: normalizeRequirementList(
      Array.isArray(result.implicit_requirements)
        ? result.implicit_requirements
        : [],
    ),
    prioritized_requirements: prioritizedRequirements,
    ambiguities,
    risks,
    risks_for_us: risksForUs,
    risks_for_customer: risksForCustomer,
    likely_evaluation_criteria: likelyEvaluationCriteria,
    signal_words: signalWords,
    signal_word_counts: signalWordCounts,
    expected_solution_direction: expectedSolutionDirection,
    value_opportunities: valueOpportunities,
    positioning_recommendations: positioningRecommendations,
    executive_summary: executiveSummary,
  };
}

type CustomerAnalysisSectionPatch = Partial<
  Pick<
    CustomerAnalysisResult,
    | "customer_profile_summary"
    | "customer_goals_summary"
    | "high_level_solution_design"
    | "high_level_architecture_mermaid"
    | "implicit_requirements"
    | "risks"
    | "risks_for_us"
    | "risks_for_customer"
    | "signal_words"
    | "value_opportunities"
    | "ambiguities"
    | "expected_solution_direction"
    | "likely_evaluation_criteria"
    | "positioning_recommendations"
    | "executive_summary"
  >
>;

const CUSTOMER_ANALYSIS_SECTION_CONFIG: Record<
  CustomerAnalysisSection,
  {
    label: string;
    fields: string;
    guidance: string[];
    outputContract: string[];
  }
> = {
  summary: {
    label: "Oppsummering",
    fields: "customer_profile_summary og customer_goals_summary",
    guidance: [
      "Rediger kun lederoppsummeringen av kunden.",
      "customer_profile_summary skal forklare kundesituasjonen, modenhet, rammer og relevant kontekst.",
      "customer_goals_summary skal forklare kundens mål, ønsket effekt, utviklingsretning og hvilken løsningsretning dette peker mot.",
    ],
    outputContract: [
      "Returner kun JSON med customer_profile_summary og customer_goals_summary.",
      "Begge verdier skal være presise, konkrete tekststrenger.",
    ],
  },
  strategy: {
    label: "Strategi",
    fields: "executive_summary og positioning_recommendations",
    guidance: [
      "Rediger kun tilbudsteamets operative strategi og anbefalte posisjonering.",
      "executive_summary skal være arbeidsteksten som brukes videre i tilbudet.",
      "positioning_recommendations skal være konkrete anbefalinger til hvordan tilbudet bør spisses.",
    ],
    outputContract: [
      "Returner kun JSON med executive_summary og positioning_recommendations.",
      "positioning_recommendations skal være en liste med 3 til 5 konkrete tekstpunkter.",
    ],
  },
  clarifications: {
    label: "Avklaringer",
    fields:
      "ambiguities, expected_solution_direction og likely_evaluation_criteria",
    guidance: [
      "Rediger kun avklaringer og foreløpig retning mellom strategi og design.",
      "ambiguities skal være konkrete åpne spørsmål som må tas med kunden eller tilbudsteamet før design låses. Formuler dem som spørsmål.",
      "Punktene skal opplyse hvilke behov, prioriteringer, rammer, ansvar, kontraktsføringer eller retningsvalg kunden faktisk har.",
      "Se spesielt etter avklaringer om Annex 01B-01G, krav-ID-er, omfang, multisourcing-ansvar, eksisterende avtaler, onsite support, lokasjoner, brukergrupper, åpningstid, beredskap/24x7, servicedesk, overvåkning, sikkerhetsoperasjon, applikasjonsforvaltning, RPO/RTO, backup/restore, Azure/on-prem-miljøer, modernisering, migrering, KPI-er, governance, bærekraft, språkkrav, sikkerhet, regulatoriske føringer og samfunnskritisk rolle.",
      "expected_solution_direction skal beskrive hvilken løsningsretning kildene peker mot før endelig high-level design.",
      "likely_evaluation_criteria skal forklare hva kunden sannsynligvis vil vurdere leverandører og løsning på.",
    ],
    outputContract: [
      "Returner kun JSON med ambiguities, expected_solution_direction og likely_evaluation_criteria.",
      "Alle tre feltene skal være lister med konkrete tekstpunkter.",
      "ambiguities skal normalt ha 8 til 12 spørsmål når dokumentgrunnlaget gir nok usikkerhet. De to andre listene skal normalt ha 3 til 5 punkter.",
    ],
  },
  design: {
    label: "Design",
    fields: "high_level_solution_design og high_level_architecture_mermaid",
    guidance: [
      "Rediger kun anbefalt high-level design og arkitekturdiagram.",
      "high_level_solution_design skal være en konkret, erfaren skyarkitekt-anbefaling.",
      "high_level_architecture_mermaid skal være et enkelt high-level diagram med få hovednoder.",
    ],
    outputContract: [
      "Returner kun JSON med high_level_solution_design og high_level_architecture_mermaid.",
      "high_level_architecture_mermaid skal være ren Mermaid-kode som starter med flowchart eller graph.",
    ],
  },
  risks: {
    label: "Risiko",
    fields: "risks_for_us, risks_for_customer og risks",
    guidance: [
      "Rediger kun risiko og usikkerhet.",
      "risks_for_us skal beskrive leverandørens/tilbudsteamets risiko: leveranserisiko, tilbudsrisiko, kommersiell risiko, ressurs-/kompetanserisiko, avklaringsbehov og risiko for feil posisjonering.",
      "risks_for_customer skal beskrive kundens risiko: driftsavbrudd, sikkerhet, overgang, kostnadskontroll, brukeradopsjon, forvaltning, etterlevelse og forretningsmessig konsekvens.",
      "risks skal være en kort samlet kompatibilitetsliste basert på de to delte feltene.",
      "Ikke gjenta krav, mål eller posisjonering som risiko hvis det ikke faktisk er en usikkerhet.",
    ],
    outputContract: [
      "Returner kun JSON med risks_for_us, risks_for_customer og risks.",
      "risks_for_us og risks_for_customer skal være lister med 0 til 5 konkrete tekstpunkter hver. Ikke finn opp risiko uten støtte i dokument eller eksisterende analyse.",
      "risks skal være en samlet liste med korte tekstpunkter fra begge kategorier.",
    ],
  },
  needs: {
    label: "Behov",
    fields: "implicit_requirements",
    guidance: [
      "Rediger kun underliggende behov og implisitte krav.",
      "Returner nøyaktig de 3 viktigste punktene som gir mest forståelse av hva kunden egentlig vil.",
      "Hvert punkt skal være en rimelig tolkning som er relevant for tilbudsarbeid.",
      "Hver description skal sidestille hva kunden i praksis ber om med hva kunden ikke vil kjøpe eller ikke bør posisjoneres som.",
      "Bruk konkrete, tilbudsrettede kontraster, for eksempel: selg dette som trygg modernisering av logistikkritisk plattform, ikke som en generell skyreise.",
      "Ikke inkluder eksplisitte krav som bare hører hjemme i kravlisten.",
    ],
    outputContract: [
      "Returner kun JSON med implicit_requirements.",
      "implicit_requirements skal være en liste av objekter med title, description, category, importance, kind, source_reference og source_excerpt.",
      "implicit_requirements skal inneholde nøyaktig 3 objekter.",
      "importance skal være Kritisk, Viktig eller Mindre viktig. kind skal være Implisitt.",
    ],
  },
  keywords: {
    label: "Nøkkelord",
    fields: "signal_words",
    guidance: [
      "Rediger kun gjenbrukte nøkkelord.",
      "signal_words skal være konkrete teknologier, tekniske tjenester, kontrollflater, integrasjonsteknologier eller arkitekturkomponenter med en tydelig funksjon i løsningen.",
      "Ikke inkluder brede plattformnavn alene, som Azure, Microsoft 365, M365, cloud, sikkerhet, nettverk eller compliance. Bruk presise tjenester eller funksjoner, for eksempel Azure Monitor, Azure Backup, Azure Policy, Azure Landing Zone, Microsoft Defender for Endpoint, Intune MDM, SharePoint Online, Exchange Online, Entra ID Conditional Access, OAuth 2.0 eller OpenAPI.",
      "Ikke inkluder kontrakts-, dokument- eller vedleggstitler som SSA-D, Annex 01B-01G, Bilag, Vedlegg, kravnummer eller kapittelnavn.",
      "Ikke inkluder generiske ord som moderne, effektivitet, brukeropplevelse, robust eller skalerbar.",
      "Hvis kildene bare nevner en bred plattform uten konkret tjeneste eller teknisk funksjon, utelat den fremfor å gjette.",
    ],
    outputContract: [
      "Returner kun JSON med signal_words.",
      "signal_words skal være en liste med maksimalt 8 konkrete teknologi-/funksjonsnavn.",
    ],
  },
  value: {
    label: "Verdi",
    fields: "value_opportunities",
    guidance: [
      "Rediger kun verdimuligheter.",
      "value_opportunities skal ha maksimalt 4 punkter.",
      "Hvert punkt skal ha nøyaktig én value_category: Høyere produktivitet, Lavere kostnader, Redusert risiko eller Bedre brukeropplevelse.",
      "Bruk hver value_category maksimalt én gang i hele listen. Ikke returner duplikater av samme kategori.",
      "Ikke kombiner flere verdikategorier i samme punkt. Forklar hvordan verdien skapes og hvorfor den er viktig.",
      "profit_share_percent skal være dokument- og signalbasert: vekt etter eksplisitthet, forretningskritikalitet, driftskonsekvens, repetisjon og tydelig kobling til anskaffelsens mål.",
      "Ikke bruk jevn eller pen prosentfordeling uten dokumentgrunnlag. Bruk presise, konservative heltall.",
    ],
    outputContract: [
      "Returner kun JSON med value_opportunities.",
      "value_opportunities skal være objekter med title, description, value_categories og profit_share_percent.",
      "value_categories skal alltid være en array med nøyaktig ett element.",
      "Ingen value_category kan gjentas i value_opportunities.",
      "profit_share_percent skal være heltall mellom 1 og 100, samlet fordelt til 100 prosent.",
    ],
  },
};

function normalizeSolutionEvaluationResult(
  result: SolutionEvaluationResult,
): SolutionEvaluationResult {
  const strengths = capNormalizedList(
    Array.isArray(result.strengths) ? result.strengths : [],
  );
  const weaknesses = capNormalizedList(
    Array.isArray(result.weaknesses) ? result.weaknesses : [],
  );
  const genericSections = capNormalizedList(
    Array.isArray(result.generic_sections) ? result.generic_sections : [],
  );
  const missingElements = capNormalizedList(
    Array.isArray(result.missing_elements) ? result.missing_elements : [],
  );
  const risksToCustomer = capNormalizedList(
    Array.isArray(result.risks_to_customer) ? result.risks_to_customer : [],
  );
  const trustSignals = capNormalizedList(
    Array.isArray(result.trust_signals) ? result.trust_signals : [],
  );
  const improvementRecommendations = capNormalizedList(
    Array.isArray(result.improvement_recommendations)
      ? result.improvement_recommendations
      : [],
  );
  const valueAssessment = normalizeValueOpportunities(
    Array.isArray(result.value_assessment) ? result.value_assessment : [],
  );
  const rawComparison = result.architecture_comparison;
  const comparisonWinner = rawComparison?.winner;
  const architectureComparison = {
    winner:
      comparisonWinner === "Systemløsning" ||
      comparisonWinner === "Arkitektløsning" ||
      comparisonWinner === "Uavgjort"
        ? comparisonWinner
        : ("Uavgjort" as const),
    architect_solution_score: normalizeComparisonScore(
      rawComparison?.architect_solution_score,
    ),
    system_solution_score: normalizeComparisonScore(
      rawComparison?.system_solution_score,
    ),
    verdict: (rawComparison?.verdict || "").replace(/\s+/g, " ").trim(),
    strong_critique: capNormalizedList(
      Array.isArray(rawComparison?.strong_critique)
        ? rawComparison.strong_critique
        : [],
      { max: 6 },
    ),
    pragmatic_reflections: capNormalizedList(
      Array.isArray(rawComparison?.pragmatic_reflections)
        ? rawComparison.pragmatic_reflections
        : [],
      { max: 6 },
    ),
    strategy_improvement_advice: capNormalizedList(
      Array.isArray(rawComparison?.strategy_improvement_advice)
        ? rawComparison.strategy_improvement_advice
        : [],
      { max: 6 },
    ),
  };

  return {
    ...result,
    fit_to_customer_needs: (result.fit_to_customer_needs || "")
      .replace(/\s+/g, " ")
      .trim(),
    strengths,
    weaknesses,
    generic_sections: genericSections,
    missing_elements: missingElements,
    risks_to_customer: risksToCustomer,
    trust_signals: trustSignals,
    improvement_recommendations: improvementRecommendations,
    value_assessment: valueAssessment,
    architecture_comparison: architectureComparison,
    executive_summary: dedupeSummary(result.executive_summary || "", [
      result.fit_to_customer_needs,
      ...strengths,
      ...weaknesses,
      ...genericSections,
      ...missingElements,
      ...risksToCustomer,
      ...improvementRecommendations,
    ]),
  };
}

function normalizeExecutiveSummaryResult(
  result: Partial<ExecutiveSummaryResult> | null | undefined,
): ExecutiveSummaryResult {
  const source = result ?? {};
  const score = source.likely_score_assessment ?? {
    quality: "",
    delivery_confidence: "",
    risk: "",
    competitiveness: "",
  };

  return {
    source_solution_evaluation_present: Boolean(
      source.source_solution_evaluation_present,
    ),
    executive_summary: compactText(source.executive_summary ?? "", 1600),
    fit_to_customer_needs: compactText(source.fit_to_customer_needs ?? "", 1600),
    likely_score_assessment: {
      quality: compactText(score.quality ?? "", 500),
      delivery_confidence: compactText(score.delivery_confidence ?? "", 500),
      risk: compactText(score.risk ?? "", 500),
      competitiveness: compactText(score.competitiveness ?? "", 500),
    },
    strengths: capNormalizedList(source.strengths ?? [], { max: 4 }),
    weaknesses: capNormalizedList(source.weaknesses ?? [], { max: 4 }),
  };
}

function normalizeComparisonScore(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(raw)));
}

function supportsCustomTemperature(model: string) {
  return !GPT_MODELS_USE_DEFAULT_TEMPERATURE.test(model);
}

async function createJsonCompletion<T>(input: {
  system: string;
  user: string;
  temperature?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<T> {
  const client = await getClient();
  const model = input.model ?? ANALYSIS_MODEL;
  const response = await client.chat.completions.create({
    model,
    reasoning_effort: input.reasoningEffort ?? ANALYSIS_REASONING_EFFORT,
    ...(supportsCustomTemperature(model)
      ? { temperature: input.temperature ?? 0.1 }
      : {}),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("AI returnerte tomt svar.");
  }

  return parseJson<T>(content);
}

async function createJsonCompletionWithFileInputs<T>(input: {
  system: string;
  user: string;
  fileDocuments: ProjectDocumentDetail[];
  temperature?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<T> {
  const client = await getClient();
  const model = input.model ?? ANALYSIS_MODEL;
  const content = [
    ...input.fileDocuments.map((document) => ({
      type: "input_file",
      filename: document.file_name,
      file_data: `data:${document.content_type};base64,${document.file_base64}`,
    })),
    {
      type: "input_text",
      text: input.user,
    },
  ];
  const response = await client.responses.create({
    model,
    instructions: input.system,
    reasoning: { effort: input.reasoningEffort ?? ANALYSIS_REASONING_EFFORT },
    ...(supportsCustomTemperature(model)
      ? { temperature: input.temperature ?? 0.1 }
      : {}),
    input: [{ role: "user", content }],
  });

  const outputText = response.output_text?.trim();
  if (!outputText) {
    throw new Error("AI returnerte tomt svar.");
  }

  return parseJson<T>(outputText);
}

async function createTextCompletion(input: {
  system: string;
  user: string;
  temperature?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}) {
  const client = await getClient();
  const model = input.model ?? ANALYSIS_MODEL;
  const response = await client.chat.completions.create({
    model,
    reasoning_effort: input.reasoningEffort ?? ANALYSIS_REASONING_EFFORT,
    ...(supportsCustomTemperature(model)
      ? { temperature: input.temperature ?? 0.3 }
      : {}),
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

export async function analyzeCustomerDocuments(input: {
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  model?: string;
}) {
  const supportingContexts = input.supportingDocuments
    .slice(0, 2)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 4000,
        structureLimit: 6,
        structureTextLimit: 160,
      }),
    )
    .join("\n\n");

  const userPrompt = [
    "Analyser prosjektet og returner kun gyldig JSON.",
    "Skill tydelig mellom eksplisitte krav og implisitte krav.",
    "Alle verdiutsagn må knyttes til nøyaktig én av de fire faste verdikategoriene.",
    "",
    buildDelimitedContext(
      "Prosjekt",
      `Prosjektnavn: ${input.projectName}\nArbeid som et tilbudsteam som skal forstå kunden dypt og bruke funnene i posisjonering, løsningsarbeid og tilbudsbesvarelse.`,
    ),
    documentContext("Primært kundedokument", input.customerDocument, {
      textLimit: 12000,
      structureLimit: 10,
      structureTextLimit: 180,
    }),
    buildDelimitedContext(
      "Dokumentdekningsregel",
      "Bruk strukturkartet og tekstutdraget aktivt. Hvis dokumentet viser til tabeller, figurer, vedlegg eller krav som ikke er synlige i tekstutdraget, marker dette nøkternt som et verifikasjonsbehov i analysen fremfor å anta innhold.",
    ),
    supportingContexts
      ? buildDelimitedContext(
          "Tilleggsregel",
          "Bruk støttedokumentene bare som støtte og kontekst. Ikke la dem overstyre primært kundedokument.",
        )
      : "",
    supportingContexts,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await createJsonCompletion<CustomerAnalysisResult>({
    system: buildCustomerAnalysisPrompt(),
    user: userPrompt,
    temperature: 0.1,
    model: input.model ?? ANALYSIS_MODEL,
    reasoningEffort: ANALYSIS_REASONING_EFFORT,
  });

  const signalSourceText = [
    input.customerDocument.raw_text,
    ...input.supportingDocuments.map((document) => document.raw_text),
  ].join("\n\n");

  return normalizeCustomerAnalysisResult(result, { signalSourceText });
}

export async function regenerateCustomerAnalysisSection(input: {
  section: CustomerAnalysisSection;
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  customerAnalysis: CustomerAnalysisResult;
  model?: string;
}) {
  const config = CUSTOMER_ANALYSIS_SECTION_CONFIG[input.section];
  const customerAnalysis = stripCustomerAnalysisHistory(input.customerAnalysis);
  const customerDocumentDigest = await buildDocumentInsightDigest(
    "Primært kundedokument",
    input.customerDocument,
    { maxChunks: 6 },
  );
  const supportingContexts = input.supportingDocuments
    .slice(0, 6)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 6000,
        structureLimit: 6,
        structureTextLimit: 160,
      }),
    )
    .join("\n\n");

  const systemPrompt = buildPromptTemplate({
    role: "Du er en senior løsningsarkitekt og tilbudsansvarlig som redigerer én avgrenset del av en eksisterende kundeanalyse uten å endre resten.",
    task: [
      `Rediger seksjonen ${config.label}.`,
      `Du skal bare returnere feltene: ${config.fields}.`,
      "Bruk kundedokumentet, støttedokumenter og eksisterende analyse som kontekst.",
      "Skriv konkret, tekstnært og nyttig for et tilbudsteam.",
    ],
    rules: [
      "Returner kun gyldig JSON.",
      "Ikke returner felter som ikke er bedt om.",
      "Ikke skriv generisk konsulentspråk.",
      "Ikke gjenta samme observasjon med små omskrivninger.",
      ...config.guidance,
    ],
    outputContract: config.outputContract,
    exampleOutput: "{}",
  });

  const userPrompt = [
    `Rediger bare ${config.label} for prosjektet.`,
    "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    documentContext("Primært kundedokument", input.customerDocument, {
      textLimit: 14000,
      structureLimit: 10,
      structureTextLimit: 180,
    }),
    customerDocumentDigest ?? "",
    supportingContexts
      ? buildDelimitedContext(
          "Tilleggsregel",
          "Bruk støttedokumentene bare som støtte og kontekst. Ikke la dem overstyre primært kundedokument.",
        )
      : "",
    supportingContexts,
    buildDelimitedContext(
      "Eksisterende kundeanalyse",
      JSON.stringify(customerAnalysis, null, 2),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const patch = await createJsonCompletion<CustomerAnalysisSectionPatch>({
    system: systemPrompt,
    user: userPrompt,
    temperature: 0.1,
    model: input.model ?? ANALYSIS_MODEL,
    reasoningEffort: ANALYSIS_REASONING_EFFORT,
  });

  const signalSourceText = [
    input.customerDocument.raw_text,
    ...input.supportingDocuments.map((document) => document.raw_text),
  ].join("\n\n");

  return normalizeCustomerAnalysisResult(
    {
      ...customerAnalysis,
      ...patch,
    },
    { signalSourceText },
  );
}

export async function generateHighLevelDesign(input: {
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  customerAnalysis: CustomerAnalysisResult;
  model?: string;
}) {
  const customerAnalysis = stripCustomerAnalysisHistory(input.customerAnalysis);
  const customerDocumentDigest = await buildDocumentInsightDigest(
    "Primært kundedokument",
    input.customerDocument,
    { maxChunks: 5 },
  );
  const supportingContexts = input.supportingDocuments
    .slice(0, 4)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 5000,
        structureLimit: 6,
        structureTextLimit: 150,
      }),
    )
    .join("\n\n");

  const userPrompt = [
    "Generer kun high-level design og diagram. Returner kun gyldig JSON.",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    documentContext("Primært kundedokument", input.customerDocument, {
      textLimit: 10000,
      structureLimit: 8,
      structureTextLimit: 160,
    }),
    customerDocumentDigest ?? "",
    buildDelimitedContext(
      "Eksisterende kundeanalyse",
      summarizeCustomerAnalysis(customerAnalysis),
    ),
    supportingContexts
      ? buildDelimitedContext(
          "Tilleggsregel",
          "Bruk støttedokumentene som støtte. Ikke overstyr primært kundedokument eller eksisterende kundeanalyse uten tydelig grunnlag.",
        )
      : "",
    supportingContexts,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await createJsonCompletion<{
    high_level_solution_design: string;
    high_level_architecture_mermaid: string;
  }>({
    system: buildHighLevelDesignPrompt(),
    user: userPrompt,
    temperature: 0.12,
    model: input.model ?? ANALYSIS_MODEL,
    reasoningEffort: ANALYSIS_REASONING_EFFORT,
  });

  const highLevelSolutionDesign = dedupeSummary(
    result.high_level_solution_design || "",
    [
      customerAnalysis.customer_profile_summary,
      customerAnalysis.customer_goals_summary,
      ...customerAnalysis.positioning_recommendations,
      customerAnalysis.executive_summary,
    ],
  );

  return {
    high_level_solution_design: highLevelSolutionDesign,
    high_level_architecture_mermaid: normalizeMermaidDiagram(
      result.high_level_architecture_mermaid || "",
    ),
  };
}

export async function evaluateSolutionDocument(input: {
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  solutionDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  customerAnalysis: CustomerAnalysisResult;
  systemSolutionArtifact?: {
    title: string;
    content_markdown: string;
  } | null;
  model?: string;
  documentLedgerContext?: string;
}) {
  const [customerDocumentDigest, solutionDocumentDigest] = await Promise.all([
    buildDocumentInsightDigest("Primært kundedokument", input.customerDocument, {
      maxChunks: 5,
    }),
    buildDocumentInsightDigest(
      "Importert arkitekt-/løsningsdokument",
      input.solutionDocument,
      { maxChunks: 6 },
    ),
  ]);
  const supportingContexts = input.supportingDocuments
    .slice(0, 2)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 3500,
        structureLimit: 4,
        structureTextLimit: 140,
      }),
    )
    .join("\n\n");

  const userPrompt = [
    "Sammenlign systemets lagrede strategi/løsning med det importerte løsnings-/arkitektdokumentet.",
    "Vurder hvilken løsning som er best, gi sterk kritikk, pragmatiske refleksjoner, strategiråd og score.",
    "Returner kun gyldig JSON.",
    "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    input.documentLedgerContext
      ? buildDelimitedContext(
          "Evalueringsledger",
          "Bruk ledgeren til å koble evalueringskriterier, må-krav og bør-krav til løsningens dekning. Gi bare score når kildegrunnlaget finnes.\n\n" +
            input.documentLedgerContext,
        )
      : "",
    documentContext("Primært kundedokument", input.customerDocument, {
      textLimit: 7000,
      structureLimit: 8,
      structureTextLimit: 160,
    }),
    customerDocumentDigest ?? "",
    buildDelimitedContext(
      "Lagret kundeanalyse",
      summarizeCustomerAnalysis(input.customerAnalysis),
    ),
    input.systemSolutionArtifact
      ? buildDelimitedContext(
          "Systemløsning som skal scores",
          [
            `Tittel: ${input.systemSolutionArtifact.title}`,
            compactText(input.systemSolutionArtifact.content_markdown, 9000),
          ].join("\n\n"),
        )
      : "",
    input.systemSolutionArtifact
      ? buildDelimitedContext(
          "Viktig scoringsregel for systemløsningen",
          "Når en systemløsning er oppgitt i eget felt, skal denne teksten være primærgrunnlaget for architecture_comparison.system_solution_score. Kundeanalysen er da støtte og kontekst, ikke erstatning for systemløsningen.",
        )
      : "",
    documentContext("Primært løsningsdokument", input.solutionDocument, {
      textLimit: 7000,
      structureLimit: 8,
      structureTextLimit: 160,
    }),
    solutionDocumentDigest
      ? buildDelimitedContext(
          "Analyseinstruks for arkitektdokument",
          "Bruk bred dokumentdekning for arkitektdokumentet aktivt. Den dekker flere sider/blokker enn hovedutdraget, og skal brukes når du scorer, kritiserer og sammenligner arkitektløsningen mot systemløsningen. Visuelle elementer, grafer og tabeller uten maskinlesbar tekst skal behandles som verifikasjonsbehov, ikke som sikre funn.",
        )
      : "",
    solutionDocumentDigest ?? "",
    supportingContexts,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await createJsonCompletion<SolutionEvaluationResult>({
    system: buildSolutionEvaluationPrompt(),
    user: userPrompt,
    temperature: 0.1,
    model: input.model ?? ANALYSIS_MODEL,
    reasoningEffort: ANALYSIS_REASONING_EFFORT,
  });

  return normalizeSolutionEvaluationResult(result);
}

export async function generateExecutiveSummary(input: {
  projectName: string;
  customerAnalysis: CustomerAnalysisResult | null;
  solutionEvaluation: SolutionEvaluationResult;
  model?: string;
}) {
  const userPrompt = [
    "Lag en separat lederoppsummering basert på den ferdige løsningsvurderingen.",
    "Dette er en egen dataflyt: lederoppsummeringen skal være en ny kondensert ledertekst, ikke en kopi av vurderingens executive_summary.",
    "Returner kun gyldig JSON.",
    "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    input.customerAnalysis
      ? buildDelimitedContext(
          "Kundeanalyse",
          summarizeCustomerAnalysis(input.customerAnalysis),
        )
      : "",
    buildDelimitedContext(
      "Løsningsvurdering",
      summarizeSolutionEvaluation(input.solutionEvaluation),
    ),
    input.solutionEvaluation.architecture_comparison
      ? buildDelimitedContext(
          "Arkitektursammenligning",
          JSON.stringify(input.solutionEvaluation.architecture_comparison, null, 2),
        )
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await createJsonCompletion<ExecutiveSummaryResult>({
    system: buildExecutiveSummaryPrompt(),
    user: userPrompt,
    temperature: 0.12,
    model: input.model ?? FAST_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
  });

  return normalizeExecutiveSummaryResult(result);
}

export async function generateProjectArtifact(input: {
  artifactType: GeneratedArtifactType;
  projectName: string;
  customerAnalysis: CustomerAnalysisResult | null;
  solutionEvaluation: SolutionEvaluationResult | null;
  customerDocument: ProjectDocumentDetail | null;
  solutionDocument: ProjectDocumentDetail | null;
  serviceDescriptionDocument?: ProjectDocumentDetail | null;
  serviceDescriptionDocuments?: ServiceDocumentDetail[];
  serviceDocumentSummaries?: ServiceDocument[];
  supportingDocuments: ProjectDocumentDetail[];
  requirementDocuments?: ProjectDocumentDetail[];
  knowledgeArtifacts: Array<{
    title: string;
    content_markdown: string;
    artifact_type: GeneratedArtifactType;
  }>;
  instructions?: string;
  model?: string;
  onProgress?: (message: string) => void;
  documentLedgerContext?: string;
}) {
  const shouldBuildPrimaryDigests = input.artifactType !== "forbedret_kravsvar";
  const [customerDocumentDigest, solutionDocumentDigest] =
    shouldBuildPrimaryDigests
      ? await Promise.all([
          input.customerDocument
            ? buildDocumentInsightDigest("Primært kundedokument", input.customerDocument, {
                maxChunks: 4,
              })
            : Promise.resolve(null),
          input.solutionDocument
            ? buildDocumentInsightDigest(
                "Primært løsningsdokument",
                input.solutionDocument,
                { maxChunks: 4 },
              )
            : Promise.resolve(null),
        ])
      : [null, null];
  const supportingContexts = input.supportingDocuments
    .slice(0, 6)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 2600,
        structureLimit: 4,
        structureTextLimit: 140,
      }),
    )
    .join("\n\n");
  const serviceDocuments =
    input.artifactType === "bilag1_rekonstruksjon"
      ? []
      : [
          ...(input.serviceDescriptionDocuments ?? []).map(
            serviceDocumentAsProjectDocument,
          ),
          ...(input.serviceDescriptionDocument
            ? [input.serviceDescriptionDocument]
            : []),
        ];
  const serviceDocumentLimit =
    input.artifactType === "forbedret_kravsvar" ? 5 : 3;
  const serviceContextBudget =
    input.artifactType === "forbedret_kravsvar" ? 7000 : 4000;
  const serviceDescriptionContext = serviceDocuments
    .slice(0, serviceDocumentLimit)
    .map((document, index) =>
      documentContext(
        `Tjenestebeskrivelse ${index + 1} - firmaets relevante tjenester og verktøy`,
        document,
        {
          textLimit: Math.max(
            900,
            Math.floor(
              serviceContextBudget / Math.max(1, serviceDocumentLimit),
            ),
          ),
          structureLimit:
            input.artifactType === "forbedret_kravsvar" ? 6 : 3,
          structureTextLimit:
            input.artifactType === "forbedret_kravsvar" ? 160 : 120,
        },
      ),
    )
    .join("\n\n");
  const serviceSummaryContext = (input.serviceDocumentSummaries ?? [])
    .map((document, index) =>
      buildDelimitedContext(
        `Tjenestesammendrag ${index + 1}`,
        [
          `Tittel: ${document.title}`,
          `Filnavn: ${document.file_name}`,
          `Sammendrag: ${
            document.ai_summary?.trim() ||
            "Mangler forhåndssammendrag. Bruk råtekst bare hvis dokumentet er hentet som detaljkontekst."
          }`,
        ].join("\n"),
      ),
    )
    .join("\n\n");
  const requirementDocuments =
    input.artifactType === "forbedret_kravsvar"
      ? (input.requirementDocuments?.length
          ? input.requirementDocuments
          : [
              input.customerDocument,
              input.solutionDocument,
              ...input.supportingDocuments,
            ])
          .filter(
            (document): document is ProjectDocumentDetail =>
              document !== null &&
              (Boolean(input.requirementDocuments?.length) ||
                isRequirementDocument(document)),
          )
          .slice(0, 3)
      : [];
  const requirementLedgers =
    input.artifactType === "forbedret_kravsvar"
      ? await Promise.all(
          requirementDocuments.map((document) =>
            buildRequirementSourceLedgerWithFiles(document),
          ),
        )
      : [];
  const requirementLedger = dedupeRequirementLedger(requirementLedgers.flat());
  const useRequirementLedgerGeneration =
    input.artifactType === "forbedret_kravsvar" &&
    shouldUseRequirementLedgerGeneration(requirementLedger);
  if (input.artifactType === "forbedret_kravsvar") {
    input.onProgress?.(
      useRequirementLedgerGeneration
        ? `[24%] Kravledger klar med ${requirementLedger.length} krav fra ${requirementDocuments.length} dokument(er).`
        : `[24%] Kravledger har lav tillit (${requirementLedger.length} krav). Bruker full dokumentgenerering.`,
    );
  }
  const requirementDocumentContext =
    input.artifactType === "forbedret_kravsvar" && !useRequirementLedgerGeneration
      ? requirementDocuments
          .slice(0, 3)
          .map((document, index) =>
            documentContext(`Kravdokument ${index + 1}`, document, {
              textLimit: 60000,
              structureLimit: 80,
              structureTextLimit: 320,
            }),
          )
          .join("\n\n")
      : "";
  const requirementContinuityContext =
    input.artifactType === "forbedret_kravsvar" && !useRequirementLedgerGeneration
      ? requirementDocuments
          .slice(0, 3)
          .map((document) => buildRequirementContinuityContext(document))
          .filter(Boolean)
          .join("\n\n")
      : "";
  const requirementSourceLedgerContext =
    input.artifactType === "forbedret_kravsvar" && !useRequirementLedgerGeneration
      ? requirementDocuments
          .slice(0, 3)
          .map((document, index) =>
            buildRequirementSourceLedgerContext(
              document,
              requirementLedgers[index] ?? [],
            ),
          )
          .filter(Boolean)
          .join("\n\n")
      : "";
  const requirementFileDocuments =
    input.artifactType === "forbedret_kravsvar" && !useRequirementLedgerGeneration
      ? (input.requirementDocuments?.length
          ? input.requirementDocuments
          : [
              input.customerDocument,
              input.solutionDocument,
              ...input.supportingDocuments,
            ])
          .filter(
            (document): document is ProjectDocumentDetail =>
              document !== null &&
              (Boolean(input.requirementDocuments?.length) ||
                isRequirementDocument(document)) &&
              ["pdf", "xlsx", "xls"].includes(document.file_format) &&
              Boolean(document.file_base64),
          )
          .slice(0, 3)
      : [];
  const continuationPages = buildContinuationPageMap(requirementDocuments);
  const pageEvidence = buildRequirementPageEvidence(requirementDocuments);
  const alignmentRequirementLedger = isReliableRequirementLedger(requirementLedger)
    ? requirementLedger
    : [];
  const bilag1SourceContext =
    input.artifactType === "bilag1_rekonstruksjon"
      ? [
          input.customerDocument,
          input.solutionDocument,
          ...input.supportingDocuments,
        ]
          .filter(
            (document): document is ProjectDocumentDetail =>
              document !== null && Boolean(document.raw_text.trim()),
          )
          .slice(0, 8)
          .map((document, index) =>
            documentContext(`Bilag 1-kilde ${index + 1}`, document, {
              textLimit: 9000,
              structureLimit: 18,
              structureTextLimit: 260,
            }),
          )
          .join("\n\n")
      : "";

  const artifactKnowledgeSource =
    input.artifactType === "gjennomforing_og_risiko"
      ? input.knowledgeArtifacts.filter(
          (artifact) => artifact.artifact_type !== "gjennomforing_og_risiko",
        )
      : input.artifactType === "forbedret_kravsvar"
        ? input.knowledgeArtifacts.filter(
            (artifact) => artifact.artifact_type !== "forbedret_kravsvar",
          )
      : input.knowledgeArtifacts;
  const artifactKnowledge = artifactKnowledgeSource
    .slice(0, input.artifactType === "gjennomforing_og_risiko" ? 2 : 4)
    .map((artifact, index) =>
      buildDelimitedContext(
        `Tidligere arbeidstekst ${index + 1}`,
        [
          `Tittel: ${artifact.title}`,
          `Type: ${artifact.artifact_type}`,
          input.artifactType === "gjennomforing_og_risiko"
            ? "Bruk kun som bakgrunn. Ikke kopier struktur, fasetitler eller formuleringer."
            : "",
          compactText(artifact.content_markdown, 2200),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    )
    .join("\n\n");

  if (useRequirementLedgerGeneration) {
    const requirementDocumentIds = new Set(
      requirementDocuments.map((document) => document.id),
    );
    const requirementAnswerSupportingDocuments = input.supportingDocuments.filter(
      (document) => !requirementDocumentIds.has(document.id),
    );
    const requirementAnswerSupportingContexts = requirementAnswerSupportingDocuments
      .slice(0, 5)
      .map((document, index) =>
        documentContext(`Støttedokument ${index + 1}`, document, {
          textLimit: 2200,
          structureLimit: 4,
          structureTextLimit: 140,
        }),
      )
      .join("\n\n");
    const requirementAnswerFoundationContext = [
      input.instructions
        ? buildDelimitedContext("Brukerbestilling", input.instructions)
        : "",
      input.documentLedgerContext
        ? buildDelimitedContext("Strukturert dokumentledger", input.documentLedgerContext)
        : "",
      buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
      buildDelimitedContext(
        "Kunnskapsregel",
        "Bruk prosjektgrunnlaget som kunnskapsbase for svarene, men kravlisten nedenfor er fasiten for hvilke krav som skal besvares. Ikke finn nye krav og ikke utelat krav fra listen.",
      ),
      serviceSummaryContext,
      serviceDescriptionContext
        ? buildDelimitedContext(
            "Regel for tjenestebeskrivelse",
            "Bruk bare relevante deler av tjenestebeskrivelsene, og knytt dem konkret til kravet. Ikke list alt firmaet tilbyr ukritisk.",
          )
        : "",
      serviceDescriptionContext,
      input.customerAnalysis
        ? buildDelimitedContext(
            "Kundeanalyse",
            summarizeCustomerAnalysis(input.customerAnalysis),
          )
        : "",
      input.solutionEvaluation
        ? buildDelimitedContext(
            "Løsningsvurdering",
            summarizeSolutionEvaluation(input.solutionEvaluation),
          )
        : "",
      input.customerDocument
        ? buildDelimitedContext(
            "Primært kundedokument sammendrag",
            compactText(input.customerDocument.raw_text, 2600),
          )
        : "",
      input.solutionDocument
        ? buildDelimitedContext(
            "Primært løsningsdokument sammendrag",
            compactText(input.solutionDocument.raw_text, 2600),
          )
        : "",
      requirementAnswerSupportingContexts,
      artifactKnowledge,
    ]
      .filter(Boolean)
      .join("\n\n");

    return generateRequirementResponseFromLedger({
      projectName: input.projectName,
      baseContext: requirementAnswerFoundationContext,
      ledger: requirementLedger,
      supportingDocuments: requirementAnswerSupportingDocuments,
      serviceDocuments,
      model: input.model,
      onProgress: input.onProgress,
    });
  }

  const userPrompt = [
    "Generer artefakten som gyldig JSON med feltene title og content_markdown.",
    input.instructions
      ? buildDelimitedContext("Brukerbestilling", input.instructions)
      : "",
    input.documentLedgerContext
      ? buildDelimitedContext("Strukturert dokumentledger", input.documentLedgerContext)
      : "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    buildDelimitedContext(
      "Kunnskapsregel",
      input.artifactType === "gjennomforing_og_risiko"
        ? "Bruk prosjektgrunnlaget som kunnskapsbase, men prioriter kundedokument, lagret kundeanalyse, dokumenterte risikoer, krav, avhengigheter og evalueringskriterier over tidligere arbeidstekster. Tidligere arbeidstekster er kun bakgrunn og skal ikke styre faseinndeling eller formuleringer."
        : "Bruk hele prosjektgrunnlaget som kunnskapsbase: kundedokument, løsningsdokument, støttedokumenter, strategi- og notatdokumenter, tjenestebeskrivelse, lagret analyse og tidligere arbeidstekster. Prioriter det mest oppdaterte og mest konkrete innholdet hvis kilder overlapper.",
    ),
    input.artifactType === "bilag1_rekonstruksjon"
      ? buildDelimitedContext(
          "Bilag 1-regel",
          "Rekonstruer kundens behovsgrunnlag fra kundens egne kilder. Ikke bland inn leverandørens tilbud som fakta om kunden. Bruk kildeindikasjoner fra dokumenttitler, strukturkart, sidemarkører og ark/rad-referanser når de finnes.",
        )
      : "",
    serviceDescriptionContext
      ? buildDelimitedContext(
          "Regel for tjenestebeskrivelse",
          "Tjenestesammendragene viser tjenestedokumenter som er huket av for dette prosjektet. Detaljert tjenestekontekst er bare hentet for dokumenter som ser mest relevante ut. Når du lager kravsvar, systemløsning eller løsningsbeskrivelse, skal du aktivt vurdere hvilke tjenester, leveranseområder, metoder og kapabiliteter som er relevante for kundens behov. Bruk bare relevante deler, og knytt dem konkret til kundens situasjon. Ikke list alt firmaet tilbyr ukritisk.",
        )
      : "",
    serviceSummaryContext,
    serviceDescriptionContext,
    requirementSourceLedgerContext,
    requirementContinuityContext,
    requirementDocumentContext,
    bilag1SourceContext,
    input.customerAnalysis
      ? buildDelimitedContext(
          "Kundeanalyse",
          summarizeCustomerAnalysis(input.customerAnalysis),
        )
      : "",
    input.solutionEvaluation
      ? buildDelimitedContext(
          "Løsningsvurdering",
          summarizeSolutionEvaluation(input.solutionEvaluation),
        )
      : "",
    input.customerDocument
      ? buildDelimitedContext(
          "Primært kundedokument sammendrag",
          compactText(input.customerDocument.raw_text, 5000),
        )
      : "",
    customerDocumentDigest ?? "",
    input.solutionDocument
      ? buildDelimitedContext(
          "Primært løsningsdokument sammendrag",
          compactText(input.solutionDocument.raw_text, 5000),
        )
      : "",
    solutionDocumentDigest ?? "",
    supportingContexts,
    artifactKnowledge,
  ]
    .filter(Boolean)
    .join("\n\n");

  const completionInput = {
    system: buildGeneratorPrompt(input.artifactType),
    user: userPrompt,
    temperature: input.artifactType === "forbedret_kravsvar" ? 0.12 : 0.25,
    model:
      input.model ??
      (input.artifactType === "forbedret_kravsvar" ||
      input.artifactType === "bilag1_rekonstruksjon"
        ? ANALYSIS_MODEL
        : FAST_MODEL),
    reasoningEffort:
      input.artifactType === "forbedret_kravsvar" ||
      input.artifactType === "bilag1_rekonstruksjon"
        ? ANALYSIS_REASONING_EFFORT
        : FAST_REASONING_EFFORT,
  };

  if (
    input.artifactType === "forbedret_kravsvar" &&
    requirementFileDocuments.length
  ) {
    const generated = await createJsonCompletionWithFileInputs<{
      title: string;
      content_markdown: string;
    }>({
      ...completionInput,
      user: [
        "Kravdokument-originalene er lagt ved som filinput. Bruk både maskinlesbar tekst og filstrukturen for krav i tabeller, regneark, bilder, figurer og diagrammer.",
        userPrompt,
      ].join("\n\n"),
      fileDocuments: requirementFileDocuments,
    });

    return {
      ...generated,
      content_markdown: alignRequirementRowsWithLedger(
        mergeContinuationRowsInRequirementTable(
          generated.content_markdown,
          continuationPages,
          pageEvidence,
        ),
        alignmentRequirementLedger,
      ),
    };
  }

  const generated = await createJsonCompletion<{
    title: string;
    content_markdown: string;
  }>(
    completionInput,
  );

  if (input.artifactType !== "forbedret_kravsvar") {
    return generated;
  }

  return {
    ...generated,
    content_markdown: alignRequirementRowsWithLedger(
      mergeContinuationRowsInRequirementTable(
        generated.content_markdown,
        continuationPages,
        pageEvidence,
      ),
      alignmentRequirementLedger,
    ),
  };
}

export async function synthesizeAndEvaluateSolution(input: {
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  customerAnalysis: CustomerAnalysisResult;
  model?: string;
  documentLedgerContext?: string;
}) {
  const supportingContexts = input.supportingDocuments
    .slice(0, 2)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 3000,
        structureLimit: 4,
        structureTextLimit: 140,
      }),
    )
    .join("\n\n");

  const userPrompt = [
    "Det finnes ikke noe opplastet primært løsningsdokument.",
    "Lag derfor først en kort, intern og kundespesifikk løsningsbeskrivelse som et tilbudsteam kan bruke som arbeidsgrunnlag.",
    "Evaluer deretter dette utkastet kritisk mot kundebehovene.",
    "Returner kun gyldig JSON.",
    "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    input.documentLedgerContext
      ? buildDelimitedContext(
          "Krav-til-løsning-matrise",
          "Bruk ledgeren til å bygge intern matrise fra krav til løsningspunkt og forbehold. Ikke finn krav direkte fra råtekst når ledgeren har konkrete krav.\n\n" +
            input.documentLedgerContext,
        )
      : "",
    documentContext("Primært kundedokument", input.customerDocument, {
      textLimit: 7000,
      structureLimit: 8,
      structureTextLimit: 160,
    }),
    buildDelimitedContext(
      "Lagret kundeanalyse",
      summarizeCustomerAnalysis(input.customerAnalysis),
    ),
    supportingContexts,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await createJsonCompletion<{
    synthetic_solution: { title: string; content_markdown: string };
    evaluation: SolutionEvaluationResult;
  }>({
    system: buildSyntheticSolutionEvaluationPrompt(),
    user: userPrompt,
    temperature: 0.15,
    model: input.model ?? ANALYSIS_MODEL,
    reasoningEffort: ANALYSIS_REASONING_EFFORT,
  });

  return {
    ...result,
    evaluation: normalizeSolutionEvaluationResult(result.evaluation),
  };
}

export async function answerProjectChat(input: {
  projectName: string;
  customerAnalysis: CustomerAnalysisResult | null;
  solutionEvaluation: SolutionEvaluationResult | null;
  generatedArtifacts?: GeneratedArtifact[];
  recentMessages: ChatMessage[];
  customerDocument: ProjectDocumentDetail | null;
  solutionDocument: ProjectDocumentDetail | null;
  supportingDocuments?: ProjectDocumentDetail[];
  question: string;
  model?: string;
}) {
  const history = input.recentMessages
    .slice(-8)
    .map(
      (message) =>
        `${message.role === "user" ? "Bruker" : "Assistent"}: ${message.content}`,
    )
    .join("\n");
  const supportingDocuments = (input.supportingDocuments ?? [])
    .slice(0, 4)
    .map((document, index) =>
      buildDelimitedContext(
        `Støttedokument ${index + 1}: ${document.title}`,
        compactText(document.raw_text, 3500),
      ),
    );
  const generatedArtifacts = (input.generatedArtifacts ?? [])
    .slice(0, 5)
    .map((artifact, index) =>
      buildDelimitedContext(
        `Generert artefakt ${index + 1}: ${artifact.title}`,
        compactText(artifact.content_markdown, 3500),
      ),
    );

  const userPrompt = [
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    input.customerAnalysis
      ? buildDelimitedContext(
          "Kundeanalyse",
          JSON.stringify(
            stripCustomerAnalysisHistory(input.customerAnalysis),
            null,
            2,
          ),
        )
      : "",
    input.solutionEvaluation
      ? buildDelimitedContext(
          "Løsningsvurdering",
          JSON.stringify(input.solutionEvaluation, null, 2),
        )
      : "",
    input.customerDocument
      ? buildDelimitedContext(
          "Kundedokument",
          compactText(input.customerDocument.raw_text, 9000),
        )
      : "",
    input.solutionDocument
      ? buildDelimitedContext(
          "Løsningsdokument",
          compactText(input.solutionDocument.raw_text, 9000),
        )
      : "",
    ...supportingDocuments,
    ...generatedArtifacts,
    history ? buildDelimitedContext("Samtalehistorikk", history) : "",
    buildDelimitedContext("Nytt spørsmål", input.question),
  ]
    .filter(Boolean)
    .join("\n\n");

  return createTextCompletion({
    system: buildChatPrompt(),
    user: userPrompt,
    temperature: 0.35,
    model: input.model ?? FAST_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
  });
}

export async function inferProjectMetadataFromCustomerDocument(input: {
  fileName: string;
  title: string;
  rawText: string;
}): Promise<ProjectMetadataInference> {
  const userPrompt = [
    "Analyser dokumentet som Bilag 1 / primært kundedokument og returner kun gyldig JSON.",
    "Feltene skal være korte og direkte brukbare i prosjektoversikten.",
    buildDelimitedContext(
      "Dokumentmetadata",
      [`Tittel: ${input.title}`, `Filnavn: ${input.fileName}`].join("\n"),
    ),
    buildDelimitedContext("Dokumenttekst", compactText(input.rawText, 18000)),
  ].join("\n\n");

  const result = await createJsonCompletion<ProjectMetadataInference>({
    system: buildProjectMetadataPrompt(),
    user: userPrompt,
    temperature: 0.1,
    model: FAST_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
  });

  return {
    name:
      typeof result.name === "string" && result.name.trim()
        ? result.name.trim()
        : null,
    customer_name:
      typeof result.customer_name === "string" && result.customer_name.trim()
        ? result.customer_name.trim()
        : null,
    industry:
      typeof result.industry === "string" && result.industry.trim()
        ? result.industry.trim()
        : null,
    description:
      typeof result.description === "string" && result.description.trim()
        ? result.description.trim()
        : null,
  };
}
