import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url);
const { readClientCache, setClientCache, clearClientCache } = jiti(
  fileURLToPath(new URL("./client-cache.ts", import.meta.url)),
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("an invalidated read cannot restore stale data or detach its replacement", async () => {
  const stale = deferred();
  const current = deferred();
  const oldRead = readClientCache("invalidate:project", () => stale.promise, 1000);
  clearClientCache("invalidate:");
  const newRead = readClientCache("invalidate:project", () => current.promise, 1000);
  stale.resolve("old");
  assert.equal(await oldRead, "old");
  const joined = readClientCache("invalidate:project", () => assert.fail("must join current read"), 1000);
  current.resolve("new");
  assert.deepEqual(await Promise.all([newRead, joined]), ["new", "new"]);
  assert.equal(await readClientCache("invalidate:project", () => assert.fail("must use cache"), 1000), "new");
});

test("a forced refresh supersedes an older read", async () => {
  const stale = deferred();
  const oldRead = readClientCache("refresh", () => stale.promise, 1000);
  assert.equal(await readClientCache("refresh", async () => "new", 1000, { forceRefresh: true }), "new");
  stale.resolve("old");
  await oldRead;
  assert.equal(await readClientCache("refresh", () => assert.fail("must use refreshed cache"), 1000), "new");
});

test("a saved value supersedes an in-flight read", async () => {
  const stale = deferred();
  const oldRead = readClientCache("saved", () => stale.promise, 1000);
  setClientCache("saved", "saved value", 1000);
  stale.resolve("old");
  await oldRead;
  assert.equal(await readClientCache("saved", () => assert.fail("must use saved value"), 1000), "saved value");
});

test("cancelling a subscriber leaves the shared prefetch available", async () => {
  const pending = deferred();
  const prefetched = readClientCache("abort", () => pending.promise, 1000);
  const controller = new AbortController();
  const subscriber = readClientCache("abort", () => assert.fail("must join prefetch"), 1000, { signal: controller.signal });
  controller.abort();
  await assert.rejects(subscriber, { name: "AbortError" });
  pending.resolve(null);
  assert.equal(await prefetched, null);
  assert.equal(await readClientCache("abort", () => assert.fail("null is a cache hit"), 1000), null);
  await assert.rejects(readClientCache("abort", () => assert.fail("already aborted"), 1000, { signal: controller.signal }), { name: "AbortError" });
});

test("failed and expired reads can be retried", async () => {
  await assert.rejects(readClientCache("retry", async () => { throw new Error("offline"); }, 1000), /offline/);
  assert.equal(await readClientCache("retry", async () => "recovered", -1), "recovered");
  assert.equal(await readClientCache("retry", async () => "fresh", 1000), "fresh");
});
