import assert from "node:assert/strict";
import test from "node:test";

import { runProjectJobCutoverOperation } from "./run_project_job_cutover_rpc.mjs";

const configuration = {
  dataApiUrl:
    "https://anbud-postgrest.internal.example.norwayeast.azurecontainerapps.io",
  dataApiAllowedHostSuffix:
    ".internal.example.norwayeast.azurecontainerapps.io",
  serviceRoleKey: "synthetic-service-role-key",
};

test("cutover helper closes claims through the private data API", async () => {
  const calls = [];
  const result = await runProjectJobCutoverOperation({
    ...configuration,
    operation: "close-claims",
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            version: "project-job-cutover-v1",
            claims_enabled: false,
          };
        },
      };
    },
  });

  assert.equal(result.claims_enabled, false);
  assert.match(calls[0].url, /\/rpc\/set_project_job_claims_enabled$/u);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_claims_enabled: false,
  });
  assert.equal(calls[0].options.headers.apikey, configuration.serviceRoleKey);
});

test("cutover helper fails closed on external hosts and invalid results", async () => {
  await assert.rejects(
    runProjectJobCutoverOperation({
      ...configuration,
      operation: "requeue",
      dataApiUrl: "https://public.example.test",
    }),
    /expected internal HTTPS host/u,
  );
  await assert.rejects(
    runProjectJobCutoverOperation({
      ...configuration,
      operation: "open-claims",
      async fetchImpl() {
        return {
          ok: true,
          async json() {
            return {
              version: "project-job-cutover-v1",
              claims_enabled: false,
            };
          },
        };
      },
    }),
    /did not reach the requested state/u,
  );
});
