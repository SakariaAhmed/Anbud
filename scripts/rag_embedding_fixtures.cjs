// Real embedding responses are recorded once; replay never opens a network
// connection. A changed model or input must be recorded explicitly again.
const { createHash, randomUUID } = require("node:crypto");
const { existsSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");

function inputKey(model, text) {
  return createHash("sha256").update(`${model}\0${text}`).digest("hex");
}

function encodeVector(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) {
    throw new Error("Embedding response has invalid dimensions or values.");
  }
  const bytes = Buffer.alloc(dimensions * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  if (vector.some((_, index) => !Number.isFinite(bytes.readFloatLE(index * 4)))) throw new Error("Embedding values exceed float32 range.");
  return bytes.toString("base64");
}

function decodeVector(encoded, dimensions) {
  if (typeof encoded !== "string") throw new Error("Recorded embedding is not encoded text.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== dimensions * 4) throw new Error("Recorded embedding has invalid dimensions.");
  const vector = Array.from({ length: dimensions }, (_, index) => bytes.readFloatLE(index * 4));
  if (vector.some(value => !Number.isFinite(value))) throw new Error("Recorded embedding has invalid values.");
  return vector;
}

function createFixtureStore({ file, model, dimensions = 1536, record = false, request }) {
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (!existing && !record) throw new Error("Recorded embeddings are missing; recording is an explicit opt-in.");
  const fixture = existing ?? {
    version: 1, model, dimensions, encoding: "float32le-base64", recorded_at: new Date().toISOString(), vectors: {},
  };
  if (fixture.version !== 1 || fixture.model !== model || fixture.dimensions !== dimensions ||
      fixture.encoding !== "float32le-base64" || !fixture.vectors || typeof fixture.vectors !== "object" || Array.isArray(fixture.vectors)) {
    throw new Error("Recorded embeddings do not match this model/format.");
  }
  const stats = { requests: 0, recordedInputs: 0, replayedInputs: 0, missingInputs: 0 };
  function save() {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(fixture)}\n`);
    renameSync(temporary, file);
  }
  return {
    stats,
    async create(parameters, options) {
      if (parameters.model !== model || parameters.encoding_format !== "float") {
        throw new Error("Embedding fixture request changed model or encoding.");
      }
      const inputs = Array.isArray(parameters.input) ? parameters.input : [parameters.input];
      if (inputs.some(text => typeof text !== "string" || !text.trim())) throw new Error("Embedding fixtures require nonempty text input.");
      const missing = [...new Set(inputs.filter(text => !fixture.vectors[inputKey(model, text)]))];
      let usage = { prompt_tokens: 0, total_tokens: 0 };
      if (missing.length) {
        if (!record || typeof request !== "function") {
          stats.missingInputs += missing.length;
          throw new Error(`Missing ${missing.length} recorded embedding inputs; replay refuses network fallback.`);
        }
        const response = await request({ ...parameters, input: missing }, options);
        const returned = response?.data;
        if (!Array.isArray(returned) || returned.length !== missing.length ||
            new Set(returned.map(item => item.index)).size !== missing.length) throw new Error("Embedding recording returned incomplete rows.");
        // Validate the whole response before changing the fixture.
        const encoded = returned.map(item => {
          if (!Number.isInteger(item.index) || item.index < 0 || item.index >= missing.length) throw new Error("Embedding response has an invalid index.");
          return [inputKey(model, missing[item.index]), encodeVector(item.embedding, dimensions)];
        });
        Object.assign(fixture.vectors, Object.fromEntries(encoded));
        stats.requests++;
        stats.recordedInputs += missing.length;
        usage = response.usage ?? usage;
        save();
      }
      stats.replayedInputs += inputs.length - missing.length;
      return {
        object: "list", model, usage,
        data: inputs.map((text, index) => ({ object: "embedding", index, embedding: decodeVector(fixture.vectors[inputKey(model, text)], dimensions) })),
      };
    },
  };
}

// Share one fixture owner between Jiti's module graph and the CLI's final
// completeness assertion. Missing fixture inputs must not become a successful
// lexical-fallback gate after the application catches an embedding failure.
const stores = globalThis.__anbudRagEmbeddingFixtures ??= new Map();
function configuredStore(request) {
  const file = process.env.RAG_EVAL_EMBEDDINGS_FILE;
  if (!file) throw new Error("RAG_EVAL_EMBEDDINGS_FILE is required.");
  if (!stores.has(file)) stores.set(file, createFixtureStore({
    file, model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    record: process.env.RAG_EVAL_RECORD_EMBEDDINGS === "1", request,
  }));
  return stores.get(file);
}

class FixtureOpenAI {
  constructor(options = {}) {
    let live;
    const paidRerank = process.env.RAG_EVAL_ALLOW_MODEL_RERANK === "1";
    if (paidRerank && new URL(options.baseURL || process.env.OPENAI_BASE_URL || "https://api.openai.com").hostname !== "127.0.0.1") throw new Error("Paid replay reranking requires the explicit loopback budget proxy.");
    if (process.env.RAG_EVAL_RECORD_EMBEDDINGS === "1" || paidRerank) {
      const root = process.env.RAG_EVAL_FRONTEND_ROOT;
      if (!root) throw new Error("Recording requires the explicit frontend root.");
      const OpenAI = require(path.join(root, "node_modules/openai"));
      live = new OpenAI(options);
    }
    const store = configuredStore(live ? (...args) => live.embeddings.create(...args) : undefined);
    this.embeddings = { create: (...args) => store.create(...args) };
    if (paidRerank) {
      // Embeddings remain frozen; model calls are explicit and reported. CI
      // never enables this branch or receives a live completion client.
      const counted = resource => ({ create: (...args) => { store.stats.modelRequests = (store.stats.modelRequests ?? 0) + 1; return resource.create(...args); } });
      this.responses = counted(live.responses);
      this.chat = { completions: counted(live.chat.completions) };
    }
  }
}

module.exports = FixtureOpenAI;
module.exports.default = FixtureOpenAI;
module.exports.inputKey = inputKey;
module.exports.encodeVector = encodeVector;
module.exports.decodeVector = decodeVector;
module.exports.createFixtureStore = createFixtureStore;
module.exports.fixtureStats = file => stores.get(file)?.stats ?? null;
