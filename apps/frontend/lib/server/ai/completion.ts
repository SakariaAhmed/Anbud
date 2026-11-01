import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

import type { Untrusted } from "@/lib/unknown-values";
import {
  runJsonCompletion,
  runJsonCompletionWithFileInputs,
  type ReasoningEffort,
} from "@/lib/server/ai/json-completion";
import {
  ANALYSIS_MODEL,
  ANALYSIS_REASONING_EFFORT,
  GPT_MODELS_USE_DEFAULT_TEMPERATURE,
} from "@/lib/server/ai/model-config";
import {
  assertProjectWorkflowActive,
  getProjectWorkflowAbortSignal,
} from "@/lib/server/project-workflow-cancellation";
import { safeErrorTelemetry } from "@/lib/server/safe-errors";
import type { ProjectDocumentDetail } from "@/lib/types";

type OpenAIClient = {
  chat: {
    completions: {
      create: (
        input: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  };
  responses: {
    create: (
      input: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<{
      output_text?: string;
    }>;
  };
};

type ChatCompletionResponse = {
  choices: Array<{ message?: { content?: string | null } | null }>;
};

let cachedClientPromise: Promise<OpenAIClient> | null = null;

export async function getClient() {
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

export function supportsCustomTemperature(model: string) {
  return !GPT_MODELS_USE_DEFAULT_TEMPERATURE.test(model);
}

function temperaturePayload(input: {
  model: string;
  requestedTemperature?: number;
  fallbackTemperature: number;
  label: string;
}) {
  if (supportsCustomTemperature(input.model)) {
    return {
      temperature: input.requestedTemperature ?? input.fallbackTemperature,
    };
  }

  if (input.requestedTemperature !== undefined) {
    console.info(
      JSON.stringify({
        event: "ai_temperature_omitted",
        label: input.label,
        model: input.model,
        requested_temperature: input.requestedTemperature,
        reason: "model_uses_default_temperature",
      }),
    );
  }

  return {};
}

const TEXT_COMPLETION_RETRY_DELAYS_MS = [600, 1400];

function isTransientAiRequestError(error: unknown) {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : null;
  if (status === 408 || status === 409 || status === 429 || (status ?? 0) >= 500) {
    return true;
  }

  const message =
    error instanceof Error ? error.message : String(error ?? "");
  return /\b(fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timeout|temporar|overload|rate limit)\b/i.test(
    message,
  );
}

async function retryTransientAiRequest<T>(
  label: string,
  run: () => Promise<T>,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= TEXT_COMPLETION_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      assertProjectWorkflowActive();
      lastError = error;
      if (
        attempt >= TEXT_COMPLETION_RETRY_DELAYS_MS.length ||
        !isTransientAiRequestError(error)
      ) {
        throw error;
      }

      const delayMs = TEXT_COMPLETION_RETRY_DELAYS_MS[attempt];
      console.warn(
        JSON.stringify({
          event: "ai_text_completion_retry",
          label,
          attempt: attempt + 1,
          delay_ms: delayMs,
          ...safeErrorTelemetry(error),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

export async function createJsonCompletion<T>(input: {
  system: string;
  user: string;
  userMessages?: string[];
  temperature?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  maxCompletionTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  promptCacheKey?: string;
}): Promise<Untrusted<T>> {
  return runJsonCompletion<T>({
    ...input,
    getClient,
    defaultModel: ANALYSIS_MODEL,
    defaultReasoningEffort: ANALYSIS_REASONING_EFFORT,
    supportsCustomTemperature,
  });
}

export async function createJsonCompletionWithFileInputs<T>(input: {
  system: string;
  user: string;
  fileDocuments: ProjectDocumentDetail[];
  temperature?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  maxRetries?: number;
  promptCacheKey?: string;
}): Promise<Untrusted<T>> {
  return runJsonCompletionWithFileInputs<T>({
    ...input,
    getClient,
    defaultModel: ANALYSIS_MODEL,
    defaultReasoningEffort: ANALYSIS_REASONING_EFFORT,
    supportsCustomTemperature,
  });
}

export async function createTextCompletion(input: {
  system: string;
  user: string;
  temperature?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  maxCompletionTokens?: number;
}) {
  const workflowSignal = getProjectWorkflowAbortSignal();
  workflowSignal?.throwIfAborted();
  const client = await getClient();
  const model = input.model ?? ANALYSIS_MODEL;
  const response = (await retryTransientAiRequest(
    "text_completion",
    () =>
      client.chat.completions.create({
        model,
        reasoning_effort: input.reasoningEffort ?? ANALYSIS_REASONING_EFFORT,
        ...(input.maxCompletionTokens
          ? { max_completion_tokens: input.maxCompletionTokens }
          : {}),
        ...temperaturePayload({
          model,
          requestedTemperature: input.temperature,
          fallbackTemperature: 0.3,
          label: "text_completion",
        }),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }, workflowSignal ? { signal: workflowSignal } : undefined),
  )) as ChatCompletionResponse;

  return response.choices[0]?.message?.content?.trim() || "";
}

export async function createTextCompletionStream(input: {
  system: string;
  user: string;
  temperature?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  maxCompletionTokens?: number;
  promptCacheKey?: string;
  traceId?: string;
  signal?: AbortSignal;
}) {
  const workflowSignal = input.signal ?? getProjectWorkflowAbortSignal();
  workflowSignal?.throwIfAborted();
  const client = await getClient();
  const model = input.model ?? ANALYSIS_MODEL;
  const startedAt = Date.now();
  const traceId = input.traceId ?? randomUUID();
  const cacheKey = `anbud:chat-v1:${createHash("sha256").update(`${model}\0${input.system}\0${input.promptCacheKey ?? ""}`).digest("hex").slice(0, 32)}`;
  const stream = (await retryTransientAiRequest(
    "text_completion_stream",
    () =>
      client.responses.create({
        model,
        stream: true,
        store: false,
        prompt_cache_key: cacheKey,
        reasoning: { effort: input.reasoningEffort ?? ANALYSIS_REASONING_EFFORT },
        instructions: input.system,
        input: input.user,
        ...(input.maxCompletionTokens
          ? { max_output_tokens: input.maxCompletionTokens }
          : {}),
        ...temperaturePayload({
          model,
          requestedTemperature: input.temperature,
          fallbackTemperature: 0.3,
          label: "text_completion_stream",
        }),
      }, workflowSignal ? { signal: workflowSignal } : undefined),
  )) as unknown as AsyncIterable<ResponseStreamEvent>;

  async function* textChunks() {
    let firstToken = false;
    let completed = false;
    for await (const event of stream) {
      workflowSignal?.throwIfAborted();
      if (event.type === "response.output_text.delta" && event.delta) {
        if (!firstToken) {
          firstToken = true;
          console.info(JSON.stringify({ event: "chat_first_token", trace_id: traceId, model, duration_ms: Date.now() - startedAt }));
        }
        yield event.delta;
      } else if (event.type === "response.completed") {
        completed = true;
        const usage = event.response.usage;
        console.info(JSON.stringify({ event: "chat_completion", trace_id: traceId, model,
          duration_ms: Date.now() - startedAt, input_tokens: usage?.input_tokens,
          cached_tokens: usage?.input_tokens_details?.cached_tokens, output_tokens: usage?.output_tokens }));
      } else if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
        // Provider errors can contain prompt excerpts. Keep the client error
        // safe and never treat a truncated stream as a completed answer.
        throw new Error("AI-svaret ble ikke fullført. Prøv meldingen på nytt.");
      }
    }
    if (!completed) throw new Error("Forbindelsen ble avsluttet før AI-svaret var fullført.");
  }

  return textChunks();
}
