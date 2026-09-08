import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const directory = path.join(root, "output/speed-quality-2026-09-08/verification/docling-amd64");
if (existsSync(directory)) throw new Error("Preserve previous Docling conversion evidence.");
const tag = "anbud-speed-quality-docling:amd64-20260908";
const source = path.join(root, "test-data/tenders/tender_nordic_hybrid_cloud_2026.pdf");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inspect = JSON.parse(execFileSync("docker", ["image", "inspect", tag], { encoding: "utf8" }))[0];
assert.equal(inspect.Architecture, "amd64"); assert.equal(inspect.Os, "linux"); assert.equal(inspect.Config.User, "node");
mkdirSync(directory, { recursive: true, mode: 0o777 });
// This new directory contains only synthetic conversion outputs. Do not rely
// on Docker Desktop's host UID mapping or the caller's umask for write access.
chmodSync(directory, 0o777);
const report = { at: new Date().toISOString(), image: { tag, id: inspect.Id, architecture: inspect.Architecture, os: inspect.Os, user: inspect.Config.User, sizeBytes: inspect.Size }, source: { file: path.relative(root, source), sha256: sha(readFileSync(source)), customer: "Nordic Utilities", pages: 3 }, scope: "Offline Docling CLI in the actual linux/amd64 runner-docling image, nonroot, locally emulated. Small existing born-digital PDF with OCR explicitly disabled. Tests text conversion and three-page coverage; not scanned-PDF OCR, Next ingestion orchestration, Azure or production latency.", checks: {} };
const started = performance.now();
const containerName = `anbud-docling-conversion-${randomUUID()}`;
try {
  const conversion = spawnSync("docker", ["run", "--rm", "--name", containerName, "--platform", "linux/amd64", "--network", "none", "--mount", `type=bind,source=${source},target=/input/source.pdf,readonly`, "--mount", `type=bind,source=${directory},target=/output`, tag, "/opt/docling/bin/docling", "--to", "md", "--to", "json", "--output", "/output", "--image-export-mode", "placeholder", "--document-timeout", "600", "--artifacts-path", "/opt/docling-models", "--num-threads", "2", "--table-mode", "accurate", "--no-ocr", "/input/source.pdf"], { encoding: "utf8", timeout: 660_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(path.join(directory, "stdout.log"), conversion.stdout ?? "");
  writeFileSync(path.join(directory, "stderr.log"), conversion.stderr ?? "");
  assert.equal(conversion.status, 0, "Offline Docling conversion failed; inspect preserved stderr.");
  const markdown = readFileSync(path.join(directory, "source.md"), "utf8");
  const document = JSON.parse(readFileSync(path.join(directory, "source.json"), "utf8"));
  const text = markdown.replace(/\s+/g, " ");
  const required = ["Nordic Utilities", "140 applications", "RTO of 60 minutes", "RPO of 15 minutes", ...[1,2,3,4,5].map((n) => `Deliverable D${n}`), "April 9, 2026 15:00 CET", "December 15, 2026 to January 5, 2027", "prohibits major cutovers"];
  for (const expected of required) assert.ok(text.includes(expected), `Missing source fact: ${expected}`);
  const pages = new Set((document.texts ?? []).flatMap((item) => (item.prov ?? []).map((p) => p.page_no)));
  assert.deepEqual([...pages].sort(), [1,2,3]);
  report.checks = { facts: required, allFactsPreserved: true, provenancePages: [...pages].sort(), markdownChars: markdown.length, jsonSha256: sha(readFileSync(path.join(directory, "source.json"))), markdownSha256: sha(Buffer.from(markdown)), exitCode: 0 };
} catch (error) {
  if (error.stderr) writeFileSync(path.join(directory, "stderr.log"), error.stderr);
  if (error.stdout) writeFileSync(path.join(directory, "stdout.log"), error.stdout);
  report.failure = error instanceof Error ? error.message : "Conversion failed";
  throw error;
} finally {
  spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore", timeout: 30_000 });
  report.observedEmulatedMs = performance.now() - started;
  writeFileSync(path.join(directory, "checks.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
