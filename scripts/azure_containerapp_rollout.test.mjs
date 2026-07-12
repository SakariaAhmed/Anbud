import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createSupabaseCutoverRuntime,
  rollbackContainerAppFromState,
  rolloutContainerApp,
} from "./azure_containerapp_rollout.mjs";

function fixtureRuntime({ failCandidate = false, failPromoted = false } = {}) {
  const calls = [];
  const cutoverCalls = [];
  const smokes = [];
  const events = [];
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
    cutoverCalls,
    smokes,
    events,
    async az(args) {
      calls.push(args);
      const command = args.join(" ");
      events.push(`az:${command}`);
      if (command.startsWith("containerapp show ")) return app;
      if (command.startsWith("containerapp revision list ")) return revisions;
      if (command.startsWith("containerapp job show ")) return worker;
      if (command.startsWith("containerapp update ")) {
        return { properties: { latestRevisionName: "anbud--candidate" } };
      }
      if (command.startsWith("containerapp revision show ")) {
        return {
          properties: {
            fqdn: command.includes("--revision anbud--stable")
              ? "stable.example.test"
              : "candidate.example.test",
          },
        };
      }
      return {};
    },
    async smoke(url, phase) {
      smokes.push({ url, phase });
      events.push(`smoke:${phase}`);
      if (
        (phase === "candidate" && failCandidate) ||
        (phase === "promoted" && failPromoted)
      ) {
        throw new Error(`${phase} smoke failed`);
      }
    },
    cutover: {
      async setClaimsEnabled(enabled) {
        cutoverCalls.push({ operation: "claims", enabled });
        events.push(`cutover:claims:${enabled}`);
        return {
          version: "project-job-cutover-v1",
          claims_enabled: enabled,
        };
      },
      async requeueRunningJobs() {
        cutoverCalls.push({ operation: "requeue" });
        events.push("cutover:requeue");
        return { version: "project-job-cutover-v1", requeued_jobs: 0 };
      },
      async prepareStableRollback() {
        cutoverCalls.push({ operation: "prepare-stable" });
        events.push("cutover:prepare-stable");
        return {
          version: "project-job-cutover-v1",
          requeued_jobs: 0,
          cleared_encrypted_results: 0,
        };
      },
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

test("rollout claim-gate argument matches the deployed SQL signature", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260712131500_stable_main_rollback_bridge.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const rolloutSource = readFileSync(
    new URL("./azure_containerapp_rollout.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    migration,
    /function public\.set_project_job_claims_enabled\(\s*p_claims_enabled boolean\s*\)/u,
  );
  assert.match(rolloutSource, /p_claims_enabled: enabled/u);
  assert.doesNotMatch(rolloutSource, /p_enabled: enabled/u);
});

test("Supabase cutover client is project-bound, versioned, and fail-closed", async () => {
  const calls = [];
  const cutover = createSupabaseCutoverRuntime({
    supabaseUrl: "https://expected.supabase.co",
    serviceRoleKey: "synthetic-service-key",
    expectedProjectRef: "expected",
    async fetchImpl(url, options) {
      calls.push({ url, options });
      const claimsEnabled = JSON.parse(options.body).p_claims_enabled;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            version: "project-job-cutover-v1",
            ...(url.pathname.endsWith("set_project_job_claims_enabled")
              ? { claims_enabled: claimsEnabled }
              : {}),
          };
        },
      };
    },
  });

  await cutover.setClaimsEnabled(false);
  await cutover.requeueRunningJobs();
  await cutover.prepareStableRollback();
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    [
      "/rest/v1/rpc/set_project_job_claims_enabled",
      "/rest/v1/rpc/requeue_project_jobs_for_cutover",
      "/rest/v1/rpc/prepare_stable_main_rollback",
    ],
  );
  assert.equal(calls[0].options.method, "POST");
  assert.equal(
    calls[0].options.headers.authorization,
    "Bearer synthetic-service-key",
  );
  assert.equal(calls[0].options.body, '{"p_claims_enabled":false}');

  assert.throws(
    () =>
      createSupabaseCutoverRuntime({
        supabaseUrl: "https://wrong.supabase.co",
        serviceRoleKey: "synthetic-service-key",
        expectedProjectRef: "expected",
      }),
    /does not match SUPABASE_PROJECT_REF/u,
  );

  const wrongVersion = createSupabaseCutoverRuntime({
    supabaseUrl: "https://expected.supabase.co",
    serviceRoleKey: "synthetic-service-key",
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        async json() {
          return { version: "unexpected", claims_enabled: false };
        },
      };
    },
  });
  await assert.rejects(
    wrongVersion.setClaimsEnabled(false),
    /unexpected cutover version/u,
  );
});

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
  assert.deepEqual(runtime.cutoverCalls, []);
});

test("successful candidate gates claims and retires old writers before promotion", async () => {
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
  assert.equal(
    matchingCalls(runtime, "containerapp job stop").length,
    2,
    "worker executions are stopped before drain and again after template cutover",
  );
  assert.deepEqual(runtime.cutoverCalls, [
    { operation: "claims", enabled: false },
    { operation: "requeue" },
    { operation: "claims", enabled: true },
  ]);
  const eventIndex = (prefix) =>
    runtime.events.findIndex((event) => event.startsWith(prefix));
  assert.ok(
    eventIndex("cutover:claims:false") <
      eventIndex("az:containerapp ingress traffic set --resource-group anbud-prod --name anbud --revision-weight anbud--candidate=100"),
    "claims must close before candidate traffic is enabled",
  );
  assert.ok(
    eventIndex("az:containerapp ingress traffic set --resource-group anbud-prod --name anbud --revision-weight anbud--candidate=100") <
      eventIndex("az:containerapp revision deactivate "),
    "the pre-smoked candidate must serve before the stable revision is retired",
  );
  assert.ok(
    eventIndex("az:containerapp revision deactivate ") <
      eventIndex("az:containerapp job stop "),
    "stable web replicas must stop before worker executions are drained",
  );
  assert.ok(
    eventIndex("az:containerapp job stop ") < eventIndex("cutover:requeue"),
    "running rows must only be requeued after every old worker is stopped",
  );
  assert.ok(
    eventIndex("cutover:requeue") < eventIndex("smoke:promoted"),
    "promoted smoke runs only after retired jobs are requeued",
  );
  assert.ok(
    runtime.events.indexOf("smoke:promoted") <
      eventIndex("az:containerapp job update "),
    "the candidate worker must stay inactive until promoted web is healthy",
  );
  assert.ok(
    eventIndex("az:containerapp job update ") <
      eventIndex("cutover:claims:true"),
    "claims open only after both candidate web and worker are installed",
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
  assert.equal(
    workerUpdates.filter((command) => /registry\/app:candidate/u.test(command))
      .length,
    0,
    "a failed promoted-web smoke must never activate the candidate worker",
  );
  assert.match(workerUpdates.at(-1), /registry\/app:stable/u);
  assert.equal(matchingCalls(runtime, "containerapp job stop").length, 3);
  assert.deepEqual(runtime.cutoverCalls, [
    { operation: "claims", enabled: false },
    { operation: "requeue" },
    { operation: "claims", enabled: false },
    { operation: "prepare-stable" },
    { operation: "claims", enabled: true },
  ]);
  assert.deepEqual(runtime.smokes, [
    { url: "https://candidate.example.test", phase: "candidate" },
    { url: "https://app.example.test", phase: "promoted" },
    { url: "https://stable.example.test", phase: "rollback-candidate" },
    { url: "https://app.example.test", phase: "rollback-promoted" },
  ]);
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
      cutoverStarted: true,
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
  assert.deepEqual(runtime.cutoverCalls, [
    { operation: "claims", enabled: false },
    { operation: "prepare-stable" },
    { operation: "claims", enabled: true },
  ]);
  assert.equal(matchingCalls(runtime, "containerapp job stop").length, 2);
  const stopIndex = runtime.events.findIndex((event) =>
    event.startsWith("az:containerapp job stop "),
  );
  const prepareIndex = runtime.events.indexOf("cutover:prepare-stable");
  const trafficIndex = runtime.events.findIndex((event) =>
    event.includes("--revision-weight anbud--stable=100"),
  );
  const deactivateIndex = runtime.events.findIndex((event) =>
    event.startsWith("az:containerapp revision deactivate "),
  );
  assert.ok(
    trafficIndex < deactivateIndex &&
      deactivateIndex < stopIndex &&
      stopIndex < prepareIndex,
  );
});

test("pre-cutover fallback never requeues work owned by the serving stable revision", async () => {
  const runtime = fixtureRuntime();
  await rollbackContainerAppFromState(
    {
      resourceGroup: "anbud-prod",
      appName: "anbud",
      workerJobName: "anbud-project-job-worker",
      previousRevision: "anbud--stable",
      previousWorkerImage: "registry/app:stable",
      candidateRevision: "anbud--candidate",
      cutoverStarted: false,
    },
    runtime,
  );

  assert.deepEqual(runtime.cutoverCalls, []);
  assert.equal(matchingCalls(runtime, "containerapp job stop").length, 0);
  assert.equal(matchingCalls(runtime, "containerapp job update").length, 0);
  assert.match(
    matchingCalls(runtime, "containerapp ingress traffic set").at(-1),
    /anbud--stable=100.*anbud--candidate=0/u,
  );
  assert.equal(
    matchingCalls(runtime, "containerapp revision deactivate").length,
    1,
  );
});
