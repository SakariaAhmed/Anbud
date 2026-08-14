import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CUTOVER_ARTIFACTS,
  MigrationControlError,
  activateTargetProjectJobClaims,
  probeAzureBlobWithManagedIdentity,
  runAzureMigrationControl,
  validateFinalCutoverEvidence,
  validateMigrationControlConfiguration,
} from "./run_azure_migration_control.mjs";
import {
  FIXTURE_EVIDENCE_TIME,
  FIXTURE_TIME,
  validArtifactPayloads,
  validBlobManifest,
  validDatabaseComparisonReport,
  validEvidenceBundle,
  validPreflightReport,
} from "../../../scripts/azure_cutover_evidence_test_fixtures.mjs";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(frontendRoot, "../..");
const digest = "a".repeat(64);
const clock = () => new Date(FIXTURE_TIME);
const bundle = validEvidenceBundle();
const evidenceDigest = bundle.envelopeSha256;

function validEnvironment(overrides = {}) {
  return {
    DATA_API_URL:
      "https://anbud-postgrest.internal.example.norwayeast.azurecontainerapps.io",
    DATA_API_ALLOWED_HOST_SUFFIX:
      ".internal.example.norwayeast.azurecontainerapps.io",
    DATA_API_SERVICE_ROLE_KEY: "synthetic-azure-service-token",
    AZURE_STORAGE_ACCOUNT_URL:
      "https://anbudprod123.blob.core.windows.net",
    AZURE_STORAGE_CONTAINER: "anbud-documents",
    AZURE_MIGRATION_EVIDENCE_CONTAINER: "anbud-migration-evidence",
    MIGRATION_CONTROL_EVIDENCE_BLOB:
      "cutovers/final-20260814-115500-abcdef/evidence-v2.json",
    MIGRATION_CONTROL_EVIDENCE_SHA256: evidenceDigest,
    MIGRATION_CONTROL_EVIDENCE_MAX_AGE_SECONDS: "7200",
    AZURE_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
    IDENTITY_ENDPOINT: "http://localhost:42356/msi/token/",
    IDENTITY_HEADER: "platform-rotated-synthetic-header",
    MIGRATION_CONTROL_IMAGE: `anbudprod123.azurecr.io/anbud@sha256:${digest}`,
    MIGRATION_CONTROL_TIMEOUT_MS: "5000",
    ...overrides,
  };
}

function successfulFetch(calls) {
  const versions = new Map([
    ["project_job_fencing_preflight", "authoritative-lease-fencing-v1"],
    [
      "project_job_terminal_audit_preflight",
      "transactional-project-job-terminal-audit-v2",
    ],
    [
      "stable_main_rollback_bridge_preflight",
      "stable-main-rollback-bridge-v1",
    ],
    [
      "atomic_service_document_write_preflight",
      "atomic-service-document-write-v1",
    ],
  ]);
  return async (url, options) => {
    calls.push({ url, options });
    const version = [...versions].find(([name]) =>
      url.pathname.endsWith(name),
    )?.[1];
    return {
      ok: true,
      async json() {
        if (version) return version;
        if (url.pathname.endsWith("project_job_claim_control")) {
          return [{ claims_enabled: false }];
        }
        if (url.pathname.endsWith("project_jobs")) return [];
        return undefined;
      },
    };
  };
}

function managedIdentityFetch(config, evidenceBundle, calls = []) {
  const payloadByPath = new Map(
    Object.entries(evidenceBundle.envelope.artifacts).map(([key, descriptor]) => [
      `/${config.evidenceContainer}/${descriptor.blobPath}`,
      evidenceBundle.payloads[key],
    ]),
  );
  payloadByPath.set(
    `/${config.evidenceContainer}/${config.evidenceBlob}`,
    evidenceBundle.envelopeBytes,
  );
  return async (url, options) => {
    calls.push({ url, options });
    if (url.hostname === "localhost") {
      return {
        ok: true,
        async json() {
          return {
            access_token: `synthetic.${"a".repeat(120)}.token`,
            client_id: config.managedIdentityClientId,
          };
        },
      };
    }
    if (options.method === "HEAD") return { ok: true };
    const bytes = payloadByPath.get(url.pathname);
    if (!bytes) return { ok: false, status: 404 };
    return {
      ok: true,
      headers: { get: (name) => (name === "content-length" ? String(bytes.byteLength) : null) },
      async arrayBuffer() {
        return bytes;
      },
    };
  };
}

test("configuration accepts only an immutable image and internal ACA data API", () => {
  const configuration = validateMigrationControlConfiguration(
    validEnvironment(),
  );
  assert.match(configuration.image, /@sha256:[0-9a-f]{64}$/u);
  assert.equal(
    configuration.dataApiRoot,
    "https://anbud-postgrest.internal.example.norwayeast.azurecontainerapps.io",
  );

  for (const overrides of [
    { MIGRATION_CONTROL_IMAGE: "anbudprod123.azurecr.io/anbud:latest" },
    { DATA_API_URL: "https://credential-capture.example" },
    { DATA_API_SERVICE_ROLE_KEY: "" },
    { AZURE_STORAGE_ACCOUNT_URL: "http://anbudprod123.blob.core.windows.net" },
    { AZURE_MIGRATION_EVIDENCE_CONTAINER: "anbud-documents" },
    { MIGRATION_CONTROL_EVIDENCE_BLOB: "../untrusted.json" },
    { MIGRATION_CONTROL_EVIDENCE_SHA256: "not-a-digest" },
    { IDENTITY_ENDPOINT: "https://credential-capture.example/token" },
  ]) {
    assert.throws(
      () =>
        validateMigrationControlConfiguration(validEnvironment(overrides)),
      MigrationControlError,
    );
  }
});

test("control forwards the token only to the validated internal host and then probes Blob", async () => {
  const calls = [];
  const events = [];
  const result = await runAzureMigrationControl({
    environment: validEnvironment(),
    fetchImpl: successfulFetch(calls),
    async blobProbe(configuration) {
      events.push("blob");
      assert.equal(configuration.managedIdentityClientId, validEnvironment().AZURE_CLIENT_ID);
    },
  });

  assert.equal(calls.length, 8);
  assert.ok(
    calls.every(
      ({ url }) =>
        url.hostname ===
        "anbud-postgrest.internal.example.norwayeast.azurecontainerapps.io",
    ),
  );
  assert.ok(calls.every(({ options }) => options.redirect === "error"));
  assert.ok(
    calls.every(
      ({ options }) =>
        options.headers.apikey === "synthetic-azure-service-token" &&
        options.headers.authorization ===
          "Bearer synthetic-azure-service-token",
    ),
  );
  assert.deepEqual(events, ["blob"]);
  assert.equal(result.migration_control, "ready");
});

test("control fails closed before Blob when the internal data contract fails", async () => {
  let blobProbed = false;
  await assert.rejects(
    runAzureMigrationControl({
      environment: validEnvironment(),
      async fetchImpl() {
        return { ok: false, status: 403 };
      },
      async blobProbe() {
        blobProbed = true;
      },
    }),
    /data_api_project_jobs_contract_failed/u,
  );
  assert.equal(blobProbed, false);
});

test("target validation mode proves the internal contract without accepting cutover evidence", async () => {
  const calls = [];
  let blobProbed = false;
  const result = await runAzureMigrationControl({
    environment: validEnvironment(),
    mode: "validate-target",
    fetchImpl: successfulFetch(calls),
    async blobProbe() {
      blobProbed = true;
    },
  });

  assert.equal(calls.length, 8);
  assert.equal(blobProbed, false);
  assert.deepEqual(result, {
    migration_control: "target_validated",
    checks: ["digest_pinned_image", "internal_data_api_contract"],
  });
});

test("Blob probe uses the local identity endpoint and a read-only container request", async () => {
  const config = validateMigrationControlConfiguration(validEnvironment());
  const calls = [];
  const result = await probeAzureBlobWithManagedIdentity(
    config,
    managedIdentityFetch(config, bundle, calls),
    clock,
  );

  assert.equal(calls.length, 12);
  assert.equal(calls[0].url.protocol, "http:");
  assert.equal(calls[0].url.hostname, "localhost");
  assert.equal(
    calls[0].url.searchParams.get("resource"),
    "https://storage.azure.com/",
  );
  assert.equal(
    calls[0].url.searchParams.get("client_id"),
    config.managedIdentityClientId,
  );
  assert.equal(
    calls[0].options.headers["x-identity-header"],
    "platform-rotated-synthetic-header",
  );
  assert.equal(calls[1].options.method, "HEAD");
  assert.equal(calls[1].url.protocol, "https:");
  assert.equal(calls[1].url.searchParams.get("restype"), "container");
  assert.match(calls[1].options.headers.authorization, /^Bearer synthetic\./u);
  assert.equal(calls[2].options.method, "HEAD");
  assert.equal(calls[2].url.pathname, "/anbud-migration-evidence");
  assert.equal(calls[3].options.method, "GET");
  assert.equal(
    calls[3].url.pathname,
    "/anbud-migration-evidence/cutovers/final-20260814-115500-abcdef/evidence-v2.json",
  );
  assert.match(calls[3].options.headers.authorization, /^Bearer synthetic\./u);
  assert.equal(result.version, "azure-final-cutover-evidence-v2");
  assert.equal(result.verifiedArtifacts.length, 8);
  assert.ok(
    calls.slice(3).every(({ options }) => options.method === "GET"),
  );
});

test("fresh v2 envelope requires all unique descriptors and rejects v1 or minimal evidence", () => {
  const config = validateMigrationControlConfiguration(validEnvironment());
  assert.doesNotThrow(() =>
    validateFinalCutoverEvidence(bundle.envelope, config, clock),
  );
  const duplicatePath = structuredClone(bundle.envelope);
  duplicatePath.artifacts.verifyLog.blobPath =
    duplicatePath.artifacts.restoreLog.blobPath;
  const staleDescriptor = structuredClone(bundle.envelope);
  staleDescriptor.artifacts.verifyLog.generatedAt = "2026-08-14T08:00:00.000Z";
  const oversizedDescriptor = structuredClone(bundle.envelope);
  oversizedDescriptor.artifacts.databaseDump.size =
    CUTOVER_ARTIFACTS.databaseDump.maxBytes + 1;
  for (const evidence of [
    { version: "azure-final-cutover-evidence-v1", generatedAt: FIXTURE_EVIDENCE_TIME },
    { version: "azure-final-cutover-evidence-v2", generatedAt: FIXTURE_EVIDENCE_TIME },
    { ...bundle.envelope, generatedAt: "2026-08-13T10:00:00.000Z" },
    {
      ...bundle.envelope,
      source: { ...bundle.envelope.source, frozen: false },
    },
    duplicatePath,
    staleDescriptor,
    oversizedDescriptor,
  ]) {
    assert.throws(
      () => validateFinalCutoverEvidence(evidence, config, clock),
      MigrationControlError,
    );
  }
});

test("Blob probe re-hashes every descriptor and rejects minimal or mismatched full reports", async () => {
  const mismatchedComparison = validDatabaseComparisonReport();
  mismatchedComparison.tables[0].content_match = false;
  const mismatchedManifest = validBlobManifest();
  mismatchedManifest.sourceBytes += 1;
  const runningPreflight = validPreflightReport();
  runningPreflight.source.running_jobs = 1;
  const payloadCases = [
    {
      databaseComparison: Buffer.from('{"status":"verified"}'),
    },
    {
      databaseComparison: Buffer.from(JSON.stringify(mismatchedComparison)),
    },
    {
      blobManifest: Buffer.from(JSON.stringify(mismatchedManifest)),
    },
    {
      preflight: Buffer.from(JSON.stringify(runningPreflight)),
    },
  ];
  for (const payloads of payloadCases) {
    const invalidBundle = validEvidenceBundle({ payloads });
    const config = validateMigrationControlConfiguration(
      validEnvironment({
        MIGRATION_CONTROL_EVIDENCE_SHA256: invalidBundle.envelopeSha256,
      }),
    );
    await assert.rejects(
      probeAzureBlobWithManagedIdentity(
        config,
        managedIdentityFetch(config, invalidBundle),
        clock,
      ),
      MigrationControlError,
    );
  }
});

test("Blob probe rejects descriptor digest, byte-count, and bounded-size drift", async () => {
  const corruptedPayloads = validArtifactPayloads();
  corruptedPayloads.verifyLog = Buffer.alloc(
    corruptedPayloads.verifyLog.byteLength,
    0x78,
  );
  const corruptedResponseBundle = {
    ...bundle,
    payloads: corruptedPayloads,
  };
  const config = validateMigrationControlConfiguration(validEnvironment());
  await assert.rejects(
    probeAzureBlobWithManagedIdentity(
      config,
      managedIdentityFetch(config, corruptedResponseBundle),
      clock,
    ),
    /cutover_artifact_digest_mismatch/u,
  );

  const truncatedPayloads = validArtifactPayloads();
  truncatedPayloads.databaseDump = Buffer.from("short");
  await assert.rejects(
    probeAzureBlobWithManagedIdentity(
      config,
      managedIdentityFetch(config, { ...bundle, payloads: truncatedPayloads }),
      clock,
    ),
    /cutover_artifact_size_mismatch/u,
  );

  const oversized = structuredClone(bundle.envelope);
  oversized.artifacts.databaseDump.size = CUTOVER_ARTIFACTS.databaseDump.maxBytes + 1;
  const oversizedBytes = Buffer.from(JSON.stringify(oversized));
  const oversizedBundle = {
    ...bundle,
    envelope: oversized,
    envelopeBytes: oversizedBytes,
    envelopeSha256: createHash("sha256").update(oversizedBytes).digest("hex"),
  };
  const oversizedConfig = validateMigrationControlConfiguration(
    validEnvironment({
      MIGRATION_CONTROL_EVIDENCE_SHA256: oversizedBundle.envelopeSha256,
    }),
  );
  await assert.rejects(
    probeAzureBlobWithManagedIdentity(
      oversizedConfig,
      managedIdentityFetch(oversizedConfig, oversizedBundle),
      clock,
    ),
    /cutover_artifact_descriptor_invalid/u,
  );
});

test("Blob probe refuses an evidence container that reports public access", async () => {
  const config = validateMigrationControlConfiguration(validEnvironment());
  const baseFetch = managedIdentityFetch(config, bundle);
  await assert.rejects(
    probeAzureBlobWithManagedIdentity(
      config,
      async (url, options) => {
        if (
          options.method === "HEAD" &&
          url.pathname === `/${config.evidenceContainer}`
        ) {
          return {
            ok: true,
            headers: {
              get(name) {
                return name === "x-ms-blob-public-access" ? "blob" : null;
              },
            },
          };
        }
        return baseFetch(url, options);
      },
      clock,
    ),
    /evidence_container_not_private/u,
  );
});

test("target claim activation uses only the validated internal PostgREST RPC", async () => {
  const config = validateMigrationControlConfiguration(validEnvironment());
  const calls = [];
  await activateTargetProjectJobClaims(config, async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          version: "project-job-cutover-v1",
          claims_enabled: true,
        };
      },
    };
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.hostname, "anbud-postgrest.internal.example.norwayeast.azurecontainerapps.io");
  assert.equal(calls[0].url.pathname, "/rpc/set_project_job_claims_enabled");
  assert.equal(calls[0].options.body, '{"p_claims_enabled":true}');
  assert.equal(calls[0].options.redirect, "error");
});

test("activation mode rechecks the closed target and zero running state before opening claims", async () => {
  const calls = [];
  let blobProbed = false;
  const fetchImpl = successfulFetch(calls);
  const result = await runAzureMigrationControl({
    environment: validEnvironment(),
    mode: "activate-target",
    async fetchImpl(url, options) {
      if (url.pathname.endsWith("set_project_job_claims_enabled")) {
        calls.push({ url, options });
        return {
          ok: true,
          async json() {
            return {
              version: "project-job-cutover-v1",
              claims_enabled: true,
            };
          },
        };
      }
      return fetchImpl(url, options);
    },
    async blobProbe() {
      blobProbed = true;
    },
  });
  assert.equal(calls.length, 9);
  assert.equal(blobProbed, false);
  assert.equal(result.migration_control, "target_claims_activated");
  assert.ok(
    calls.at(-2).url.pathname.endsWith("project_jobs") &&
      calls.at(-1).url.pathname.endsWith("set_project_job_claims_enabled"),
  );
});

test("Bicep, image, and workflow preserve the internal management-plane boundary", () => {
  const bicep = readFileSync(
    path.join(repositoryRoot, "infra/azure/migration-control.bicep"),
    "utf8",
  );
  const dockerfile = readFileSync(
    path.join(frontendRoot, "Dockerfile"),
    "utf8",
  );
  const workflow = readFileSync(
    path.join(repositoryRoot, ".github/workflows/deploy-azure.yml"),
    "utf8",
  );

  assert.match(bicep, /triggerType:\s*'Manual'/u);
  assert.match(bicep, /replicaRetryLimit:\s*0/u);
  assert.match(bicep, /keyVaultUrl:/u);
  assert.match(bicep, /identity:\s*controlIdentity\.id/u);
  assert.match(bicep, /Storage Blob Data Reader/u);
  assert.match(bicep, /migrationEvidenceContainerName/u);
  assert.match(bicep, /MIGRATION_CONTROL_EVIDENCE_SHA256/u);
  assert.match(
    bicep,
    /resource migrationControl[^\n]*= if \(imageDigestPinned\)/u,
  );
  assert.doesNotMatch(bicep, /external:\s*true/u);
  assert.doesNotMatch(bicep, /value:\s*dataApiServiceRole/u);
  assert.match(dockerfile, /run_azure_migration_control\.mjs/u);

  const controlStepStart = workflow.indexOf(
    "name: Run internal Azure migration control",
  );
  const controlStepEnd = workflow.indexOf(
    "name: Reconcile infrastructure without releasing candidate code",
    controlStepStart,
  );
  assert.ok(controlStepStart > 0 && controlStepEnd > controlStepStart);
  const controlStep = workflow.slice(controlStepStart, controlStepEnd);
  assert.match(controlStep, /az containerapp job start/u);
  assert.match(controlStep, /az containerapp job execution show/u);
  assert.match(controlStep, /properties\.status/u);
  assert.doesNotMatch(controlStep, /DATA_API_SERVICE_ROLE_KEY/u);
  assert.doesNotMatch(controlStep, /--env-vars/u);
  assert.doesNotMatch(workflow, /secrets\.DATA_API_SERVICE_ROLE_KEY/u);
  assert.match(workflow, /enabledForTemplateDeployment/u);
  assert.match(workflow, /dataApiServiceRoleKey:\s*\{\s*reference:/u);
  assert.match(workflow, /secretVersion: process\.env\.DATA_API_SECRET_VERSION/u);
  assert.match(workflow, /confirm_azure_backend_cutover/u);
  assert.match(workflow, /final_cutover_evidence_sha256/u);
  assert.match(workflow, /Prove frozen Supabase source has zero running jobs/u);
  assert.match(workflow, /source_claim_gate_not_closed/u);
  assert.match(workflow, /MIGRATION_DISABLED_WORKER_CRON/u);
  assert.match(workflow, /Suspend scheduled worker for Azure cutover/u);
  assert.match(workflow, /Activate internal Azure worker claims after smoke/u);
  assert.match(
    workflow,
    /--args scripts\/run_azure_migration_control\.mjs activate-target/u,
  );
  assert.match(workflow, /Restore scheduled worker after completed release/u);
  assert.match(
    workflow,
    /steps\.rollout\.outcome == 'success'\s*&& steps\.activate_target\.outcome == 'success'/u,
  );
  assert.match(
    bicep,
    /secrets\/\$\{dataApiServiceRoleSecretName\}\/\$\{dataApiServiceRoleSecretVersion\}/u,
  );

  const reconcileStep = workflow.slice(controlStepEnd);
  assert.match(
    reconcileStep,
    /steps\.deployment_config\.outputs\.azure_backend != 'true' \|\| steps\.migration_control\.outcome == 'success'/u,
  );
});
