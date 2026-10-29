import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { frozenInvocation } from "./generation-input.mjs";

// Capture the actual prepared prompt and real local retrieval without buying a
// generated answer. Embeddings still use the existing metered budget proxy.
const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const label = process.argv[2];
if (!/^[a-z0-9-]+$/.test(label ?? "")) throw new Error("Supply a unique capture label.");
const output = path.join(dir, "verification", `chat-context-${label}.json`);
if (existsSync(output)) throw new Error("Never overwrite a captured prompt.");
const env = JSON.parse(readFileSync(path.join(dir, "local-environment.json")));
if (env.DATA_API_URL !== "http://127.0.0.1:55440" || env.OPENAI_BASE_URL !== "http://127.0.0.1:4319/v1" || env.OPENAI_API_KEY !== "local-evaluation-proxy-only") throw new Error("Local fixtures and metered proxy required.");
Object.assign(process.env, env);
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
const real = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { retrieveDocumentSnippetsWithMetadata } = real(path.join(frontend, "lib/server/document-chunks.ts"));
const { getProjectSourceRevision } = real(path.join(frontend, "lib/server/repositories/data-store.ts"));
const fixture = JSON.parse(readFileSync(path.join(dir, "generation-inputs.json"))).cases.find(c => c.caseId === "sundvik-32-requirements");
const invocation = frozenInvocation(fixture, "chat", { chatHistoryMode: "route-current", chatQuestionMode: "late-operational-requirements" });
const sha = value => createHash("sha256").update(value).digest("hex");
if (await getProjectSourceRevision(fixture.projectId) !== fixture.sourceRevision) throw new Error("Source changed.");
const budget = () => fetch("http://127.0.0.1:4319/budget").then(r => r.json());
const state = { retrieveDocumentSnippetsWithMetadata, prompts: [], retrieval: [] };
globalThis.__chatContextCapture = state;
const temporary = mkdtempSync(path.join(tmpdir(), "anbud-chat-capture-"));
const before = await budget();
try {
  const completion = path.join(temporary, "completion.cjs");
  const retrieval = path.join(temporary, "retrieval.cjs");
  writeFileSync(completion, `exports.createJsonCompletion = async () => { throw new Error("This capture requires a first question without rewriting."); };
exports.createTextCompletionStream = async input => { globalThis.__chatContextCapture.prompts.push(input); return (async function* () {})(); };`);
  writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async input => { const output = await globalThis.__chatContextCapture.retrieveDocumentSnippetsWithMetadata(input); globalThis.__chatContextCapture.retrieval.push({input, output}); return output; };`);
  const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval, "@": frontend, "server-only": "/dev/null" } });
  const { streamProjectChat } = load(path.join(frontend, "lib/server/ai/project-chat.ts"));
  const result = await streamProjectChat(invocation);
  for await (const chunk of result.stream) if (chunk) throw new Error("No answer should be generated.");
  const after = await budget();
  const sourceUnchanged = await getProjectSourceRevision(fixture.projectId) === fixture.sourceRevision;
  const requestIds = after.requests.filter(r => !before.requests.some(b => b.id === r.id)).map(r => r.id);
  const report = { at: new Date().toISOString(), scope: "Actual public chat owner and real persisted local retrieval; only final answer completion replaced by a prompt recorder. Not live answer-quality evidence.", invocationSha256: sha(JSON.stringify(invocation)), sourceUnchanged, code: Object.fromEntries(["project-chat.ts", "context.ts"].map(f => [f, sha(readFileSync(path.join(frontend, "lib/server/ai", f)))])), prompts: state.prompts, retrieval: state.retrieval, sourceReferences: result.sourceReferences, budgetBefore: before, budgetAfter: after, requestIds };
  writeFileSync(output, JSON.stringify(report, null, 2));
  if (!sourceUnchanged || state.prompts.length !== 1 || state.retrieval.length !== 1) throw new Error("Capture incomplete.");
  console.log(JSON.stringify({ output, requestIds, sources: result.sourceReferences.length, snippets: state.retrieval[0].output.snippets.length, promptChars: state.prompts[0].user.length }));
} finally {
  delete globalThis.__chatContextCapture;
  rmSync(temporary, { recursive: true, force: true });
}
