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

function resourceFqdn(resource) {
  return required(
    resource?.properties?.configuration?.ingress?.fqdn,
    "Container App FQDN",
  );
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
  const previousAppImage = containerImage(app, "web");
  const previousWorkerImage = containerImage(worker, "worker");
  const appFqdn = resourceFqdn(app);
  let candidateRevision = "";
  let workerUpdated = false;
  let promoted = false;
  const state = {
    resourceGroup,
    appName,
    workerJobName,
    previousRevision,
    previousWorkerImage,
    candidateRevision,
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
    const updated = await az([
      "containerapp",
      "update",
      "--resource-group",
      resourceGroup,
      "--name",
      appName,
      "--image",
      candidateImage,
      "--revision-suffix",
      revisionSuffix,
      "--min-replicas",
      minReplicas,
    ]);
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
    const candidateFqdn = required(
      candidate?.properties?.fqdn ?? candidate?.fqdn,
      "candidate revision FQDN",
    );
    await smoke(`https://${candidateFqdn}`, "candidate");

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
      `${candidateRevision}=100`,
      `${previousRevision}=0`,
    ]);
    promoted = true;

    await az([
      "containerapp",
      "job",
      "update",
      "--resource-group",
      resourceGroup,
      "--name",
      workerJobName,
      "--image",
      candidateImage,
    ]);
    workerUpdated = true;
    writeState(state);
    await smoke(`https://${appFqdn}`, "promoted");

    return {
      previousRevision,
      candidateRevision,
      previousAppImage,
      previousWorkerImage,
      promoted: true,
    };
  } catch (error) {
    const rollbackErrors = [];
    if (candidateRevision) {
      try {
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
          `${candidateRevision}=0`,
        ]);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (workerUpdated || promoted) {
      try {
        await az([
          "containerapp",
          "job",
          "update",
          "--resource-group",
          resourceGroup,
          "--name",
          workerJobName,
          "--image",
          previousWorkerImage,
        ]);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Release failed and one or more rollback operations also failed.",
      );
    }
    throw error;
  }
}

export async function rollbackContainerAppFromState(state, runtime = {}) {
  const az = runtime.az ?? defaultAz;
  const resourceGroup = required(state.resourceGroup, "state.resourceGroup");
  const appName = required(state.appName, "state.appName");
  const workerJobName = required(state.workerJobName, "state.workerJobName");
  const previousRevision = required(
    state.previousRevision,
    "state.previousRevision",
  );
  const previousWorkerImage = required(
    state.previousWorkerImage,
    "state.previousWorkerImage",
  );
  const candidateRevision = state.candidateRevision?.trim();

  if (candidateRevision) {
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
      `${candidateRevision}=0`,
    ]);
  } else {
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
  }
  await az([
    "containerapp",
    "job",
    "update",
    "--resource-group",
    resourceGroup,
    "--name",
    workerJobName,
    "--image",
    previousWorkerImage,
  ]);
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
