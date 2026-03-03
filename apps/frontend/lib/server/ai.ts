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
  citations: string[];
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
  documentTexts: string[];
  bidContext: Record<string, string>;
}): Promise<ChatAnswer> {
  const question = params.question.trim();
  if (!question) {
    return { answer: "Please enter a question.", confidence: "Low", citations: [] };
  }

  const contextSections: string[] = [];
  let totalChars = 0;
  for (let i = 0; i < params.documentTexts.length; i += 1) {
    const snippet = params.documentTexts[i].slice(0, 3500);
    if (totalChars + snippet.length > 22000) {
      break;
    }
    totalChars += snippet.length;
    contextSections.push(`Document ${i + 1}:\n${snippet}`);
  }
  contextSections.push(`Bid metadata:\n${JSON.stringify(params.bidContext)}`);

  if (!params.documentTexts.length) {
    return {
      answer: "No document context is available for this bid yet. Upload a requirement document first.",
      confidence: "Low",
      citations: []
    };
  }

  const client = getClient();
  if (!client) {
    return fallbackChat(question, contextSections);
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
            "Return strict JSON with keys: answer, confidence, citations. confidence must be Low/Medium/High.\n\n" +
            `Question:\n${question}\n\nContext:\n${contextSections.join("\n\n")}`
        }
      ]
    });

    const payload = safeJson<Partial<ChatAnswer>>(completion.choices[0]?.message?.content ?? "{}", {});
    const answerText = toReadableText(payload.answer);
    return {
      answer: answerText || "I could not derive a reliable answer from the provided context.",
      confidence: normalizeConfidence(payload.confidence),
      citations: Array.isArray(payload.citations)
        ? payload.citations.map((item) => toReadableText(item)).filter(Boolean)
        : []
    };
  } catch {
    return fallbackChat(question, contextSections);
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

function fallbackChat(question: string, contextSections: string[]): ChatAnswer {
  const lines = contextSections
    .flatMap((section) => section.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Document") && !line.startsWith("Bid metadata"));

  const questionTerms = Array.from(new Set((question.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(Boolean)));

  const picks = lines.filter((line) => questionTerms.some((term) => line.toLowerCase().includes(term))).slice(0, 6);
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
    ...highlights.slice(0, 5).map((item) => `- ${item}`),
    "",
    "Recommended next actions:",
    "1. Build a requirement-to-solution coverage matrix and assign an owner per requirement.",
    "2. Validate timeline assumptions and identify missing clarifications before proposal lock.",
    "3. Align commercial structure with the expectations explicitly stated in the document."
  ].join("\n");

  return {
    answer,
    confidence: highlights.length >= 4 ? "High" : "Medium",
    citations: highlights.slice(0, 5)
  };
}
