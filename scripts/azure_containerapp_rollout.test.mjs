import assert from "node:assert/strict";
import test from "node:test";

import {
  rollbackContainerAppFromState,
  rolloutContainerApp,
} from "./azure_containerapp_rollout.mjs";

function fixtureRuntime({ failCandidate = false, failPromoted = false } = {}) {
  const calls = [];
  const smokes = [];
  const app = {
    properties: {
      latestReadyRevisionName: "anbud--stable",
      configuration: { ingress: { fqdn: "app.example.test" } },
      template: { containers: [{ name: "web", image: "registry/app:stable" }] },
    },
  };
  const revisions = [
    {
      name: "anbud--stable",
      healthState: "Healthy",
      provisioningState: "Provisioned",
      trafficWeight: 100,
      createdTime: "2026-07-10T07:00:00Z",
    },
  ];
  const worker = {
    properties: {
      template: {
        containers: [{ name: "worker", image: "registry/app:stable" }],
      },
    },
  };

  return {
    calls,
    smokes,
    async az(args) {
      calls.push(args);
      const command = args.join(" ");
      if (command.startsWith("containerapp show ")) return app;
      if (command.startsWith("containerapp revision list ")) return revisions;
      if (command.startsWith("containerapp job show ")) return worker;
      if (command.startsWith("containerapp update ")) {
        return { properties: { latestRevisionName: "anbud--candidate" } };
      }
      if (command.startsWith("containerapp revision show ")) {
        return { properties: { fqdn: "candidate.example.test" } };
      }
      return {};
    },
    async smoke(url, phase) {
      smokes.push({ url, phase });
      if (
        (phase === "candidate" && failCandidate) ||
        (phase === "promoted" && failPromoted)
      ) {
        throw new Error(`${phase} smoke failed`);
      }
    },
  };
}

const config = {
  resourceGroup: "anbud-prod",
  appName: "anbud",
  workerJobName: "anbud-project-job-worker",
  candidateImage: "registry/app:candidate",
  revisionSuffix: "sha123",
  minReplicas: 1,
};

function matchingCalls(runtime, prefix) {
  return runtime.calls
    .map((args) => args.join(" "))
    .filter((command) => command.startsWith(prefix));
}

test("candidate smoke failure keeps the healthy revision at 100 percent", async () => {
  const runtime = fixtureRuntime({ failCandidate: true });
  await assert.rejects(
    rolloutContainerApp(config, runtime),
    /candidate smoke failed/u,
  );

  const traffic = matchingCalls(
    runtime,
    "containerapp ingress traffic set",
  );
  assert.match(traffic.at(-1), /anbud--stable=100/u);
  assert.match(traffic.at(-1), /anbud--candidate=0/u);
  assert.equal(
    matchingCalls(runtime, "containerapp job update").length,
    0,
  );
});

test("successful candidate promotes traffic and then updates the worker", async () => {
  const runtime = fixtureRuntime();
  const result = await rolloutContainerApp(config, runtime);

  assert.equal(result.promoted, true);
  assert.deepEqual(runtime.smokes, [
    { url: "https://candidate.example.test", phase: "candidate" },
    { url: "https://app.example.test", phase: "promoted" },
  ]);
  const traffic = matchingCalls(
    runtime,
    "containerapp ingress traffic set",
  );
  assert.match(traffic.at(-1), /anbud--candidate=100/u);
  assert.match(traffic.at(-1), /anbud--stable=0/u);
  assert.match(
    matchingCalls(runtime, "containerapp job update").at(-1),
    /registry\/app:candidate/u,
  );
});

test("post-promotion smoke failure restores traffic and worker image", async () => {
  const runtime = fixtureRuntime({ failPromoted: true });
  await assert.rejects(
    rolloutContainerApp(config, runtime),
    /promoted smoke failed/u,
  );

  const traffic = matchingCalls(
    runtime,
    "containerapp ingress traffic set",
  );
  assert.match(traffic.at(-1), /anbud--stable=100/u);
  assert.match(traffic.at(-1), /anbud--candidate=0/u);
  const workerUpdates = matchingCalls(runtime, "containerapp job update");
  assert.match(workerUpdates[0], /registry\/app:candidate/u);
  assert.match(workerUpdates.at(-1), /registry\/app:stable/u);
});

test("workflow fallback rollback is idempotent from safe state metadata", async () => {
  const runtime = fixtureRuntime();
  await rollbackContainerAppFromState(
    {
      resourceGroup: "anbud-prod",
      appName: "anbud",
      workerJobName: "anbud-project-job-worker",
      previousRevision: "anbud--stable",
      previousWorkerImage: "registry/app:stable",
      candidateRevision: "anbud--candidate",
    },
    runtime,
  );
  assert.match(
    matchingCalls(runtime, "containerapp ingress traffic set").at(-1),
    /anbud--stable=100.*anbud--candidate=0/u,
  );
  assert.match(
    matchingCalls(runtime, "containerapp job update").at(-1),
    /registry\/app:stable/u,
  );
});
