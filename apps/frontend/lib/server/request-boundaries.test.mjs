import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jiti = createJiti(path.join(frontendRoot, "request-boundaries-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const load = (file) => jiti.import(path.join(frontendRoot, file));

const { routeErrorResponse } = await load("lib/server/api-responses.ts");
const { AuthorizationError } = await load("lib/server/authorization.ts");
const { WorkflowError, WorkflowPreconditionError } = await load("lib/server/workflow-errors.ts");
const { productionSafeErrorMessage } = await load("lib/server/safe-errors.ts");
const { ProjectWorkflowTerminalMetadataError } = await load(
  "lib/server/project-job-terminal-metadata.ts",
);
const {
  RequestBodyError,
  optionalTextField,
  readJsonObject,
  stringListField,
} = await load("lib/server/request-body.ts");

async function responseOf(error, options) {
  const response = routeErrorResponse(error, "Kunne ikke fullføre.", options);
  return { status: response.status, body: await response.json() };
}

test("route errors keep the status of known domain failures instead of a blanket 500", async () => {
  const invalidPdf = await responseOf(new WorkflowError("INVALID_PDF_DOCUMENT"));
  assert.equal(invalidPdf.status, 400);
  assert.match(invalidPdf.body.error, /PDF-filen er ugyldig/);

  // PostgreSQL raises codes as message text through PostgREST.
  const busy = await responseOf(new Error("PROJECT_WORKFLOW_BUSY: another job holds the lease"));
  assert.equal(busy.status, 409);

  // Workflow steps re-wrap failures; the code must survive the wrapping.
  const wrapped = await responseOf(
    new Error("Helhetsvurderingen feilet.", {
      cause: new WorkflowError("PROJECT_SOURCE_REVISION_CHANGED"),
    }),
  );
  assert.equal(wrapped.status, 409);
  assert.match(wrapped.body.error, /Prosjektgrunnlaget ble endret/);
});

test("user-fixable workflow preconditions are a 422 with their own message", async () => {
  const missingDocument = await responseOf(
    new WorkflowPreconditionError("Last opp minst ett dokument først."),
  );
  assert.equal(missingDocument.status, 422);
  assert.equal(missingDocument.body.error, "Last opp minst ett dokument først.");
});

test("route errors map request, authorization and unknown failures", async () => {
  assert.equal((await responseOf(new RequestBodyError("Ugyldig."))).status, 400);
  assert.equal((await responseOf(new AuthorizationError("Nei.", 404))).status, 404);
  assert.equal((await responseOf(new Error("database offline"))).status, 500);
  assert.equal((await responseOf(new Error("database offline"), { status: 404 })).status, 404);
  assert.equal(
    (await responseOf(new WorkflowError("PROJECT_JOB_SUPERSEDED"), { status: 404 })).status,
    409,
  );
});

const jsonRequest = (body) =>
  new Request("http://localhost/api", { method: "POST", body });

test("request bodies are parsed once at the boundary", async () => {
  assert.deepEqual(await readJsonObject(jsonRequest("")), {});
  assert.deepEqual(await readJsonObject(jsonRequest('{"name":"Anbud"}')), { name: "Anbud" });
  await assert.rejects(readJsonObject(jsonRequest("{not json")), RequestBodyError);
  await assert.rejects(readJsonObject(jsonRequest("[1,2]")), RequestBodyError);
  await assert.rejects(readJsonObject(jsonRequest('"text"')), RequestBodyError);
});

test("request field readers reject wrong types instead of crashing later", () => {
  assert.equal(optionalTextField({ name: "  Prosjekt  " }, "name"), "Prosjekt");
  assert.equal(optionalTextField({ name: "   " }, "name"), null);
  assert.equal(optionalTextField({}, "name"), null);
  assert.throws(() => optionalTextField({ name: 1 }, "name"), RequestBodyError);
  assert.deepEqual(stringListField({}, "ids"), []);
  assert.deepEqual(stringListField({ ids: ["a"] }, "ids"), ["a"]);
  assert.throws(() => stringListField({ ids: ["a", 2] }, "ids"), RequestBodyError);
  assert.throws(() => stringListField({ ids: "a" }, "ids"), RequestBodyError);
});

test("production job errors keep user-facing workflow messages and hide raw failures", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const incomplete = new ProjectWorkflowTerminalMetadataError(
      "Kravbesvarelsen ble ikke lagret fordi 1 av 97 krav ikke kunne besvares automatisk. Uavklarte krav: KD-10.",
      { requirement_response_handoff: null },
      "KD-10 (batch_error: upstream detail) [avvist svar: modelltekst]",
    );
    const shown = productionSafeErrorMessage(incomplete, "Jobben feilet.");
    assert.ok(shown.startsWith(incomplete.publicMessage));
    assert.match(shown, / Referanse: [a-f0-9]{24}\.$/u);
    // Internal reasons and rejected model output stay in logs only.
    assert.doesNotMatch(shown, /batch_error|avvist svar|modelltekst/u);

    const hidden = productionSafeErrorMessage(
      new Error("upstream host=internal.example timeout"),
      "Jobben feilet.",
    );
    assert.match(hidden, /^Jobben feilet\. Referanse: [a-f0-9]{24}\.$/u);
    assert.doesNotMatch(hidden, /internal\.example/u);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
