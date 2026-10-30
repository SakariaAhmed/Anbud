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
const { DatabaseUpdateRequiredError } = await load("lib/server/database-update-required.ts");
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
  assert.equal(busy.body.code, "PROJECT_WORKFLOW_BUSY", "clients react to the code, not the text");
  assert.doesNotMatch(busy.body.error, /lease/u);

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

test("unknown route failures carry no workflow code", async () => {
  const unknown = await responseOf(new Error("private backend detail"));
  assert.equal(unknown.status, 500);
  assert.equal("code" in unknown.body, false);
});

test("a missing database update is a fixed Norwegian 503 with its code", async () => {
  const missing = await responseOf(
    new DatabaseUpdateRequiredError("insert_vacant_primary_project_document"),
  );
  assert.equal(missing.status, 503);
  assert.equal(missing.body.code, "DATABASE_UPDATE_REQUIRED");
  assert.equal(
    missing.body.error,
    "Databasen mangler en nødvendig oppdatering, så dokumentet ble ikke lagret. Kontakt administrator.",
  );
  assert.doesNotMatch(missing.body.error, /insert_vacant/u, "internal names stay in logs");
});
