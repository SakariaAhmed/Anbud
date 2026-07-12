#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function required(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function defaultAz(args) {
  const result = spawnSync("az", [...args, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const message = result.stderr.trim().split("\n").slice(-1)[0] || "Azure CLI failed.";
    throw new Error(message);
  }
  const output = result.stdout.trim();
  return output ? JSON.parse(output) : {};
}

function defaultSmoke(url) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "apps/frontend/scripts/smoke_health.mjs"), url],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`Health smoke failed for ${new URL(url).host}.`);
  }
}

const PROJECT_JOB_CUTOVER_VERSION = "project-job-cutover-v1";

function validateCutoverResult(result, operation) {
  if (
    !result ||
    typeof result !== "object" ||
    result.version !== PROJECT_JOB_CUTOVER_VERSION
  ) {
    throw new Error(`${operation} returned an unexpected cutover version.`);
  }
  return result;
}

export function createSupabaseCutoverRuntime({
  supabaseUrl,
  serviceRoleKey,
  expectedProjectRef,
  fetchImpl = fetch,
}) {
  const baseUrl = required(supabaseUrl, "SUPABASE_URL");
  const credential = required(
    serviceRoleKey,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const checkedUrl = new URL(baseUrl);
  if (
    expectedProjectRef?.trim() &&
    checkedUrl.hostname !== `${expectedProjectRef.trim()}.supabase.co`
  ) {
    throw new Error("SUPABASE_URL does not match SUPABASE_PROJECT_REF.");
  }

  const rpc = async (functionName, body) => {
    const url = new URL(`/rest/v1/rpc/${functionName}`, checkedUrl);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        apikey: credential,
        authorization: `Bearer ${credential}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Project-job cutover RPC ${functionName} failed with HTTP ${response.status}.`,
      );
    }
    return response.json();
  };

  return {
    async setClaimsEnabled(enabled) {
      const result = validateCutoverResult(
        await rpc("set_project_job_claims_enabled", {
          p_claims_enabled: enabled,
        }),
        "Project-job claim gate",
      );
      if (result.claims_enabled !== enabled) {
        throw new Error("Project-job claim gate did not reach the requested state.");
      }
      return result;
    },
    async requeueRunningJobs() {
      return validateCutoverResult(
        await rpc("requeue_project_jobs_for_cutover", {}),
        "Project-job cutover requeue",
      );
    },
    async prepareStableRollback() {
      return validateCutoverResult(
        await rpc("prepare_stable_main_rollback", {}),
        "Stable-main rollback preparation",
      );
    },
  };
}

function defaultCutoverRuntime() {
  return createSupabaseCutoverRuntime({
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    expectedProjectRef: process.env.SUPABASE_PROJECT_REF,
  });
}

function revisionValue(revision, name) {
  return revision?.[name] ?? revision?.properties?.[name];
}

export function selectPreviousHealthyRevision(app, revisions) {
  const latestReady = app?.properties?.latestReadyRevisionName;
  const candidates = revisions.filter((revision) => {
    const healthy = revisionValue(revision, "healthState") === "Healthy";
    const ready =
      revisionValue(revision, "provisioningState") === "Provisioned" ||
      revisionValue(revision, "provisioningState") === "Succeeded";
    return healthy && ready;
  });
  const configuredTraffic =
    app?.properties?.configuration?.ingress?.traffic ?? [];
  const configuredServingNames = new Set(
    configuredTraffic
      .filter((entry) => Number(entry.weight ?? 0) > 0)
      .map((entry) =>
        entry.revisionName
          ? entry.revisionName
          : entry.latestRevision === true
            ? latestReady
            : "",
      )
      .filter(Boolean),
  );
  const configuredServing = candidates.find((revision) =>
    configuredServingNames.has(revision.name),
  );
  const reportedServing = candidates
    .filter((revision) => Number(revisionValue(revision, "trafficWeight") ?? 0) > 0)
    .sort((left, right) =>
      String(revisionValue(right, "createdTime") ?? "").localeCompare(
        String(revisionValue(left, "createdTime") ?? ""),
      ),
    )[0];
  const exact = candidates.find((revision) => revision.name === latestReady);
  const selected = configuredServing ?? reportedServing ?? exact;
  if (!selected?.name) {
    throw new Error("No healthy serving Container Apps revision is available for rollback.");
  }
  return selected.name;
}

function containerImage(resource, containerName) {
  const containers = resource?.properties?.template?.containers ?? [];
  const container =
    containers.find((item) => item.name === containerName) ?? containers[0];
  return required(container?.image, `${containerName} image`);
}

function assertContainerVersion(resource, containerName, expectedImage) {
  const containers = resource?.properties?.template?.containers ?? [];
  const container =
    containers.find((item) => item.name === containerName) ?? containers[0];
  const actualImage = required(container?.image, `${containerName} image`);
  const appVersion = required(
    container?.env?.find((item) => item.name === "APP_VERSION")?.value,
    `${containerName} APP_VERSION`,
  );
  if (actualImage !== expectedImage || appVersion !== expectedImage) {
    throw new Error(
      `${containerName} image/version metadata did not reach the expected release.`,
    );
  }
}

function resourceFqdn(resource) {
  return required(
    resource?.properties?.configuration?.ingress?.fqdn,
    "Container App FQDN",
  );
}

function revisionCommand(action, resourceGroup, appName, revisionName) {
  return [
    "containerapp",
    "revision",
    action,
    "--resource-group",
    resourceGroup,
    "--name",
    appName,
    "--revision",
    revisionName,
  ];
}

function trafficCommand(
  resourceGroup,
  appName,
  servingRevision,
  retiredRevision,
) {
  const args = [
    "containerapp",
    "ingress",
    "traffic",
    "set",
    "--resource-group",
    resourceGroup,
    "--name",
    appName,
    "--revision-weight",
    `${servingRevision}=100`,
  ];
  if (retiredRevision && retiredRevision !== servingRevision) {
    args.push(`${retiredRevision}=0`);
  }
  return args;
}

function workerImageCommand(resourceGroup, workerJobName, image) {
  return [
    "containerapp",
    "job",
    "update",
    "--resource-group",
    resourceGroup,
    "--name",
    workerJobName,
    "--image",
    image,
    "--set-env-vars",
    `APP_VERSION=${image}`,
  ];
}

function appImageCommand(
  resourceGroup,
  appName,
  image,
  revisionSuffix,
  minReplicas,
) {
  return [
    "containerapp",
    "update",
    "--resource-group",
    resourceGroup,
    "--name",
    appName,
    "--image",
    image,
    "--revision-suffix",
    revisionSuffix,
    "--min-replicas",
    minReplicas,
    "--set-env-vars",
    `APP_VERSION=${image}`,
  ];
}

function stopWorkerExecutionsCommand(resourceGroup, workerJobName) {
  return [
    "containerapp",
    "job",
    "stop",
    "--resource-group",
    resourceGroup,
    "--name",
    workerJobName,
  ];
}

async function revisionResource(az, resourceGroup, appName, revisionName) {
  return az(revisionCommand("show", resourceGroup, appName, revisionName));
}

function revisionFqdn(revision, revisionName) {
  return required(
    revision?.properties?.fqdn ?? revision?.fqdn,
    `${revisionName} revision FQDN`,
  );
}

async function restoreStableDeployment(config, state, runtime = {}) {
  const resourceGroup = required(state.resourceGroup, "state.resourceGroup");
  const appName = required(state.appName, "state.appName");
  const workerJobName = required(
    state.workerJobName,
    "state.workerJobName",
  );
  const previousRevision = required(
    state.previousRevision,
    "state.previousRevision",
  );
  const previousWorkerImage = required(
    state.previousWorkerImage,
    "state.previousWorkerImage",
  );
  const previousAppImage = required(
    state.previousAppImage,
    "state.previousAppImage",
  );
  const candidateRevision = state.candidateRevision?.trim();
  const az = runtime.az ?? defaultAz;
  const smoke = runtime.smoke ?? defaultSmoke;
  const cutover = runtime.cutover ?? defaultCutoverRuntime();

  // Fail closed: no writer may claim work while either application generation
  // can still be alive. The gate is opened only after the stable web and worker
  // have both been restored and smoked.
  await cutover.setClaimsEnabled(false);
  await az(
    revisionCommand("activate", resourceGroup, appName, previousRevision),
  );
  const stableRevision = await revisionResource(
    az,
    resourceGroup,
    appName,
    previousRevision,
  );
  assertContainerVersion(stableRevision, "web", previousAppImage);
  const stableRevisionFqdn = revisionFqdn(stableRevision, previousRevision);
  await smoke(`https://${stableRevisionFqdn}`, "rollback-candidate");

  // Put a pre-smoked target behind the public endpoint before retiring the
  // only serving revision. Claims remain closed throughout the short overlap.
  await az(
    trafficCommand(
      resourceGroup,
      appName,
      previousRevision,
      candidateRevision,
    ),
  );
  if (candidateRevision && candidateRevision !== previousRevision) {
    await az(
      revisionCommand("deactivate", resourceGroup, appName, candidateRevision),
    );
  }
  await az(stopWorkerExecutionsCommand(resourceGroup, workerJobName));
  await cutover.prepareStableRollback();
  await az(
    workerImageCommand(resourceGroup, workerJobName, previousWorkerImage),
  );
  const restoredWorker = await az([
    "containerapp",
    "job",
    "show",
    "--resource-group",
    resourceGroup,
    "--name",
    workerJobName,
  ]);
  assertContainerVersion(restoredWorker, "worker", previousWorkerImage);
  // A schedule tick can create one last retired-image execution between the
  // first stop and the template update. Stop again while claims remain closed.
  await az(stopWorkerExecutionsCommand(resourceGroup, workerJobName));
  const app =
    config.appResource ??
    (await az([
      "containerapp",
      "show",
      "--resource-group",
      resourceGroup,
      "--name",
      appName,
    ]));
  await smoke(`https://${resourceFqdn(app)}`, "rollback-promoted");
  await cutover.setClaimsEnabled(true);
}

export async function rolloutContainerApp(config, runtime = {}) {
  const resourceGroup = required(config.resourceGroup, "resourceGroup");
  const appName = required(config.appName, "appName");
  const workerJobName = required(config.workerJobName, "workerJobName");
  const candidateImage = required(config.candidateImage, "candidateImage");
  const revisionSuffix = required(config.revisionSuffix, "revisionSuffix");
  const minReplicas = String(config.minReplicas ?? 1);
  const az = runtime.az ?? defaultAz;
  const smoke = runtime.smoke ?? defaultSmoke;
  const writeState =
    runtime.writeState ??
    ((state) => {
      if (config.stateFile) {
        writeFileSync(config.stateFile, JSON.stringify(state), {
          encoding: "utf8",
          mode: 0o600,
        });
      }
    });

  const app = await az([
    "containerapp",
    "show",
    "--resource-group",
    resourceGroup,
    "--name",
    appName,
  ]);
  const revisions = await az([
    "containerapp",
    "revision",
    "list",
    "--resource-group",
    resourceGroup,
    "--name",
    appName,
  ]);
  const worker = await az([
    "containerapp",
    "job",
    "show",
    "--resource-group",
    resourceGroup,
    "--name",
    workerJobName,
  ]);

  const previousRevision = selectPreviousHealthyRevision(app, revisions);
  const previousRevisionResource = await revisionResource(
    az,
    resourceGroup,
    appName,
    previousRevision,
  );
  const previousAppImage = containerImage(previousRevisionResource, "web");
  assertContainerVersion(previousRevisionResource, "web", previousAppImage);
  const previousWorkerImage = containerImage(worker, "worker");
  const appFqdn = resourceFqdn(app);
  const cutover = runtime.cutover ?? defaultCutoverRuntime();
  let candidateRevision = "";
  let cutoverStarted = false;
  const state = {
    resourceGroup,
    appName,
    workerJobName,
    previousRevision,
    previousAppImage,
    previousWorkerImage,
    candidateRevision,
    cutoverStarted: false,
  };
  writeState(state);

  await az([
    "containerapp",
    "revision",
    "set-mode",
    "--resource-group",
    resourceGroup,
    "--name",
    appName,
    "--mode",
    "multiple",
  ]);
  await az([
    "containerapp",
    "ingress",
    "traffic",
    "set",
    "--resource-group",
    resourceGroup,
    "--name",
    appName,
    "--revision-weight",
    `${previousRevision}=100`,
  ]);

  try {
    const updated = await az(
      appImageCommand(
        resourceGroup,
        appName,
        candidateImage,
        revisionSuffix,
        minReplicas,
      ),
    );
    candidateRevision = required(
      updated?.properties?.latestRevisionName,
      "candidate revision",
    );
    state.candidateRevision = candidateRevision;
    writeState(state);
    if (candidateRevision === previousRevision) {
      throw new Error("Azure did not create a distinct candidate revision.");
    }

    const candidate = await az([
      "containerapp",
      "revision",
      "show",
      "--resource-group",
      resourceGroup,
      "--name",
      appName,
      "--revision",
      candidateRevision,
    ]);
    assertContainerVersion(candidate, "web", candidateImage);
    const candidateFqdn = required(
      candidate?.properties?.fqdn ?? candidate?.fqdn,
      "candidate revision FQDN",
    );
    await smoke(`https://${candidateFqdn}`, "candidate");

    // From this point on, fail closed. The shared database gate blocks both
    // the stable direct UPDATE claim path and the lease-aware candidate path.
    cutoverStarted = true;
    state.cutoverStarted = true;
    writeState(state);
    await cutover.setClaimsEnabled(false);

    // Route to the pre-smoked candidate first so there is always a serving
    // revision. Claims stay closed until the retired web replicas and worker
    // executions are gone and their running rows have been requeued.
    await az(
      trafficCommand(
        resourceGroup,
        appName,
        candidateRevision,
        previousRevision,
      ),
    );
    await az(
      revisionCommand("deactivate", resourceGroup, appName, previousRevision),
    );
    await az(stopWorkerExecutionsCommand(resourceGroup, workerJobName));
    await cutover.requeueRunningJobs();
    await smoke(`https://${appFqdn}`, "promoted");

    await az(workerImageCommand(resourceGroup, workerJobName, candidateImage));
    const candidateWorker = await az([
      "containerapp",
      "job",
      "show",
      "--resource-group",
      resourceGroup,
      "--name",
      workerJobName,
    ]);
    assertContainerVersion(candidateWorker, "worker", candidateImage);
    state.candidateWorkerActivated = true;
    writeState(state);
    // Close the schedule race: any execution created from the retired worker
    // template before the update is stopped before claims are reopened.
    await az(stopWorkerExecutionsCommand(resourceGroup, workerJobName));
    await cutover.setClaimsEnabled(true);
    state.claimsEnabled = true;
    writeState(state);

    return {
      previousRevision,
      candidateRevision,
      previousAppImage,
      previousWorkerImage,
      promoted: true,
    };
  } catch (error) {
    if (cutoverStarted) {
      try {
        await restoreStableDeployment(
          { appResource: app },
          state,
          { ...runtime, az, smoke, cutover },
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Release failed and the gated stable rollback also failed.",
        );
      }
    } else if (candidateRevision) {
      // Candidate validation failed before the writer cutover began. Keep the
      // serving stable revision explicit and leave its active workers alone.
      await az(
        trafficCommand(
          resourceGroup,
          appName,
          previousRevision,
          candidateRevision,
        ),
      );
    }
    throw error;
  }
}

export async function rollbackContainerAppFromState(state, runtime = {}) {
  if (state.cutoverStarted === false) {
    const resourceGroup = required(state.resourceGroup, "state.resourceGroup");
    const appName = required(state.appName, "state.appName");
    const previousRevision = required(
      state.previousRevision,
      "state.previousRevision",
    );
    const candidateRevision = state.candidateRevision?.trim();
    const az = runtime.az ?? defaultAz;
    await az(
      trafficCommand(
        resourceGroup,
        appName,
        previousRevision,
        candidateRevision,
      ),
    );
    if (candidateRevision && candidateRevision !== previousRevision) {
      await az(
        revisionCommand(
          "deactivate",
          resourceGroup,
          appName,
          candidateRevision,
        ),
      );
    }
    return;
  }
  await restoreStableDeployment({}, state, runtime);
}

async function main() {
  if (process.argv[2] === "--rollback-state") {
    const statePath = required(process.argv[3], "rollback state path");
    await rollbackContainerAppFromState(
      JSON.parse(readFileSync(statePath, "utf8")),
    );
    console.log(JSON.stringify({ rollout: "rolled_back" }));
    return;
  }
  const result = await rolloutContainerApp({
    resourceGroup: process.env.RESOURCE_GROUP,
    appName: process.env.CONTAINER_APP,
    workerJobName:
      process.env.PROJECT_JOB_WORKER_APP ||
      `${process.env.CONTAINER_APP}-project-job-worker`,
    candidateImage: process.env.CANDIDATE_IMAGE,
    revisionSuffix: process.env.REVISION_SUFFIX,
    minReplicas: process.env.MIN_REPLICAS,
    stateFile: process.env.ROLLOUT_STATE_FILE,
  });
  console.log(
    JSON.stringify({
      rollout: "promoted",
      previous_revision: result.previousRevision,
      candidate_revision: result.candidateRevision,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
