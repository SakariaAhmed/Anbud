import "server-only";

import type { ProjectDocumentDetail } from "@/lib/types";

export type ReasoningEffort = "low" | "medium" | "high";

type JsonCompletionClient = {
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

type JsonCompletionRuntime = {
  getClient: () => Promise<JsonCompletionClient>;
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  supportsCustomTemperature: (model: string) => boolean;
};

function parseJson<T>(content: string): T {
  const trimmed = content.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  const candidate = codeBlockMatch?.[1] ?? trimmed;
  return JSON.parse(candidate) as T;
}

function requestOptions(input: {
  timeoutMs?: number;
  maxRetries?: number;
  abortController: AbortController | null;
}) {
  return input.timeoutMs || typeof input.maxRetries === "number"
    ? {
        ...(input.timeoutMs ? { timeout: input.timeoutMs } : {}),
        ...(typeof input.maxRetries === "number"
          ? { maxRetries: input.maxRetries }
          : {}),
        ...(input.abortController ? { signal: input.abortController.signal } : {}),
      }
    : undefined;
}

function timeoutPromise(input: {
  timeoutMs?: number;
  abortController: AbortController | null;
  message: string;
  setHandle: (handle: ReturnType<typeof setTimeout>) => void;
}) {
  return input.timeoutMs
    ? new Promise<never>((_, reject) => {
        input.setHandle(
          setTimeout(() => {
            input.abortController?.abort();
            reject(new Error(`${input.message} etter ${input.timeoutMs} ms.`));
          }, input.timeoutMs),
        );
      })
    : null;
}

export async function runJsonCompletion<T>(
  input: JsonCompletionRuntime & {
    system: string;
    user: string;
    temperature?: number;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    timeoutMs?: number;
    maxRetries?: number;
  },
): Promise<T> {
  const client = await input.getClient();
  const model = input.model ?? input.defaultModel;
  const reasoningEffort = input.reasoningEffort ?? input.defaultReasoningEffort;
  const startedAt = Date.now();
  const abortController = input.timeoutMs ? new AbortController() : null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const completionPromise = client.chat.completions.create(
    {
      model,
      reasoning_effort: reasoningEffort,
      ...(input.supportsCustomTemperature(model)
        ? { temperature: input.temperature ?? 0.1 }
        : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    },
    requestOptions({
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries,
      abortController,
    }),
  );
  const timeout = timeoutPromise({
    timeoutMs: input.timeoutMs,
    abortController,
    message: "AI-kall timeout",
    setHandle: (handle) => {
      timeoutHandle = handle;
    },
  });
  const response = (await (timeout
    ? Promise.race([completionPromise, timeout])
    : completionPromise).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  })) as ChatCompletionResponse;
  console.info(
    JSON.stringify({
      event: "ai_json_completion_timing",
      model,
      reasoning_effort: reasoningEffort,
      system_chars: input.system.length,
      user_chars: input.user.length,
      duration_ms: Date.now() - startedAt,
    }),
  );

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("AI returnerte tomt svar.");
  }

  return parseJson<T>(content);
}

export async function runJsonCompletionWithFileInputs<T>(
  input: JsonCompletionRuntime & {
    system: string;
    user: string;
    fileDocuments: Pick<
      ProjectDocumentDetail,
      "file_name" | "content_type" | "file_base64"
    >[];
    temperature?: number;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    timeoutMs?: number;
    maxRetries?: number;
  },
): Promise<T> {
  const client = await input.getClient();
  const model = input.model ?? input.defaultModel;
  const reasoningEffort = input.reasoningEffort ?? input.defaultReasoningEffort;
  const startedAt = Date.now();
  const abortController = input.timeoutMs ? new AbortController() : null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
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
  const responsePromise = client.responses.create(
    {
      model,
      instructions: input.system,
      reasoning: { effort: reasoningEffort },
      ...(input.supportsCustomTemperature(model)
        ? { temperature: input.temperature ?? 0.1 }
        : {}),
      input: [{ role: "user", content }],
    },
    requestOptions({
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries,
      abortController,
    }),
  );
  const timeout = timeoutPromise({
    timeoutMs: input.timeoutMs,
    abortController,
    message: "AI-filinput timeout",
    setHandle: (handle) => {
      timeoutHandle = handle;
    },
  });
  const response = await (timeout
    ? Promise.race([responsePromise, timeout])
    : responsePromise).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
  console.info(
    JSON.stringify({
      event: "ai_json_file_input_completion_timing",
      model,
      reasoning_effort: reasoningEffort,
      system_chars: input.system.length,
      user_chars: input.user.length,
      file_count: input.fileDocuments.length,
      duration_ms: Date.now() - startedAt,
    }),
  );

  const outputText = response.output_text?.trim();
  if (!outputText) {
    throw new Error("AI returnerte tomt svar.");
  }

  return parseJson<T>(outputText);
}
