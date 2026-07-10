import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

const jiti = createJiti(path.join(frontendRoot, "json-completion-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  normalizeFileInputContentType,
  runJsonCompletion,
  runJsonCompletionWithFileInputs,
} = jiti(path.join(frontendRoot, "lib/server/ai/json-completion.ts"));
const { runWithProjectWorkflowContext } = jiti(
  path.join(frontendRoot, "lib/server/project-workflow-cancellation.ts"),
);

function jsonRuntime(outputText, calls = []) {
  return {
    defaultModel: "gpt-5.4-mini",
    defaultReasoningEffort: "low",
    supportsCustomTemperature: () => true,
    async getClient() {
      return {
        chat: {
          completions: {
            async create() {
              throw new Error("chat completions should not be used");
            },
          },
        },
        responses: {
          async create(body) {
            calls.push(body);
            return { output_text: outputText };
          },
        },
      };
    },
  };
}

function chatJsonRuntime(outputText, calls = []) {
  return {
    defaultModel: "gpt-5.4-mini",
    defaultReasoningEffort: "low",
    supportsCustomTemperature: () => true,
    async getClient() {
      return {
        chat: {
          completions: {
            async create(body) {
              calls.push(body);
              return { choices: [{ message: { content: outputText } }] };
            },
          },
        },
        responses: {
          async create() {
            throw new Error("responses should not be used");
          },
        },
      };
    },
  };
}

test("file input content type falls back from generic pdf metadata", () => {
  assert.equal(
    normalizeFileInputContentType({
      fileName: "Bilag 1 - Petoro.pdf",
      contentType: "application/octet-stream",
    }),
    "application/pdf",
  );
});

test("file input content type preserves specific office metadata", () => {
  assert.equal(
    normalizeFileInputContentType({
      fileName: "Krav.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
});

test("file input JSON completion requests JSON object output", async () => {
  const calls = [];
  const result = await runJsonCompletionWithFileInputs({
    ...jsonRuntime('{"ok":true}', calls),
    system: "Return JSON.",
    user: "Analyze the file.",
    fileDocuments: [
      {
        file_name: "krav.pdf",
        content_type: "application/octet-stream",
        file_base64: Buffer.from("pdf").toString("base64"),
      },
    ],
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0].text, { format: { type: "json_object" } });
});

test("file input JSON completion accepts fenced JSON", async () => {
  const result = await runJsonCompletionWithFileInputs({
    ...jsonRuntime('```json\n{"ok":true}\n```'),
    system: "Return JSON.",
    user: "Analyze the file.",
    fileDocuments: [],
  });

  assert.deepEqual(result, { ok: true });
});

test("file input JSON completion reports malformed JSON with a short sample", async () => {
  await assert.rejects(
    runJsonCompletionWithFileInputs({
      ...jsonRuntime("Her er svaret: { nope"),
      system: "Return JSON.",
      user: "Analyze the file.",
      fileDocuments: [],
    }),
    /AI returnerte ugyldig JSON:.*Utdrag: Her er svaret/u,
  );
});

test("JSON completion applies stable prompt cache family and prefix", async () => {
  const calls = [];
  const result = await runJsonCompletion({
    ...chatJsonRuntime('{"ok":true}', calls),
    system: "Return JSON.",
    user: "Analyze.",
    promptCacheKey: "requirement-response-batch",
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(
    calls[0].prompt_cache_key,
    "anbud:json-v2:requirement-response-batch:gpt-5.4-mini",
  );
  assert.equal(calls[0].prompt_cache_retention, "24h");
  assert.match(
    calls[0].messages[0].content,
    /^### Stable Anbud JSON Contract[\s\S]+### Task-Specific Contract\nReturn JSON\./u,
  );
});

test("JSON completion forwards the active project workflow abort signal", async () => {
  const controller = new AbortController();
  let requestSignal;

  const result = await runWithProjectWorkflowContext({ signal: controller.signal }, () =>
    runJsonCompletion({
      ...chatJsonRuntime('{"ok":true}'),
      async getClient() {
        return {
          chat: {
            completions: {
              async create(_body, options) {
                requestSignal = options?.signal;
                return { choices: [{ message: { content: '{"ok":true}' } }] };
              },
            },
          },
          responses: {
            async create() {
              throw new Error("responses should not be used");
            },
          },
        };
      },
      system: "Return JSON.",
      user: "Analyze.",
    }),
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(requestSignal, controller.signal);
});

test("an aborted project workflow does not start another JSON completion", async () => {
  const controller = new AbortController();
  const leaseLost = new Error("lease lost");
  let requests = 0;
  controller.abort(leaseLost);

  await assert.rejects(
    runWithProjectWorkflowContext({ signal: controller.signal }, () =>
      runJsonCompletion({
        ...chatJsonRuntime('{"ok":true}'),
        async getClient() {
          requests += 1;
          return chatJsonRuntime('{"ok":true}').getClient();
        },
        system: "Return JSON.",
        user: "Analyze.",
      }),
    ),
    leaseLost,
  );

  assert.equal(requests, 0);
});

test("JSON completion forwards max completion tokens", async () => {
  const calls = [];
  const result = await runJsonCompletion({
    ...chatJsonRuntime('{"ok":true}', calls),
    system: "Return JSON.",
    user: "Analyze.",
    maxCompletionTokens: 256,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].max_completion_tokens, 256);
});
