import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const corpusPath = path.join(
  repositoryRoot,
  "test-data",
  "document-analysis-stress",
  "corpus.json",
);
const manifestPath = path.join(
  repositoryRoot,
  "output",
  "pdf",
  "document-analysis-stress",
  "manifest.json",
);
const forbiddenDashes = /[‐‑‒–—]/u;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function authoredText(document) {
  return document.pages
    .flatMap((page) =>
      page.blocks.flatMap((block) => [
        block.label ?? "",
        block.text ?? "",
        ...(block.rows ?? []).flat(),
      ]),
    )
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("nb-NO")
    .replace(/\s+/gu, " ");
}

test("stress corpus has five complex documents and 90 held-out facts", async () => {
  const corpusText = await readFile(corpusPath, "utf8");
  const corpus = JSON.parse(corpusText);

  assert.equal(corpus.version, "document-analysis-stress.v1");
  assert.equal(corpus.documents.length, 5);
  assert.equal(forbiddenDashes.test(corpusText), false);
  assert.equal(new Set(corpus.documents.map((document) => document.id)).size, 5);

  let factCount = 0;
  for (const document of corpus.documents) {
    assert.equal(document.pages.length, 3);
    assert.deepEqual(
      new Set(document.pages.map((page) => page.layout)),
      new Set(["full", "two_column", "mixed"]),
    );
    const blockTypes = new Set(
      document.pages.flatMap((page) =>
        page.blocks.map((block) => block.type),
      ),
    );
    for (const requiredType of ["email", "note", "pseudo_table"]) {
      assert.equal(blockTypes.has(requiredType), true);
    }
    assert.equal(document.answer_key.must_not_claim.length, 3);

    const source = authoredText(document);
    for (const [category, facts] of Object.entries(document.answer_key)) {
      if (category === "must_not_claim") continue;
      factCount += facts.length;
      for (const fact of facts) {
        assert.ok(fact.id);
        assert.ok(fact.statement);
        assert.ok(fact.required_term_groups.length > 0);
        for (const alternatives of fact.required_term_groups) {
          assert.equal(
            alternatives.some((term) =>
              source.includes(
                term
                  .normalize("NFKC")
                  .toLocaleLowerCase("nb-NO")
                  .replace(/\s+/gu, " "),
              ),
            ),
            true,
            `${document.id}:${fact.id} lacks authored source support`,
          );
        }
      }
    }
  }
  assert.equal(factCount, 90);
});

test("generated PDF manifest matches the checked-in artifacts", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.version, "document-analysis-stress.v1");
  assert.equal(manifest.documents.length, 5);

  const entries = [...manifest.documents, manifest.answer_key];
  for (const entry of entries) {
    const absolutePath = path.join(repositoryRoot, entry.path);
    const buffer = await readFile(absolutePath);
    assert.equal(buffer.subarray(0, 4).toString("ascii"), "%PDF");
    assert.match(buffer.subarray(-32).toString("ascii"), /%%EOF\s*$/u);
    assert.equal(buffer.length, entry.bytes);
    assert.equal(sha256(buffer), entry.sha256);
  }
  for (const document of manifest.documents) {
    assert.equal(document.pages, 3);
  }
});
