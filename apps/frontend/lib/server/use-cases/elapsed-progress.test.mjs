import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const jiti = createJiti(path.join(frontendRoot, "elapsed-progress-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const { formatElapsedSeconds, runWithElapsedProgress } = await jiti.import(
  path.join(frontendRoot, "lib/server/use-cases/elapsed-progress.ts"),
);
const { parseJobProgress } = await jiti.import(path.join(frontendRoot, "lib/project-job-progress.ts"));

function fakeTimers() {
  let clock = 0;
  const intervals = new Map();
  let nextHandle = 0;
  return {
    timers: {
      now: () => clock,
      setInterval(callback, intervalMs) {
        nextHandle += 1;
        intervals.set(nextHandle, { callback, intervalMs });
        return nextHandle;
      },
      clearInterval(handle) { intervals.delete(handle); },
    },
    tick(ms) {
      clock += ms;
      for (const { callback } of [...intervals.values()]) callback();
    },
    active: () => intervals.size,
  };
}

const options = {
  label: "Analyserer kundedokumentet med AI",
  slowLabel: "AI-analysen tar lengre tid enn vanlig, men pågår fortsatt",
  startPercent: 58,
  ceiling: 88,
  expectedMs: 150_000,
  intervalMs: 10_000,
};

test("a long AI step reports elapsed time and rising progress below its ceiling", async () => {
  const clock = fakeTimers();
  const messages = [];
  let finish;
  const pending = runWithElapsedProgress(
    { ...options, onProgress: (message) => messages.push(message), timers: clock.timers },
    () => new Promise((resolve) => { finish = resolve; }),
  );

  for (let second = 10; second <= 200; second += 10) clock.tick(10_000);
  finish("analysis");
  assert.equal(await pending, "analysis");
  assert.equal(clock.active(), 0, "the ticker is cleared when the step ends");

  const parsed = messages.map(parseJobProgress);
  assert.equal(parsed.length, 21);
  assert.equal(parsed[0].label, "Analyserer kundedokumentet med AI (0 s)");
  assert.equal(parsed[0].percent, 58);
  assert.equal(parsed[6].label, "Analyserer kundedokumentet med AI (1 min 00 s)");
  assert.equal(parsed[20].label, "AI-analysen tar lengre tid enn vanlig, men pågår fortsatt (3 min 20 s)");
  assert.ok(parsed.every((entry) => entry.ceiling === 88 && entry.percent < 88));
  assert.ok(parsed.every((entry, index) => index === 0 || entry.percent >= parsed[index - 1].percent));
  assert.ok(parsed[15].percent > parsed[1].percent, "progress moves during the step");
});

test("a progress write rejected after cancellation stops the ticker without failing the step", async () => {
  const clock = fakeTimers();
  let writes = 0;
  let finish;
  const pending = runWithElapsedProgress(
    {
      ...options,
      timers: clock.timers,
      onProgress() {
        writes += 1;
        if (writes > 1) throw new Error("Prosjektjobben ble avbrutt.");
      },
    },
    () => new Promise((resolve) => { finish = resolve; }),
  );

  clock.tick(10_000);
  assert.equal(clock.active(), 0);
  clock.tick(10_000);
  assert.equal(writes, 2);
  finish("done");
  assert.equal(await pending, "done");
});

test("the ticker is cleared when the step fails", async () => {
  const clock = fakeTimers();
  await assert.rejects(
    runWithElapsedProgress(
      { ...options, onProgress: () => {}, timers: clock.timers },
      async () => { throw new Error("AI-kallet feilet"); },
    ),
    /AI-kallet feilet/u,
  );
  assert.equal(clock.active(), 0);
});

test("without a progress sink the step runs without timers", async () => {
  const clock = fakeTimers();
  assert.equal(await runWithElapsedProgress({ ...options, timers: clock.timers }, async () => 7), 7);
  assert.equal(clock.active(), 0);
});

test("elapsed time reads naturally in Norwegian", () => {
  assert.equal(formatElapsedSeconds(4_400), "4 s");
  assert.equal(formatElapsedSeconds(126_000), "2 min 06 s");
});
