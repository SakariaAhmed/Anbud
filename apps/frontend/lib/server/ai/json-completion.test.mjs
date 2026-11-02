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
  runStructuredJsonResponse,
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

test("document analysis uses a lean, non-persistent strict Responses contract", async () => {
  const calls = [];
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const result = await runStructuredJsonResponse({
    ...jsonRuntime('{"ok":true}', calls),
    system: "Analyser dokumentet.",
    user: "Kildegrunnlag.",
    schemaName: "document_analysis_v3",
    schema,
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].model, "gpt-5.6-terra");
  assert.equal(calls[0].store, false);
  assert.deepEqual(calls[0].reasoning, { effort: "low" });
  assert.deepEqual(calls[0].text, {
    verbosity: "medium",
    format: {
      type: "json_schema",
      name: "document_analysis_v3",
      strict: true,
      schema,
    },
  });
  assert.equal("prompt_cache_retention" in calls[0], false);
  assert.equal(calls[0].instructions, "Analyser dokumentet.");
  assert.doesNotMatch(calls[0].instructions, /Stable Anbud JSON Contract/u);
  assert.ok(calls[0].prompt_cache_key.length <= 64);
  assert.match(
    calls[0].prompt_cache_key,
    /^anbud:da3:document_analysis_v3:gpt-5\.6-terra:[a-f0-9]{16}$/u,
  );
});

test("document analysis cache keys stay compact, stable, and distinct", async () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const firstCalls = [];
  const repeatedCalls = [];
  const distinctCalls = [];
  const commonInput = {
    system: "Analyser dokumentet.",
    user: "Kildegrunnlag.",
    schema,
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
  };

  await runStructuredJsonResponse({
    ...jsonRuntime('{"ok":true}', firstCalls),
    ...commonInput,
    schemaName:
      "customer_analysis_v3_with_a_name_that_used_to_make_the_cache_key_too_long",
  });
  await runStructuredJsonResponse({
    ...jsonRuntime('{"ok":true}', repeatedCalls),
    ...commonInput,
    schemaName:
      "customer_analysis_v3_with_a_name_that_used_to_make_the_cache_key_too_long",
  });
  await runStructuredJsonResponse({
    ...jsonRuntime('{"ok":true}', distinctCalls),
    ...commonInput,
    schemaName:
      "customer_analysis_v3_with_a_name_that_has_the_same_first_twenty_chars",
  });

  const firstKey = firstCalls[0].prompt_cache_key;
  const repeatedKey = repeatedCalls[0].prompt_cache_key;
  const distinctKey = distinctCalls[0].prompt_cache_key;

  assert.ok(firstKey.length <= 64);
  assert.equal(firstKey, repeatedKey);
  assert.notEqual(firstKey, distinctKey);
});

test("file input JSON completion redacts malformed model output", async () => {
  await assert.rejects(
    runJsonCompletionWithFileInputs({
      ...jsonRuntime("Her er svaret: { nope"),
      system: "Return JSON.",
      user: "Analyze the file.",
      fileDocuments: [],
    }),
    (error) => {
      assert.equal(error.name, "InvalidAiJsonError");
      assert.match(error.request_id, /^[a-f0-9-]+$/u);
      assert.match(error.output_sha256, /^[a-f0-9]{24}$/u);
      assert.match(
        error.message,
        /^AI returnerte ugyldig JSON \(request_id=[a-f0-9-]+; output_sha256=[a-f0-9]{24}\)\.$/u,
      );
      assert.doesNotMatch(error.message, /Her er svaret|nope/u);
      return true;
    },
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

test("JSON completion telemetry correlates starts, successes and failures", async (t) => {
  const telemetry = [];
  const capture = (line) => {
    const event = JSON.parse(line);
    if (String(event.event).startsWith("ai_json_completion_")) {
      telemetry.push(event);
    }
  };
  t.mock.method(console, "info", capture);
  t.mock.method(console, "warn", capture);

  const success = chatJsonRuntime('{"ok":true}');
  success.getClient = async () => ({
    chat: {
      completions: {
        async create() {
          return {
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: {
              prompt_tokens: 25,
              completion_tokens: 10,
              total_tokens: 35,
            },
          };
        },
      },
    },
    responses: {
      async create() {
        throw new Error("responses should not be used");
      },
    },
  });
  await runJsonCompletion({
    ...success,
    system: "Return JSON.",
    user: "Analyze.",
  });

  const failure = chatJsonRuntime('{"ok":true}');
  failure.getClient = async () => ({
    chat: {
      completions: {
        async create() {
          throw new Error("provider unavailable");
        },
      },
    },
    responses: {
      async create() {
        throw new Error("responses should not be used");
      },
    },
  });
  await assert.rejects(
    runJsonCompletion({
      ...failure,
      system: "Return JSON.",
      user: "Analyze.",
    }),
    /provider unavailable/u,
  );

  const starts = telemetry.filter(
    (event) => event.event === "ai_json_completion_started",
  );
  const completed = telemetry.find(
    (event) => event.event === "ai_json_completion_timing",
  );
  const failed = telemetry.find(
    (event) => event.event === "ai_json_completion_failed",
  );
  assert.equal(starts.length, 2);
  assert.equal(completed.request_id, starts[0].request_id);
  assert.equal(failed.request_id, starts[1].request_id);
  assert.equal(completed.total_tokens, 35);
  assert.equal(failed.failure_type, "Error");
});

test("JSON completion timeout emits one failed terminal event and no success", async (t) => {
  const telemetry = [];
  const capture = (line) => {
    const event = JSON.parse(line);
    if (String(event.event).startsWith("ai_json_completion_")) {
      telemetry.push(event);
    }
  };
  t.mock.method(console, "info", capture);
  t.mock.method(console, "warn", capture);

  await assert.rejects(
    runJsonCompletion({
      ...chatJsonRuntime('{"ok":true}'),
      async getClient() {
        return {
          chat: {
            completions: {
              async create() {
                return new Promise(() => {});
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
      timeoutMs: 10,
      maxRetries: 0,
    }),
    /AI-kall timeout etter 10 ms/u,
  );

  const starts = telemetry.filter(
    (event) => event.event === "ai_json_completion_started",
  );
  const failures = telemetry.filter(
    (event) => event.event === "ai_json_completion_failed",
  );
  const successes = telemetry.filter(
    (event) => event.event === "ai_json_completion_timing",
  );
  assert.equal(starts.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(successes.length, 0);
  assert.equal(failures[0].request_id, starts[0].request_id);
  assert.equal(failures[0].provider_response_received, false);
});

test("GPT-6 Chat and file-input Responses use the supported cache lifetime and omit temperature", async () => {
  const { GPT_MODELS_USE_DEFAULT_TEMPERATURE } = jiti(path.join(frontendRoot, "lib/server/ai/model-config.ts"));
  const originalRetention = process.env.OPENAI_PROMPT_CACHE_RETENTION;
  try {
    for (const model of ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]) {
      for (const fileInputs of [false, true]) {
        for (const retention of ["24h", "in_memory"]) {
          process.env.OPENAI_PROMPT_CACHE_RETENTION = retention;
          const calls = [];
          await (fileInputs ? runJsonCompletionWithFileInputs : runJsonCompletion)({
            ...(fileInputs ? jsonRuntime('{"ok":true}', calls) : chatJsonRuntime('{"ok":true}', calls)),
            supportsCustomTemperature: (name) => !GPT_MODELS_USE_DEFAULT_TEMPERATURE.test(name),
            system: "Return JSON.",
            user: "Analyze.",
            model,
            fileDocuments: [],
            temperature: 0,
            promptCacheKey: "requirement-coverage-batch",
          });
          assert.equal("prompt_cache_retention" in calls[0], false);
          assert.deepEqual(calls[0].prompt_cache_options, { ttl: "30m" });
          assert.equal("temperature" in calls[0], false);
        }
      }
    }
  } finally {
    if (originalRetention === undefined) delete process.env.OPENAI_PROMPT_CACHE_RETENTION;
    else process.env.OPENAI_PROMPT_CACHE_RETENTION = originalRetention;
  }
});

function streamRuntime(events, observed = {}) {
  return {...jsonRuntime(""),async getClient(){return {responses:{async create(body,options){
    observed.body=body;observed.options=options;
    return (async function*(){for(const event of events){if(event instanceof Error)throw event;observed.yieldedType=event.type;yield event;}})();
  }}};}};
}
const streamInput={system:"Return JSON",user:"Analyze",schemaName:"partial_test",schema:{type:"object"}};
function textDelta(delta){return {type:"response.output_text.delta",delta,output_index:0,content_index:0,item_id:"one"};}
function streamDone(text){return {type:"response.completed",response:{status:"completed",output:[{content:[{type:"output_text",text}]}]}};}

test("structured stream publishes complete nested and escaped fields exactly once with arbitrary chunk boundaries",async()=>{
  const text=JSON.stringify({summary:'Norsk æøå "},"',items:[{text:"one\\two"}]});
  for(let width=1;width<9;width++){
    const events=[];for(let i=0;i<text.length;i+=width)events.push(textDelta(text.slice(i,i+width)));events.push(streamDone(text));
    const fields=[],observed={};
    const result=await runStructuredJsonResponse({...streamRuntime(events,observed),...streamInput,maxRetries:2,onCompletedField:async(k,v)=>{assert.equal(observed.yieldedType,"response.output_text.delta");fields.push([k,v]);}});
    assert.deepEqual(Object.fromEntries(fields),JSON.parse(text));assert.deepEqual(result,JSON.parse(text));
    assert.equal(observed.body.stream,true);assert.equal(observed.options.maxRetries,0);
  }
});

test("truncation and later provider failure preserve only completed fields",async()=>{
  for(const suffix of [[],[new Error("provider failed")],[{type:"response.incomplete"}]]){
    const fields=[];
    await assert.rejects(runStructuredJsonResponse({...streamRuntime([textDelta('{"ready":"first","unfinished":["half'),...suffix]),...streamInput,onCompletedField:async(k,v)=>{fields.push([k,v]);}}));
    assert.deepEqual(fields,[["ready","first"]]);
  }
});

test("stream rejects duplicate keys, malformed JSON, changed final text and multiple outputs without exposing content",async()=>{
  for(const events of [
    [textDelta('{"a":1,"a":2}'),streamDone('{"a":1,"a":2}')],
    [textDelta('{"secret":private customer text}')],
    [textDelta('{"a":1,'),{...textDelta('"b":2}'),item_id:"two"}],
    [textDelta('{"a":1}'),streamDone('{"a":2}')],
    [textDelta('{"a":1,}'),streamDone('{"a":1,}')],
    [textDelta('{"a":1} trailing'),streamDone('{"a":1} trailing')],
  ])await assert.rejects(runStructuredJsonResponse({...streamRuntime(events),...streamInput,onCompletedField:async()=>{}}),error=>{assert.doesNotMatch(error.message,/private customer text/);return true;});
});

test("partial write failure and workflow cancellation stop before publishing another field",async()=>{
  const controller=new AbortController(),fields=[],observed={};
  await assert.rejects(runWithProjectWorkflowContext({signal:controller.signal},()=>runStructuredJsonResponse({...streamRuntime([textDelta('{"a":1,"b":2}'),streamDone('{"a":1,"b":2}')],observed),...streamInput,onCompletedField:async key=>{fields.push(key);controller.abort(new Error("cancelled"));}})),/cancelled/);
  assert.deepEqual(fields,["a"]);assert.equal(observed.options.signal.aborted,true);
  const writes=[];
  await assert.rejects(runStructuredJsonResponse({...streamRuntime([textDelta('{"a":1,"b":2}')]),...streamInput,onCompletedField:async key=>{writes.push(key);throw new Error("fence lost");}}),/fence lost/);
  assert.deepEqual(writes,["a"]);
});

test("stream timeout aborts a stalled body after response headers",async()=>{
  let signal;
  const runtime={...jsonRuntime(""),async getClient(){return {responses:{async create(_body,options){signal=options.signal;return(async function*(){yield textDelta('{"a":1,');await new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}));signal.throwIfAborted();})();}}};}};
  const fields=[];
  await assert.rejects(runStructuredJsonResponse({...runtime,...streamInput,timeoutMs:25,onCompletedField:async key=>{fields.push(key);}}),/timeout/i);
  assert.equal(signal.aborted,true);assert.deepEqual(fields,["a"]);
});


test("a completed stream missing a schema-required field never becomes a complete result",async()=>{
  const fields=[];
  await assert.rejects(runStructuredJsonResponse({...streamRuntime([textDelta('{"ready":1}'),streamDone('{"ready":1}')]),...streamInput,schema:{type:"object",required:["ready","missing"]},onCompletedField:async(k,v)=>{fields.push([k,v]);}}),/missing required fields/);
  assert.deepEqual(fields,[["ready",1]]);
});
