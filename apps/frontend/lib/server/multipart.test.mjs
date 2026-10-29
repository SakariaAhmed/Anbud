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

test("bounded multipart parser keeps Norwegian UTF-8 file names intact", async () => {
  // macOS file pickers deliver decomposed (NFD) letters such as "o" + U+0338.
  const decomposed = "Bilag 2 - Leverandørens løsningsbeskrivelse på norsk.pdf".normalize("NFD");
  const body = new FormData();
  body.set("file", new File(["%PDF"], decomposed, { type: "application/pdf" }));
  const parsed = await parseBoundedMultipartFormData(
    new Request("http://localhost/upload", { method: "POST", body }),
    { maxBodyBytes: 64 * 1024, maxFileBytes: 16, maxFiles: 1 },
  );

  const name = parsed.get("file").name;
  assert.equal(name, "Bilag 2 - Leverandørens løsningsbeskrivelse på norsk.pdf");
  assert.equal(name, name.normalize("NFC"));
  assert.doesNotMatch(name, /Ã/u);
});

test("bounded multipart parser decodes a raw UTF-8 filename parameter", async () => {
  const boundary = "anbud-boundary";
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="`;
  const tail = `"\r\nContent-Type: application/pdf\r\n\r\n%PDF\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(head, "latin1"),
    Buffer.from("Leverandørens svar.pdf", "utf8"),
    Buffer.from(tail, "latin1"),
  ]);
  const parsed = await parseBoundedMultipartFormData(
    new Request("http://localhost/upload", {
      method: "POST",
      body,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    }),
    { maxBodyBytes: 64 * 1024, maxFileBytes: 16, maxFiles: 1 },
  );

  assert.equal(parsed.get("file").name, "Leverandørens svar.pdf");
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

test("bounded multipart parser rejects a malformed part header without an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const boundary = "syntheticboundary";
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="a"\r\nBad header line\r\n\r\nx\r\n`));
          return;
        }
        // Keep the stream open long enough for an early parser error to settle.
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (pulls > 3) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="b"\r\n\r\ny\r\n`));
      },
    });
    await assert.rejects(
      parseBoundedMultipartFormData(
        new Request("http://localhost/upload", {
          method: "POST",
          body,
          duplex: "half",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        }),
        { maxBodyBytes: 64 * 1024, maxFileBytes: 16, maxFiles: 1 },
      ),
      (error) => error instanceof MultipartRequestError && error.status === 400,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
