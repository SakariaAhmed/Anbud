import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createDataApiCutoverRuntime,
  createSupabaseCutoverRuntime,
  rollbackContainerAppFromState,
  rolloutContainerApp,
} from "./azure_containerapp_rollout.mjs";

function fixtureRuntime({
  failCandidate = false,
  failPromoted = false,
  frozenIngress = false,
  unhealthyCandidate = false,
  staleCandidateVersion = false,
  staleWorkerVersion = false,
  staleZeroTrafficRevisions = [],
} = {}) {
  const calls = [];
  const cutoverCalls = [];
  const smokes = [];
  const events = [];
  const states = [];
  const app = {
    properties: {
      latestReadyRevisionName: "anbud--stable",
      configuration: {
        ingress: {
          external: !frozenIngress,
          fqdn: frozenIngress
            ? "app.internal.example.test"
            : "app.example.test",
        },
      },
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
  let candidateIsServing = false;
  const worker = {
    properties: {
      template: {
        containers: [
          {
            name: "worker",
            image: "registry/app:stable",
            env: [{ name: "APP_VERSION", value: "registry/app:stable" }],
          },
        ],
      },
    },
  };

  return {
    calls,
    cutoverCalls,
    smokes,
    events,
    states,
    writeState(state) {
      states.push(structuredClone(state));
    },
    async wait() {},
    async az(args) {
      calls.push(args);
      const command = args.join(" ");
      events.push(`az:${command}`);
      if (command.startsWith("containerapp show ")) return app;
      if (command.startsWith("containerapp revision list ")) {
        if (!candidateIsServing) return revisions;
        return [
          {
            name: "anbud--candidate",
            active: true,
            trafficWeight: 100,
          },
          {
            name: "anbud--stable",
            active: true,
            trafficWeight: 0,
          },
          ...staleZeroTrafficRevisions,
        ];
      }
      if (command.startsWith("containerapp job show ")) return worker;
      if (command.startsWith("containerapp update ")) {
        return { properties: { latestRevisionName: "anbud--candidate" } };
      }
      if (command.startsWith("containerapp revision show ")) {
        const stable = command.includes("--revision anbud--stable");
        const image =
          stable || staleCandidateVersion
            ? "registry/app:stable"
            : "registry/app:candidate";
        return {
          properties: {
            healthState:
              !stable && unhealthyCandidate ? "Unhealthy" : "Healthy",
            provisioningState: "Provisioned",
            replicas: 0,
            runningState: "ScaledToZero",
            fqdn: stable
              ? "stable.example.test"
              : "candidate.example.test",
            template: {
              containers: [
                {
                  name: "web",
                  image,
                  env: [{ name: "APP_VERSION", value: image }],
                },
              ],
            },
          },
        };
      }
      if (command.startsWith("containerapp job update ")) {
        const image = args[args.indexOf("--image") + 1];
        const version = staleWorkerVersion
          ? worker.properties.template.containers[0].env[0].value
          : image;
        worker.properties.template.containers[0] = {
          name: "worker",
          image,
          env: [{ name: "APP_VERSION", value: version }],
        };
        return worker;
      }
      if (
        command.startsWith("containerapp ingress traffic set ") &&
        command.includes("anbud--candidate=100")
      ) {
        candidateIsServing = true;
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

test("Azure cutover client uses the explicit PostgREST root without Supabase paths", async () => {
  const calls = [];
  const cutover = createDataApiCutoverRuntime({
    dataApiUrl: "https://anbud-postgrest.internal/",
    serviceRoleKey: "synthetic-azure-key",
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            version: "project-job-cutover-v1",
            claims_enabled: false,
          };
        },
      };
    },
  });

  await cutover.setClaimsEnabled(false);
  assert.equal(
    calls[0].url,
    "https://anbud-postgrest.internal/rpc/set_project_job_claims_enabled",
  );
  assert.equal(
    calls[0].options.headers.authorization,
    "Bearer synthetic-azure-key",
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

test("candidate version mismatch fails before traffic or claims change", async () => {
  const runtime = fixtureRuntime({ staleCandidateVersion: true });
  await assert.rejects(
    rolloutContainerApp(config, runtime),
    /image\/version metadata did not reach/u,
  );
  assert.deepEqual(runtime.cutoverCalls, []);
  assert.equal(runtime.smokes.length, 0);
  assert.match(
    matchingCalls(runtime, "containerapp ingress traffic set").at(-1),
    /anbud--stable=100.*anbud--candidate=0/u,
  );
});

test("worker version mismatch rolls back before claims reopen", async () => {
  const runtime = fixtureRuntime({ staleWorkerVersion: true });
  await assert.rejects(
    rolloutContainerApp(config, runtime),
    /image\/version metadata did not reach/u,
  );
  assert.equal(
    runtime.cutoverCalls.at(-1)?.enabled,
    true,
    "stable claims reopen only after rollback completes",
  );
  assert.match(
    matchingCalls(runtime, "containerapp ingress traffic set").at(-1),
    /anbud--stable=100.*anbud--candidate=0/u,
  );
});

test("successful candidate gates claims and retires old writers before promotion", async () => {
  const runtime = fixtureRuntime();
  const result = await rolloutContainerApp(config, runtime);

  assert.equal(result.promoted, true);
  assert.deepEqual(result.retiredRevisions, ["anbud--stable"]);
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
  assert.match(
    matchingCalls(runtime, "containerapp update").at(-1),
    /--set-env-vars APP_VERSION=registry\/app:candidate/u,
  );
  assert.match(
    matchingCalls(runtime, "containerapp job update").at(-1),
    /--set-env-vars APP_VERSION=registry\/app:candidate/u,
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

test("frozen Azure promotion keeps public ingress and source claims closed", async () => {
  const runtime = fixtureRuntime({ frozenIngress: true });
  const result = await rolloutContainerApp(
    { ...config, minReplicas: 0, frozenIngressMode: true },
    runtime,
  );

  assert.equal(result.promoted, true);
  assert.deepEqual(runtime.smokes, []);
  assert.deepEqual(runtime.cutoverCalls, [
    { operation: "claims", enabled: false },
    { operation: "requeue" },
  ]);
  assert.equal(runtime.states.at(-1)?.claimsEnabled, false);
  assert.equal(runtime.states.at(-1)?.sourceClaimsKeptClosed, true);
  assert.equal(runtime.states.at(-1)?.frozenIngressMode, true);
  assert.match(
    matchingCalls(runtime, "containerapp update").at(-1),
    /--min-replicas 0/u,
  );
  assert.equal(
    matchingCalls(runtime, "containerapp ingress enable").length,
    0,
  );
});

test("frozen Azure promotion fails before cutover on unhealthy revision state", async () => {
  const runtime = fixtureRuntime({
    frozenIngress: true,
    unhealthyCandidate: true,
  });
  await assert.rejects(
    rolloutContainerApp({ ...config, frozenIngressMode: true }, runtime),
    /failed management-plane readiness/u,
  );
  assert.deepEqual(runtime.cutoverCalls, []);
  assert.deepEqual(runtime.smokes, []);
  assert.match(
    matchingCalls(runtime, "containerapp ingress traffic set").at(-1),
    /anbud--stable=100.*anbud--candidate=0/u,
  );
});

test(
  "frozen Azure rollout rejects any externally reachable web ingress",
  async () => {
    const runtime = fixtureRuntime();
    await assert.rejects(
      rolloutContainerApp({ ...config, frozenIngressMode: true }, runtime),
      /requires internal-only Container App ingress/u,
    );
    assert.deepEqual(runtime.cutoverCalls, []);
    assert.equal(matchingCalls(runtime, "containerapp update").length, 0);
  },
);

test(
  "frozen Azure rollback leaves source claims and worker closed for backend reconcile",
  async () => {
    const runtime = fixtureRuntime({
      frozenIngress: true,
      staleWorkerVersion: true,
    });
    await assert.rejects(
      rolloutContainerApp(
        { ...config, frozenIngressMode: true },
        runtime,
      ),
      /image\/version metadata did not reach/u,
    );

    assert.deepEqual(runtime.smokes, []);
    assert.deepEqual(runtime.cutoverCalls, [
      { operation: "claims", enabled: false },
      { operation: "requeue" },
      { operation: "claims", enabled: false },
      { operation: "prepare-stable" },
    ]);
    assert.equal(
      runtime.cutoverCalls.some(
        (call) => call.operation === "claims" && call.enabled === true,
      ),
      false,
    );
  },
);

test("successful promotion deactivates every active revision without traffic", async () => {
  const runtime = fixtureRuntime({
    staleZeroTrafficRevisions: [
      {
        name: "anbud--older-candidate",
        active: true,
        trafficWeight: 0,
      },
      {
        name: "anbud--inactive",
        active: false,
        trafficWeight: 0,
      },
      {
        name: "anbud--canary",
        active: true,
        trafficWeight: 5,
      },
      {
        name: "anbud--nested-zero",
        properties: {
          active: true,
          trafficWeight: "0",
        },
      },
      {
        name: "anbud--unknown-traffic",
        active: true,
      },
      {
        name: "anbud--invalid-traffic",
        active: true,
        trafficWeight: "unknown",
      },
    ],
  });

  const result = await rolloutContainerApp(config, runtime);

  assert.deepEqual(result.retiredRevisions, [
    "anbud--stable",
    "anbud--older-candidate",
    "anbud--nested-zero",
  ]);
  assert.deepEqual(
    matchingCalls(runtime, "containerapp revision deactivate"),
    [
      "containerapp revision deactivate --resource-group anbud-prod --name anbud --revision anbud--stable",
      "containerapp revision deactivate --resource-group anbud-prod --name anbud --revision anbud--older-candidate",
      "containerapp revision deactivate --resource-group anbud-prod --name anbud --revision anbud--nested-zero",
    ],
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
  assert.match(
    workerUpdates.at(-1),
    /--set-env-vars APP_VERSION=registry\/app:stable/u,
  );
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
      previousAppImage: "registry/app:stable",
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
  assert.match(
    matchingCalls(runtime, "containerapp job update").at(-1),
    /--set-env-vars APP_VERSION=registry\/app:stable/u,
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

test("Azure workflow preserves frozen fail-closed activation", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-azure.yml", import.meta.url),
    "utf8",
  );
  const bicep = readFileSync(
    new URL("../infra/azure/container-app.bicep", import.meta.url),
    "utf8",
  );

  assert.match(bicep, /param externalIngressEnabled bool = true/u);
  assert.match(bicep, /external:\s*externalIngressEnabled/u);
  assert.match(workflow, /externalIngressEnabled="\$external_ingress_enabled"/u);
  assert.match(workflow, /FROZEN_INGRESS_ROLLOUT:/u);
  assert.match(workflow, /KEEP_SOURCE_CLAIMS_CLOSED_ON_SUCCESS:/u);
  const ingressProof = workflow.indexOf(
    "name: Prove public web ingress is frozen",
  );
  const sourceProof = workflow.indexOf(
    "name: Prove frozen Supabase source has zero running jobs",
  );
  assert.ok(ingressProof > 0 && ingressProof < sourceProof);
  const ingressProofStep = workflow.slice(ingressProof, sourceProof);
  assert.match(ingressProofStep, /ingress\.external/u);
  assert.match(ingressProofStep, /probe_status/u);
  assert.match(ingressProofStep, /negative external probe/u);

  const uncertainStart = workflow.indexOf(
    "name: Stop on uncertain target activation",
  );
  const publicStart = workflow.indexOf(
    "name: Open public ingress and smoke Azure candidate",
  );
  assert.ok(uncertainStart > 0 && publicStart > uncertainStart);
  const uncertainStep = workflow.slice(uncertainStart, publicStart);
  assert.match(uncertainStep, /steps\.activate_target\.outcome != 'success'/u);
  assert.match(uncertainStep, /--type internal/u);
  assert.doesNotMatch(uncertainStep, /--rollback-state/u);
  assert.doesNotMatch(uncertainStep, /SUPABASE_SERVICE_ROLE_KEY/u);

  const fallbackStart = workflow.indexOf("name: Fallback rollback");
  const restoreStart = workflow.indexOf(
    "name: Restore scheduled worker after completed release",
  );
  const fallbackStep = workflow.slice(fallbackStart, restoreStart);
  assert.match(fallbackStep, /steps\.rollout\.outcome == 'failure'/u);
  assert.doesNotMatch(fallbackStep, /steps\.activate_target\.outcome/u);
  assert.doesNotMatch(fallbackStep, /--cron-expression/u);
  assert.match(fallbackStep, /Reconcile and verify the Supabase backend/u);

  const restoreStep = workflow.slice(restoreStart);
  assert.match(restoreStep, /steps\.public_smoke\.outcome == 'success'/u);
  assert.match(restoreStep, /--cron-expression/u);
});
