import "server-only";

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

type ChatCompletionStreamChunk = {
  choices: Array<{
    delta?: { content?: string | null } | null;
  }>;
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
}): Promise<T> {
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
}): Promise<T> {
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
}) {
  const workflowSignal = getProjectWorkflowAbortSignal();
  workflowSignal?.throwIfAborted();
  const client = await getClient();
  const model = input.model ?? ANALYSIS_MODEL;
  const stream = (await retryTransientAiRequest(
    "text_completion_stream",
    () =>
      client.chat.completions.create({
        model,
        stream: true,
        reasoning_effort: input.reasoningEffort ?? ANALYSIS_REASONING_EFFORT,
        ...(input.maxCompletionTokens
          ? { max_completion_tokens: input.maxCompletionTokens }
          : {}),
        ...temperaturePayload({
          model,
          requestedTemperature: input.temperature,
          fallbackTemperature: 0.3,
          label: "text_completion_stream",
        }),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }, workflowSignal ? { signal: workflowSignal } : undefined),
  )) as AsyncIterable<ChatCompletionStreamChunk>;

  async function* textChunks() {
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }

  return textChunks();
}
