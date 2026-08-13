import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const jiti = createJiti(path.join(frontendRoot, "multipart-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const { MultipartRequestError, parseBoundedMultipartFormData } = await jiti.import(
  path.join(frontendRoot, "lib/server/multipart.ts"),
);

test("bounded multipart parser accepts a small file", async () => {
  const body = new FormData();
  body.set("title", "Trygt dokument");
  body.set("file", new File(["hello"], "hello.txt", { type: "text/html" }));
  const parsed = await parseBoundedMultipartFormData(
    new Request("http://localhost/upload", { method: "POST", body }),
    { maxBodyBytes: 64 * 1024, maxFileBytes: 16, maxFiles: 1 },
  );

  assert.equal(parsed.get("title"), "Trygt dokument");
  assert.equal(parsed.get("file").size, 5);
});

test("bounded multipart parser rejects a streamed file at the hard limit", async () => {
  const body = new FormData();
  body.set("file", new File(["A".repeat(32)], "large.txt"));
  await assert.rejects(
    parseBoundedMultipartFormData(
      new Request("http://localhost/upload", { method: "POST", body }),
      { maxBodyBytes: 64 * 1024, maxFileBytes: 8, maxFiles: 1 },
    ),
    (error) => error instanceof MultipartRequestError && error.status === 413,
  );
});
