import "server-only";

import {
  buildChatPrompt,
  buildCustomerAnalysisPrompt,
  buildDelimitedContext,
  buildGeneratorPrompt,
  buildHighLevelDesignPrompt,
  buildProjectMetadataPrompt,
  buildSyntheticSolutionEvaluationPrompt,
  buildSolutionEvaluationPrompt,
} from "@/lib/server/prompts";
import type {
  ChatMessage,
  CustomerAnalysisResult,
  GeneratedArtifactType,
  ProjectMetadataInference,
  ProjectDocumentDetail,
  SolutionEvaluationResult,
  ValueOpportunity,
} from "@/lib/types";

const ANALYSIS_MODEL = "gpt-5.4";
const FAST_MODEL = "gpt-5.4-mini";

type OpenAIClient = {
  chat: {
    completions: {
      create: (input: Record<string, unknown>) => Promise<{
        choices: Array<{ message?: { content?: string | null } | null }>;
      }>;
    };
  };
};

let cachedClientPromise: Promise<OpenAIClient> | null = null;

async function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  if (!cachedClientPromise) {
    cachedClientPromise = import("openai").then(
      ({ default: OpenAI }) => new OpenAI({ apiKey }) as unknown as OpenAIClient,
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
    .map((section) => `- ${section.reference}: ${compactText(section.text, structureTextLimit)}`)
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
    buildDelimitedContext(`${label} struktur`, structurePreview || "Ingen struktur tilgjengelig."),
    buildDelimitedContext(`${label} tekst`, compactText(document.raw_text, options?.textLimit ?? 22000)),
  ].join("\n\n");
}

function summarizeCustomerAnalysis(analysis: CustomerAnalysisResult) {
  return JSON.stringify(
    {
      customer_profile_summary: compactText(analysis.customer_profile_summary, 500),
      customer_goals_summary: compactText(analysis.customer_goals_summary, 500),
      high_level_solution_design: compactText(analysis.high_level_solution_design, 700),
      high_level_architecture_mermaid: compactText(
        analysis.high_level_architecture_mermaid,
        1000,
      ),
      customer_profile: analysis.customer_profile.slice(0, 5),
      customer_goals: analysis.customer_goals.slice(0, 5),
      implicit_requirements: analysis.implicit_requirements.slice(0, 6).map((item) => ({
        title: item.title,
        category: item.category,
        importance: item.importance,
        description: compactText(item.description, 220),
      })),
      risks: analysis.risks.slice(0, 5),
      likely_evaluation_criteria: analysis.likely_evaluation_criteria.slice(0, 5),
      expected_solution_direction: analysis.expected_solution_direction.slice(0, 5),
      value_opportunities: analysis.value_opportunities.slice(0, 5),
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
      improvement_recommendations: evaluation.improvement_recommendations.slice(0, 5),
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
    return !references.some((reference) => isNearDuplicate(sentence, reference, 0.76));
  });

  const normalized = (kept.length ? kept : sentences).join(" ").replace(/\s+/g, " ").trim();
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
  return capNormalizedList(items.filter((item) => {
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
  }));
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
  const subgraphCount = lines.filter((line) => /^subgraph\b/i.test(line)).length;
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
  const hasNamedIntegration = includesSignal(signals, /\bid-?porten\b|noark|api/i);
  const hasNamedData = includesSignal(signals, /\bpower bi\b|data|database/i);
  const hasNamedOps = includesSignal(signals, /\bci\/?cd\b|monitor|logging|backup/i);

  return [
    "flowchart LR",
    '  subgraph Business["Brukere og forretning"]',
    '    Users[Forretningsbrukere og fagmiljø]',
    '    Apps[Applikasjoner og arbeidsflater]',
    "  end",
    '  subgraph Identity["Identitet"]',
    hasMicrosoftIdentity
      ? "    Identity[Microsoft Entra ID]"
      : "    Identity[Identitet og tilgang]",
    "  end",
    '  subgraph PlatformLayer["Plattform"]',
    hasAzure ? "    Platform[Azure Landing Zone]" : "    Platform[Skyplattform]",
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

function normalizeRequirementList(requirements: CustomerAnalysisResult["implicit_requirements"]) {
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
      source_reference: requirement.source_reference.replace(/\s+/g, " ").trim(),
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

function normalizeValueOpportunities(
  items: ValueOpportunity[],
): ValueOpportunity[] {
  const filtered = (Array.isArray(items) ? items : [])
    .filter((item) => item && item.title && item.description)
    .filter((item, index, array) => {
      return !array.some(
        (existing, existingIndex) =>
          existingIndex < index &&
          isNearDuplicate(existing.title, item.title, 0.8) &&
          isNearDuplicate(existing.description, item.description, 0.72),
      );
    })
    .slice(0, 10)
    .map((item) => ({
      title: item.title.replace(/\s+/g, " ").trim(),
      description: item.description.replace(/\s+/g, " ").trim(),
      value_categories: Array.isArray(item.value_categories)
        ? item.value_categories.filter((value) =>
            [
              "Høyere produktivitet",
              "Lavere kostnader",
              "Redusert risiko",
              "Bedre brukeropplevelse",
            ].includes(value),
          )
        : [],
      profit_share_percent: normalizePercentShare(
        (item as ValueOpportunity & { profit_share_percent?: unknown })
          .profit_share_percent,
      ) ?? 0,
    }));

  if (!filtered.length) {
    return [];
  }

  const providedTotal = filtered.reduce(
    (sum, item) => sum + (item.profit_share_percent || 0),
    0,
  );

  const normalizedPercents =
    providedTotal > 0
      ? filtered.map((item) =>
          Math.max(1, Math.round((item.profit_share_percent / providedTotal) * 100)),
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

function normalizeCustomerAnalysisResult(result: CustomerAnalysisResult): CustomerAnalysisResult {
  const customerProfile = capNormalizedList(
    Array.isArray(result.customer_profile) ? result.customer_profile : [],
  );
  const customerGoals = capNormalizedList(Array.isArray(result.customer_goals) ? result.customer_goals : []);
  const risks = capNormalizedList(Array.isArray(result.risks) ? result.risks : []);
  const likelyEvaluationCriteria = capNormalizedList(
    Array.isArray(result.likely_evaluation_criteria) ? result.likely_evaluation_criteria : [],
  );
  const signalWords = normalizeSignalWords(Array.isArray(result.signal_words) ? result.signal_words : []);
  const expectedSolutionDirection = capNormalizedList(
    Array.isArray(result.expected_solution_direction) ? result.expected_solution_direction : [],
  );
  const positioningRecommendations = capNormalizedList(
    Array.isArray(result.positioning_recommendations) ? result.positioning_recommendations : [],
  );
  const ambiguities = capNormalizedList(Array.isArray(result.ambiguities) ? result.ambiguities : []);
  const prioritizedRequirements = (Array.isArray(result.prioritized_requirements)
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
    [...customerGoals, result.customer_goals_summary || "", ...positioningRecommendations],
  );

  const customerGoalsSummary = dedupeSummary(
    result.customer_goals_summary || customerGoals.slice(0, 2).join(" "),
    [customerProfileSummary, ...customerProfile, ...positioningRecommendations],
  );

  const highLevelSolutionDesign = dedupeSummary(
    result.high_level_solution_design || expectedSolutionDirection.slice(0, 2).join(" "),
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

  const executiveSummary = dedupeSummary(
    result.executive_summary || "",
    [
      customerProfileSummary,
      customerGoalsSummary,
      highLevelSolutionDesign,
      ...customerProfile,
      ...customerGoals,
      ...risks,
      ...positioningRecommendations,
    ],
  );

  return {
    ...result,
    customer_profile_summary: customerProfileSummary,
    customer_goals_summary: customerGoalsSummary,
    high_level_solution_design: highLevelSolutionDesign,
    high_level_architecture_mermaid: highLevelArchitectureMermaid,
    customer_profile: customerProfile,
    customer_goals: customerGoals,
    implicit_requirements: normalizeRequirementList(
      Array.isArray(result.implicit_requirements) ? result.implicit_requirements : [],
    ),
    prioritized_requirements: prioritizedRequirements,
    ambiguities,
    risks,
    likely_evaluation_criteria: likelyEvaluationCriteria,
    signal_words: signalWords,
    expected_solution_direction: expectedSolutionDirection,
    value_opportunities: valueOpportunities,
    positioning_recommendations: positioningRecommendations,
    executive_summary: executiveSummary,
  };
}

function normalizeSolutionEvaluationResult(result: SolutionEvaluationResult): SolutionEvaluationResult {
  const strengths = capNormalizedList(Array.isArray(result.strengths) ? result.strengths : []);
  const weaknesses = capNormalizedList(Array.isArray(result.weaknesses) ? result.weaknesses : []);
  const genericSections = capNormalizedList(
    Array.isArray(result.generic_sections) ? result.generic_sections : [],
  );
  const missingElements = capNormalizedList(
    Array.isArray(result.missing_elements) ? result.missing_elements : [],
  );
  const risksToCustomer = capNormalizedList(
    Array.isArray(result.risks_to_customer) ? result.risks_to_customer : [],
  );
  const trustSignals = capNormalizedList(Array.isArray(result.trust_signals) ? result.trust_signals : []);
  const improvementRecommendations = capNormalizedList(
    Array.isArray(result.improvement_recommendations) ? result.improvement_recommendations : [],
  );
  const valueAssessment = normalizeValueOpportunities(
    Array.isArray(result.value_assessment) ? result.value_assessment : [],
  );

  return {
    ...result,
    fit_to_customer_needs: (result.fit_to_customer_needs || "").replace(/\s+/g, " ").trim(),
    strengths,
    weaknesses,
    generic_sections: genericSections,
    missing_elements: missingElements,
    risks_to_customer: risksToCustomer,
    trust_signals: trustSignals,
    improvement_recommendations: improvementRecommendations,
    value_assessment: valueAssessment,
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
    "Alle verdiutsagn må knyttes til minst én av de fem faste verdikategoriene.",
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
    supportingContexts ? buildDelimitedContext("Tilleggsregel", "Bruk støttedokumentene bare som støtte og kontekst. Ikke la dem overstyre primært kundedokument.") : "",
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

  return normalizeCustomerAnalysisResult(result);
}

export async function generateHighLevelDesign(input: {
  projectName: string;
  customerDocument: ProjectDocumentDetail;
  supportingDocuments: ProjectDocumentDetail[];
  customerAnalysis: CustomerAnalysisResult;
}) {
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
    buildDelimitedContext(
      "Eksisterende kundeanalyse",
      summarizeCustomerAnalysis(input.customerAnalysis),
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
      input.customerAnalysis.customer_profile_summary,
      input.customerAnalysis.customer_goals_summary,
      ...input.customerAnalysis.positioning_recommendations,
      input.customerAnalysis.executive_summary,
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
}) {
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
    "Vurder løsningsdokumentet opp mot kundedokumentet og den eksisterende kundeanalysen.",
    "Returner kun gyldig JSON.",
    "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    documentContext("Primært kundedokument", input.customerDocument, {
      textLimit: 7000,
      structureLimit: 8,
      structureTextLimit: 160,
    }),
    buildDelimitedContext("Lagret kundeanalyse", summarizeCustomerAnalysis(input.customerAnalysis)),
    documentContext("Primært løsningsdokument", input.solutionDocument, {
      textLimit: 7000,
      structureLimit: 8,
      structureTextLimit: 160,
    }),
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
    input.instructions ? buildDelimitedContext("Brukerbestilling", input.instructions) : "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    buildDelimitedContext(
      "Kunnskapsregel",
      "Bruk hele prosjektgrunnlaget som kunnskapsbase: kundedokument, løsningsdokument, støttedokumenter, strategi- og notatdokumenter, lagret analyse og tidligere arbeidstekster. Prioriter det mest oppdaterte og mest konkrete innholdet hvis kilder overlapper.",
    ),
    input.customerAnalysis
      ? buildDelimitedContext("Kundeanalyse", summarizeCustomerAnalysis(input.customerAnalysis))
      : "",
    input.solutionEvaluation
      ? buildDelimitedContext("Løsningsvurdering", summarizeSolutionEvaluation(input.solutionEvaluation))
      : "",
    input.customerDocument ? buildDelimitedContext("Primært kundedokument sammendrag", compactText(input.customerDocument.raw_text, 5000)) : "",
    input.solutionDocument ? buildDelimitedContext("Primært løsningsdokument sammendrag", compactText(input.solutionDocument.raw_text, 5000)) : "",
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
    buildDelimitedContext("Lagret kundeanalyse", summarizeCustomerAnalysis(input.customerAnalysis)),
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
    .map((message) => `${message.role === "user" ? "Bruker" : "Assistent"}: ${message.content}`)
    .join("\n");

  const userPrompt = [
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    input.customerAnalysis
      ? buildDelimitedContext("Kundeanalyse", JSON.stringify(input.customerAnalysis, null, 2))
      : "",
    input.solutionEvaluation
      ? buildDelimitedContext("Løsningsvurdering", JSON.stringify(input.solutionEvaluation, null, 2))
      : "",
    input.customerDocument ? buildDelimitedContext("Kundedokument", compactText(input.customerDocument.raw_text, 9000)) : "",
    input.solutionDocument ? buildDelimitedContext("Løsningsdokument", compactText(input.solutionDocument.raw_text, 9000)) : "",
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
    name: typeof result.name === "string" && result.name.trim() ? result.name.trim() : null,
    customer_name:
      typeof result.customer_name === "string" && result.customer_name.trim()
        ? result.customer_name.trim()
        : null,
    industry: typeof result.industry === "string" && result.industry.trim() ? result.industry.trim() : null,
    description:
      typeof result.description === "string" && result.description.trim()
        ? result.description.trim()
        : null,
  };
}
