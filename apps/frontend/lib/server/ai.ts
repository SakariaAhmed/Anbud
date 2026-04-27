import "server-only";

import { stripCustomerAnalysisHistory } from "@/lib/customer-analysis-history";
import {
  buildChatPrompt,
  buildCustomerAnalysisPrompt,
  buildDelimitedContext,
  buildGeneratorPrompt,
  buildHighLevelDesignPrompt,
  buildPromptTemplate,
  buildProjectMetadataPrompt,
  buildSyntheticSolutionEvaluationPrompt,
  buildSolutionEvaluationPrompt,
} from "@/lib/server/prompts";
import type {
  ChatMessage,
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  GeneratedArtifactType,
  ProjectMetadataInference,
  ProjectDocumentDetail,
  SolutionEvaluationResult,
  ValueCategory,
  ValueOpportunity,
} from "@/lib/types";

const ANALYSIS_MODEL = "gpt-5.4";
const FAST_MODEL = "gpt-5.4-mini";
const VALUE_CATEGORIES: ValueCategory[] = [
  "Høyere produktivitet",
  "Lavere kostnader",
  "Redusert risiko",
  "Bedre brukeropplevelse",
];

type OpenAIClient = {
  chat: {
    completions: {
      create: (input: Record<string, unknown>) => Promise<{
        choices: Array<{ message?: { content?: string | null } | null }>;
      }>;
    };
  };
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

let cachedClientPromise: Promise<OpenAIClient> | null = null;

declare global {
  // eslint-disable-next-line no-var
  var __anbudDocumentInsightCache: DocumentInsightCache | undefined;
}

const LARGE_DOCUMENT_ANALYSIS_THRESHOLD = 18000;
const CHUNK_TEXT_LIMIT = 6500;
const MAX_DOCUMENT_CHUNKS = 8;
const CHUNK_CONCURRENCY = 3;

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
      '{"document_summary":"Delen beskriver krav til sikker migrering og lav toleranse for driftsavbrudd.","important_requirements":["Kunden krever kontrollert overgang uten vesentlig driftsavbrudd."],"implicit_needs":["Leverandøren må fremstå som trygg gjennomføringspartner, ikke bare teknisk rådgiver."],"risks":["Utydelig cutover-plan kan svekke tillit."],"evaluation_criteria":["Gjennomføringsevne","Sikkerhet"],"architecture_and_solution_signals":["Hybrid overgang mellom lokal drift og skyplattform."],"technologies_and_standards":["Azure","MFA"],"value_signals":["Redusert risiko gjennom stegvis migrering."],"visual_or_table_notes":["Teksten viser til en migreringstabell som bør verifiseres."],"source_references":["Kundedokument – side 12"]}',
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

const VAGUE_SIGNAL_WORDS = new Set([
  "moderne",
  "skybasert",
  "erstatte eksisterende systemer",
  "effektivitet",
  "bedre datakvalitet",
  "forbedret brukeropplevelse",
  "bedre brukeropplevelse",
  "smidig",
  "mvp",
  "robust drift",
  "skalerbar",
  "kontinuerlig videreutvikling",
]);

const SIGNAL_WORD_PATTERNS = [
  /\bazure\b/i,
  /\bgdpr\b/i,
  /\bnoark\b/i,
  /\bwcag\b/i,
  /\bid-?porten\b/i,
  /\bpower bi\b/i,
  /\bci\/?cd\b/i,
  /\bssa-d\b/i,
  /\bcontainer/i,
  /\bmikrotjen/i,
  /\bmodulær arkitektur\b/i,
  /\båpne standarder\b/i,
  /\bsky-native\b/i,
  /\brolle- og rettighetsstyring\b/i,
  /\barkivkrav\b/i,
  /\bapi\b/i,
  /\boauth\b/i,
  /\bsaml\b/i,
  /\bterraform\b/i,
  /\bkubernetes\b/i,
  /\bentra\b/i,
];

function normalizeSignalWords(items: string[]) {
  return capNormalizedList(
    items.filter((item) => {
      const trimmed = item.replace(/\s+/g, " ").trim();
      if (!trimmed) {
        return false;
      }

      const normalized = normalizeComparableText(trimmed);
      if (!normalized || VAGUE_SIGNAL_WORDS.has(normalized)) {
        return false;
      }

      if (SIGNAL_WORD_PATTERNS.some((pattern) => pattern.test(trimmed))) {
        return true;
      }

      return /[A-Z]{2,}|\d/.test(trimmed);
    }),
  );
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
    hasAzure
      ? "    Platform[Azure Landing Zone]"
      : "    Platform[Skyplattform]",
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
      "Regenerer kun lederoppsummeringen av kunden.",
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
      "Regenerer kun tilbudsteamets operative strategi og anbefalte posisjonering.",
      "executive_summary skal være arbeidsteksten som brukes videre i tilbudet.",
      "positioning_recommendations skal være konkrete anbefalinger til hvordan tilbudet bør spisses.",
    ],
    outputContract: [
      "Returner kun JSON med executive_summary og positioning_recommendations.",
      "positioning_recommendations skal være en liste med 3 til 5 konkrete tekstpunkter.",
    ],
  },
  design: {
    label: "Design",
    fields: "high_level_solution_design og high_level_architecture_mermaid",
    guidance: [
      "Regenerer kun anbefalt high-level design og arkitekturdiagram.",
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
      "Regenerer kun risiko og usikkerhet.",
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
      "Regenerer kun underliggende behov og implisitte krav.",
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
      "Regenerer kun gjenbrukte nøkkelord.",
      "signal_words skal bare inneholde konkrete teknologier, standarder, rammeverk, integrasjonspunkter, regulatoriske referanser eller navngitte signalord.",
      "Ikke inkluder generiske ord som moderne, effektivitet, brukeropplevelse, robust eller skalerbar.",
    ],
    outputContract: [
      "Returner kun JSON med signal_words.",
      "signal_words skal være en liste med maksimalt 10 konkrete tekststrenger.",
    ],
  },
  value: {
    label: "Verdi",
    fields: "value_opportunities",
    guidance: [
      "Regenerer kun verdimuligheter.",
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

function normalizeComparisonScore(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(raw)));
}

async function createJsonCompletion<T>(input: {
  system: string;
  user: string;
  temperature?: number;
  model?: string;
}): Promise<T> {
  const client = await getClient();
  const response = await client.chat.completions.create({
    model: input.model ?? ANALYSIS_MODEL,
    temperature: input.temperature ?? 0.1,
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

async function createTextCompletion(input: {
  system: string;
  user: string;
  temperature?: number;
  model?: string;
}) {
  const client = await getClient();
  const response = await client.chat.completions.create({
    model: input.model ?? ANALYSIS_MODEL,
    temperature: input.temperature ?? 0.3,
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
}) {
  const [customerDocumentDigest, supportingDocumentDigests] = await Promise.all([
    buildDocumentInsightDigest("Primært kundedokument", input.customerDocument),
    Promise.all(
      input.supportingDocuments.slice(0, 3).map((document, index) =>
        buildDocumentInsightDigest(`Støttedokument ${index + 1}`, document, {
          maxChunks: 4,
        }),
      ),
    ),
  ]);
  const supportingContexts = input.supportingDocuments
    .slice(0, 6)
    .map((document, index) =>
      documentContext(`Støttedokument ${index + 1}`, document, {
        textLimit: 8000,
        structureLimit: 8,
        structureTextLimit: 180,
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
      textLimit: 16000,
      structureLimit: 10,
      structureTextLimit: 180,
    }),
    customerDocumentDigest
      ? buildDelimitedContext(
          "Analyseinstruks for store dokumenter",
          "Bruk bred dokumentdekning aktivt. Den dekker flere sider/blokker enn hovedutdraget og skal hindre at krav, risiko, evalueringskriterier eller verdidrivere sent i dokumentet overses. Hvis dekningen varsler figurer, tabeller eller grafer, vær tydelig på hva som kan utledes fra teksten og hva som bør verifiseres.",
        )
      : "",
    customerDocumentDigest ?? "",
    supportingContexts
      ? buildDelimitedContext(
          "Tilleggsregel",
          "Bruk støttedokumentene bare som støtte og kontekst. Ikke la dem overstyre primært kundedokument.",
        )
      : "",
    ...supportingDocumentDigests.filter(Boolean),
    supportingContexts,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await createJsonCompletion<CustomerAnalysisResult>({
    system: buildCustomerAnalysisPrompt(),
    user: userPrompt,
    temperature: 0.1,
    model: ANALYSIS_MODEL,
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
    role: "Du er en senior løsningsarkitekt og tilbudsansvarlig som regenererer én avgrenset del av en eksisterende kundeanalyse uten å endre resten.",
    task: [
      `Regenerer seksjonen ${config.label}.`,
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
    `Regenerer bare ${config.label} for prosjektet.`,
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
    model: ANALYSIS_MODEL,
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
    model: FAST_MODEL,
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
    model: FAST_MODEL,
  });

  return normalizeSolutionEvaluationResult(result);
}

export async function generateProjectArtifact(input: {
  artifactType: GeneratedArtifactType;
  projectName: string;
  customerAnalysis: CustomerAnalysisResult | null;
  solutionEvaluation: SolutionEvaluationResult | null;
  customerDocument: ProjectDocumentDetail | null;
  solutionDocument: ProjectDocumentDetail | null;
  supportingDocuments: ProjectDocumentDetail[];
  knowledgeArtifacts: Array<{
    title: string;
    content_markdown: string;
    artifact_type: GeneratedArtifactType;
  }>;
  instructions?: string;
}) {
  const [customerDocumentDigest, solutionDocumentDigest] = await Promise.all([
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
  ]);
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

  const artifactKnowledge = input.knowledgeArtifacts
    .slice(0, 4)
    .map((artifact, index) =>
      buildDelimitedContext(
        `Tidligere arbeidstekst ${index + 1}`,
        [
          `Tittel: ${artifact.title}`,
          `Type: ${artifact.artifact_type}`,
          compactText(artifact.content_markdown, 2200),
        ].join("\n"),
      ),
    )
    .join("\n\n");

  const userPrompt = [
    "Generer artefakten som gyldig JSON med feltene title og content_markdown.",
    input.instructions
      ? buildDelimitedContext("Brukerbestilling", input.instructions)
      : "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    buildDelimitedContext(
      "Kunnskapsregel",
      "Bruk hele prosjektgrunnlaget som kunnskapsbase: kundedokument, løsningsdokument, støttedokumenter, strategi- og notatdokumenter, lagret analyse og tidligere arbeidstekster. Prioriter det mest oppdaterte og mest konkrete innholdet hvis kilder overlapper.",
    ),
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

  return createJsonCompletion<{ title: string; content_markdown: string }>({
    system: buildGeneratorPrompt(input.artifactType),
    user: userPrompt,
    temperature: 0.25,
    model: FAST_MODEL,
  });
}

export async function synthesizeAndEvaluateSolution(input: {
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  customerAnalysis: CustomerAnalysisResult;
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
    "Lag derfor først et kort, internt og kundespesifikt løsningsutkast som et tilbudsteam kan bruke som arbeidsgrunnlag.",
    "Evaluer deretter dette utkastet kritisk mot kundebehovene.",
    "Returner kun gyldig JSON.",
    "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
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
    model: FAST_MODEL,
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
  recentMessages: ChatMessage[];
  customerDocument: ProjectDocumentDetail | null;
  solutionDocument: ProjectDocumentDetail | null;
  question: string;
}) {
  const history = input.recentMessages
    .slice(-8)
    .map(
      (message) =>
        `${message.role === "user" ? "Bruker" : "Assistent"}: ${message.content}`,
    )
    .join("\n");

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
    history ? buildDelimitedContext("Samtalehistorikk", history) : "",
    buildDelimitedContext("Nytt spørsmål", input.question),
  ]
    .filter(Boolean)
    .join("\n\n");

  return createTextCompletion({
    system: buildChatPrompt(),
    user: userPrompt,
    temperature: 0.35,
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
    model: ANALYSIS_MODEL,
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
