import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import fixtures from "./rag_embedding_fixtures.cjs";

const { createFixtureStore, encodeVector, decodeVector, inputKey } = fixtures;
const model = "text-embedding-3-small";
const parameters = input => ({ model, input, encoding_format: "float" });
function directory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "rag-embedding-fixtures-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "vectors.json");
}

test("recording preserves input order and replay uses only persisted real responses", async t => {
  const file = directory(t);
  let calls = 0;
  const record = createFixtureStore({ file, model, dimensions: 2, record: true,
    request: async request => {
      calls++;
      assert.deepEqual(request.input, ["første", "andre"]);
      return { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] };
    },
  });
  assert.deepEqual((await record.create(parameters(["første", "andre", "første"]))).data.map(row => row.embedding), [[1, 2], [3, 4], [1, 2]]);
  assert.equal(calls, 1);
  const replay = createFixtureStore({ file, model, dimensions: 2, request: () => assert.fail("Replay must not call a provider") });
  assert.deepEqual((await replay.create(parameters(["andre", "første"]))).data.map(row => row.embedding), [[3, 4], [1, 2]]);
  await assert.rejects(replay.create(parameters("changed input")), /refuses network fallback/u);
  assert.equal(replay.stats.missingInputs, 1);
  assert.equal(replay.stats.requests, 0);
});

test("model changes, malformed vectors and incomplete recording responses fail closed", async t => {
  const file = directory(t);
  const record = createFixtureStore({ file, model, dimensions: 2, record: true,
    request: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }),
  });
  await record.create(parameters("known"));
  const original = readFileSync(file, "utf8");
  assert.throws(() => createFixtureStore({ file, model: "another-model", dimensions: 2 }), /do not match/u);
  await assert.rejects(record.create(parameters(["new", "another"])), /incomplete rows/u);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.throws(() => encodeVector([NaN, 1], 2), /invalid dimensions or values/u);
  assert.throws(() => decodeVector(encodeVector([1, 2], 2), 3), /invalid dimensions/u);
  assert.notEqual(inputKey(model, "same"), inputKey("other", "same"));
  assert.notEqual(inputKey(model, "same"), inputKey(model, "changed"));
});
