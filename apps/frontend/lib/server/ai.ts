import "server-only";

import OpenAI from "openai";

import { getOpenAiApiKey, getOpenAiModel } from "@/lib/server/env";

export type ConfidenceLevel = "Low" | "Medium" | "High";

export interface IntakeSuggestion {
  customer_name: string;
  title: string;
  estimated_value: number | null;
  deadline: string | null;
  owner: string;
  custom_fields: Record<string, string>;
}

export interface ChatAnswer {
  answer: string;
  confidence: ConfidenceLevel;
  citations: Array<{ document_name: string | null; excerpt: string }>;
}

export interface RequirementSuggestion {
  title: string;
  detail: string;
  category: string;
  priority: "Low" | "Medium" | "High";
  source_excerpt: string;
  source_document: string | null;
}

let cachedClient: OpenAI | null | undefined;

function getClient(): OpenAI | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  const apiKey = getOpenAiApiKey();
  cachedClient = apiKey ? new OpenAI({ apiKey }) : null;
  return cachedClient;
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeConfidence(value: unknown): ConfidenceLevel {
  if (value === "High" || value === "Medium" || value === "Low") {
    return value;
  }
  return "Medium";
}

function normalizePriority(value: unknown): "Low" | "Medium" | "High" {
  if (value === "High" || value === "Medium" || value === "Low") {
    return value;
  }
  return "Medium";
}

function parseJsonLikeString(value: string): unknown {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function toReadableText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    const parsed = parseJsonLikeString(value);
    if (parsed !== value) {
      return toReadableText(parsed);
    }
    const trimmed = value.trim();
    if (trimmed === "[object Object]") {
      return "";
    }
    return trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => `- ${toReadableText(item)}`).join("\n").trim();
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const lines: string[] = [];
    for (const [rawKey, rawValue] of entries) {
      const key = rawKey.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
      if (Array.isArray(rawValue)) {
        lines.push(`${key}:`);
        for (const item of rawValue) {
          lines.push(`- ${toReadableText(item)}`);
        }
      } else if (typeof rawValue === "object" && rawValue !== null) {
        lines.push(`${key}:`);
        lines.push(toReadableText(rawValue));
      } else {
        lines.push(`${key}: ${toReadableText(rawValue)}`);
      }
      lines.push("");
    }
    return lines.join("\n").trim();
  }
  return String(value);
}

export async function extractIntakeFromDocument(rawText: string): Promise<IntakeSuggestion> {
  const text = rawText.trim();
  if (!text) {
    return {
      customer_name: "",
      title: "",
      estimated_value: null,
      deadline: null,
      owner: "",
      custom_fields: {}
    };
  }

  const client = getClient();
  if (!client) {
    return fallbackIntake(text);
  }

  try {
    const completion = await client.chat.completions.create({
      model: getOpenAiModel(),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Extract bid intake fields. Return strict JSON only." },
        {
          role: "user",
          content:
            "Extract and return JSON with keys: customer_name, title, estimated_value, deadline, owner, custom_fields. " +
            "deadline must be YYYY-MM-DD or null. estimated_value must be number or null. custom_fields must be object of short strings.\n\n" +
            `Document:\n${text.slice(0, 16000)}`
        }
      ]
    });

    const payload = safeJson<Partial<IntakeSuggestion>>(completion.choices[0]?.message?.content ?? "{}", {});
    return {
      customer_name: (payload.customer_name ?? "").toString(),
      title: (payload.title ?? "").toString(),
      estimated_value:
        payload.estimated_value === null || payload.estimated_value === undefined
          ? null
          : Number.isFinite(Number(payload.estimated_value))
            ? Number(payload.estimated_value)
            : null,
      deadline: typeof payload.deadline === "string" && payload.deadline ? payload.deadline : null,
      owner: (payload.owner ?? "").toString(),
      custom_fields: payload.custom_fields ?? {}
    };
  } catch {
    return fallbackIntake(text);
  }
}

export async function answerBidQuestion(params: {
  question: string;
  documents: Array<{ fileName: string; rawText: string }>;
  bidContext: Record<string, string>;
}): Promise<ChatAnswer> {
  const question = params.question.trim();
  if (!question) {
    return { answer: "Please enter a question.", confidence: "Low", citations: [] };
  }

  const contextSections: string[] = [];
  let totalChars = 0;
  for (let i = 0; i < params.documents.length; i += 1) {
    const snippet = params.documents[i].rawText.slice(0, 3500);
    if (totalChars + snippet.length > 22000) {
      break;
    }
    totalChars += snippet.length;
    contextSections.push(`Source file: ${params.documents[i].fileName}\n${snippet}`);
  }
  contextSections.push(`Bid metadata:\n${JSON.stringify(params.bidContext)}`);

  if (!params.documents.length) {
    return {
      answer: "No document context is available for this bid yet. Upload a requirement document first.",
      confidence: "Low",
      citations: []
    };
  }

  const client = getClient();
  if (!client) {
    return fallbackChat(question, params.documents);
  }

  try {
    const completion = await client.chat.completions.create({
      model: getOpenAiModel(),
      temperature: 0.15,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a senior bid advisor. Be practical, nuanced, and decision-oriented. " +
            "Write like a consultant and ground all claims in provided context. Return JSON only."
        },
        {
          role: "user",
          content:
            "Answer using only context. Use clear sections and actionable bullets when useful. " +
            "Return strict JSON with keys: answer, confidence, citations. " +
            "answer must be a plain text string, never an object or array. " +
            "confidence must be Low/Medium/High. " +
            "citations must be an array of objects with keys document_name and excerpt. " +
            "document_name should be the exact source file name when possible. excerpt should be a short supporting quote or passage.\n\n" +
            `Question:\n${question}\n\nContext:\n${contextSections.join("\n\n")}`
        }
      ]
    });

    const payload = safeJson<
      Partial<ChatAnswer> & { citations?: Array<{ document_name?: unknown; excerpt?: unknown }> }
    >(completion.choices[0]?.message?.content ?? "{}", {});
    const answerText = toReadableText(payload.answer);
    return {
      answer: answerText || "I could not derive a reliable answer from the provided context.",
      confidence: normalizeConfidence(payload.confidence),
      citations: Array.isArray(payload.citations)
        ? payload.citations
            .map((item) => ({
              document_name: toReadableText(item.document_name).slice(0, 160) || null,
              excerpt: toReadableText(item.excerpt).slice(0, 500)
            }))
            .filter((item) => item.excerpt)
        : []
    };
  } catch {
    return fallbackChat(question, params.documents);
  }
}

export async function extractBidRequirements(params: {
  documentTexts: string[];
  bidContext: Record<string, string>;
}): Promise<RequirementSuggestion[]> {
  const contextSections: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < params.documentTexts.length; i += 1) {
    const snippet = params.documentTexts[i].slice(0, 5000);
    if (totalChars + snippet.length > 26000) {
      break;
    }
    totalChars += snippet.length;
    contextSections.push(`Document ${i + 1}:\n${snippet}`);
  }

  if (!contextSections.length) {
    return [];
  }

  contextSections.push(`Bid metadata:\n${JSON.stringify(params.bidContext)}`);

  const client = getClient();
  if (!client) {
    return fallbackRequirements(contextSections);
  }

  try {
    const completion = await client.chat.completions.create({
      model: getOpenAiModel(),
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract tender requirements from uploaded bid documents. " +
            "Return strict JSON only. Keep requirement titles short and concrete. " +
            "Titles should summarize the requirement, not copy full paragraphs. " +
            "detail and source_excerpt must always be plain text strings. " +
            "If a source file name is present in the context, source_document must use that exact file name."
        },
        {
          role: "user",
          content:
            "Review all provided document context and extract the concrete requirements the bid team must respond to. " +
            "Return strict JSON with a single key requirements. requirements must be an array of objects with keys: " +
            "title, detail, category, priority, source_excerpt, source_document. " +
            "priority must be Low, Medium, or High. source_document should be the actual source file name when available, otherwise null.\n\n" +
            `Context:\n${contextSections.join("\n\n")}`
        }
      ]
    });

    const payload = safeJson<{ requirements?: Array<Partial<RequirementSuggestion>> }>(
      completion.choices[0]?.message?.content ?? "{}",
      {}
    );

    const requirements = Array.isArray(payload.requirements) ? payload.requirements : [];
    return requirements
      .map((item) => ({
        title: toReadableText(item.title).slice(0, 160),
        detail: toReadableText(item.detail).slice(0, 2000),
        category: toReadableText(item.category).slice(0, 120) || "General",
        priority: normalizePriority(item.priority),
        source_excerpt: toReadableText(item.source_excerpt).slice(0, 800),
        source_document: toReadableText(item.source_document).slice(0, 120) || null
      }))
      .filter((item) => item.title && item.detail)
      .slice(0, 40);
  } catch {
    return fallbackRequirements(contextSections);
  }
}

function fallbackIntake(rawText: string): IntakeSuggestion {
  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lowered = lines.map((line) => line.toLowerCase());

  const customerLine = lines.find((line) => line.toLowerCase().startsWith("customer:"));
  const customerName = customerLine ? customerLine.split(":", 2)[1]?.trim() ?? "Unknown Customer" : "Unknown Customer";

  const dateMatch = rawText.match(/(20\d{2})-(\d{2})-(\d{2})/);
  const valueMatch = rawText.match(/(?:USD|EUR|NOK|SEK|\$|€)\s?([0-9][0-9,.]{4,})/i);

  const custom_fields: Record<string, string> = {};
  const questionDeadline = lines.find((line) => line.toLowerCase().includes("clarification") && line.toLowerCase().includes("deadline"));
  if (questionDeadline) {
    custom_fields.question_deadline = questionDeadline;
  }

  return {
    customer_name: customerName,
    title: lines[0] ?? "Untitled Bid",
    estimated_value: valueMatch ? Number(valueMatch[1].replace(/,/g, "")) : null,
    deadline: dateMatch ? dateMatch[0] : null,
    owner: lowered.some((line) => line.includes("procurement")) ? "Procurement Team" : "Bid Team",
    custom_fields
  };
}

function fallbackChat(question: string, documents: Array<{ fileName: string; rawText: string }>): ChatAnswer {
  const lines = documents.flatMap((document) =>
    document.rawText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ line, fileName: document.fileName }))
  );

  const questionTerms = Array.from(new Set((question.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(Boolean)));

  const picks = lines.filter((item) => questionTerms.some((term) => item.line.toLowerCase().includes(term))).slice(0, 6);
  const highlights = picks.length ? picks : lines.slice(0, 5);

  if (!highlights.length) {
    return {
      answer: "I could not find a direct answer in the uploaded document context.",
      confidence: "Low",
      citations: []
    };
  }

  const answer = [
    "Executive summary:",
    "The uploaded material points to a practical delivery-focused bid with clear timeline and compliance expectations.",
    "",
    "Relevant points from the document:",
    ...highlights.slice(0, 5).map((item) => `- ${item.line}`),
    "",
    "Recommended next actions:",
    "1. Build a requirement-to-solution coverage matrix and assign an owner per requirement.",
    "2. Validate timeline assumptions and identify missing clarifications before proposal lock.",
    "3. Align commercial structure with the expectations explicitly stated in the document."
  ].join("\n");

  return {
    answer,
    confidence: highlights.length >= 4 ? "High" : "Medium",
    citations: highlights.slice(0, 5).map((item) => ({
      document_name: item.fileName,
      excerpt: item.line
    }))
  };
}

function fallbackRequirements(contextSections: string[]): RequirementSuggestion[] {
  const lines = contextSections
    .flatMap((section) => section.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Document") && !line.startsWith("Bid metadata"));

  return lines
    .filter((line) => /must|shall|required|requirement|needs to|expected to/i.test(line))
    .slice(0, 20)
    .map((line) => ({
      title: line.slice(0, 100),
      detail: line,
      category: /security|identity|encrypt|mfa/i.test(line)
        ? "Security"
        : /price|cost|commercial|budget/i.test(line)
          ? "Commercial"
          : /support|sla|incident|service/i.test(line)
            ? "Service"
            : "General",
      priority: /must|shall|required/i.test(line) ? "High" : "Medium",
      source_excerpt: line,
      source_document: null
    }));
}
