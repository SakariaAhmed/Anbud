#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const PROJECT_JOB_CUTOVER_VERSION = "project-job-cutover-v1";

function required(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

const operations = {
  "close-claims": {
    functionName: "set_project_job_claims_enabled",
    body: { p_claims_enabled: false },
    expectedClaimsEnabled: false,
  },
  "open-claims": {
    functionName: "set_project_job_claims_enabled",
    body: { p_claims_enabled: true },
    expectedClaimsEnabled: true,
  },
  requeue: {
    functionName: "requeue_project_jobs_for_cutover",
    body: {},
  },
  "prepare-rollback": {
    functionName: "prepare_stable_main_rollback",
    body: {},
  },
};

export async function runProjectJobCutoverOperation({
  operation,
  dataApiUrl,
  dataApiAllowedHostSuffix,
  serviceRoleKey,
  fetchImpl = fetch,
}) {
  const selected = operations[required(operation, "PROJECT_JOB_CUTOVER_OPERATION")];
  if (!selected) throw new Error("PROJECT_JOB_CUTOVER_OPERATION is invalid.");

  const checkedUrl = new URL(required(dataApiUrl, "DATA_API_URL"));
  const allowedSuffix = required(
    dataApiAllowedHostSuffix,
    "DATA_API_ALLOWED_HOST_SUFFIX",
  ).toLowerCase();
  if (
    checkedUrl.protocol !== "https:" ||
    checkedUrl.username ||
    checkedUrl.password ||
    checkedUrl.search ||
    checkedUrl.hash ||
    !/^\.internal\.[a-z0-9.-]+$/u.test(allowedSuffix) ||
    !checkedUrl.hostname.toLowerCase().endsWith(allowedSuffix) ||
    checkedUrl.hostname.length <= allowedSuffix.length
  ) {
    throw new Error("The cutover data API must use the expected internal HTTPS host.");
  }

  const credential = required(serviceRoleKey, "DATA_API_SERVICE_ROLE_KEY");
  const rootUrl = `${checkedUrl.origin}${checkedUrl.pathname}`.replace(/\/+$/u, "");
  const response = await fetchImpl(
    `${rootUrl}/rpc/${selected.functionName}`,
    {
      method: "POST",
      headers: {
        apikey: credential,
        authorization: `Bearer ${credential}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(selected.body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Project-job cutover RPC ${selected.functionName} failed with HTTP ${response.status}.`,
    );
  }
  const result = await response.json();
  if (result?.version !== PROJECT_JOB_CUTOVER_VERSION) {
    throw new Error("Project-job cutover RPC returned an unexpected version.");
  }
  if (
    "expectedClaimsEnabled" in selected &&
    result.claims_enabled !== selected.expectedClaimsEnabled
  ) {
    throw new Error("Project-job claim gate did not reach the requested state.");
  }
  return result;
}

async function main() {
  const result = await runProjectJobCutoverOperation({
    operation: process.env.PROJECT_JOB_CUTOVER_OPERATION,
    dataApiUrl: process.env.DATA_API_URL,
    dataApiAllowedHostSuffix: process.env.DATA_API_ALLOWED_HOST_SUFFIX,
    serviceRoleKey: process.env.DATA_API_SERVICE_ROLE_KEY,
  });
  console.log(
    JSON.stringify({
      operation: process.env.PROJECT_JOB_CUTOVER_OPERATION,
      version: result.version,
      status: "succeeded",
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
