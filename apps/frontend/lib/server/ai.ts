import "server-only";

import {
  buildChatPrompt,
  buildCustomerAnalysisPrompt,
  buildDelimitedContext,
  buildGeneratorPrompt,
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

function compactText(value: string, limit = 16000) {
  const normalized = value.replace(/\s+/g, " ").trim();
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
      customer_goals: analysis.customer_goals.slice(0, 6),
      explicit_requirements: analysis.explicit_requirements.slice(0, 8).map((item) => ({
        title: item.title,
        category: item.category,
        importance: item.importance,
        description: compactText(item.description, 220),
      })),
      implicit_requirements: analysis.implicit_requirements.slice(0, 6).map((item) => ({
        title: item.title,
        category: item.category,
        importance: item.importance,
        description: compactText(item.description, 220),
      })),
      risks: analysis.risks.slice(0, 6),
      likely_evaluation_criteria: analysis.likely_evaluation_criteria.slice(0, 6),
      expected_solution_direction: analysis.expected_solution_direction.slice(0, 6),
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
      strengths: evaluation.strengths.slice(0, 6),
      weaknesses: evaluation.weaknesses.slice(0, 6),
      missing_elements: evaluation.missing_elements.slice(0, 6),
      risks_to_customer: evaluation.risks_to_customer.slice(0, 6),
      improvement_recommendations: evaluation.improvement_recommendations.slice(0, 6),
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

  return createJsonCompletion<CustomerAnalysisResult>({
    system: buildCustomerAnalysisPrompt(),
    user: userPrompt,
    temperature: 0.1,
    model: ANALYSIS_MODEL,
  });
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

  return createJsonCompletion<SolutionEvaluationResult>({
    system: buildSolutionEvaluationPrompt(),
    user: userPrompt,
    temperature: 0.1,
    model: FAST_MODEL,
  });
}

export async function generateProjectArtifact(input: {
  artifactType: GeneratedArtifactType;
  projectName: string;
  customerAnalysis: CustomerAnalysisResult | null;
  solutionEvaluation: SolutionEvaluationResult | null;
  customerDocument: ProjectDocumentDetail | null;
  solutionDocument: ProjectDocumentDetail | null;
  instructions?: string;
}) {
  const userPrompt = [
    "Generer artefakten som gyldig JSON med feltene title og content_markdown.",
    input.instructions ? buildDelimitedContext("Brukerbestilling", input.instructions) : "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    input.customerAnalysis
      ? buildDelimitedContext("Kundeanalyse", summarizeCustomerAnalysis(input.customerAnalysis))
      : "",
    input.solutionEvaluation
      ? buildDelimitedContext("Løsningsvurdering", summarizeSolutionEvaluation(input.solutionEvaluation))
      : "",
    input.customerDocument ? buildDelimitedContext("Primært kundedokument sammendrag", compactText(input.customerDocument.raw_text, 5000)) : "",
    input.solutionDocument ? buildDelimitedContext("Primært løsningsdokument sammendrag", compactText(input.solutionDocument.raw_text, 5000)) : "",
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

  return createJsonCompletion<{
    synthetic_solution: { title: string; content_markdown: string };
    evaluation: SolutionEvaluationResult;
  }>({
    system: buildSyntheticSolutionEvaluationPrompt(),
    user: userPrompt,
    temperature: 0.15,
    model: FAST_MODEL,
  });
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
