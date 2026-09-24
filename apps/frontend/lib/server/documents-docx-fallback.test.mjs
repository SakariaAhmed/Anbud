import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jiti = createJiti(path.join(frontendRoot, "docx-fallback-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" }, interopDefault: true,
});
const { extractTextFromBuffer } = await jiti.import(path.join(frontendRoot, "lib/server/documents.ts"));
const mammoth = createRequire(import.meta.url)("mammoth");

async function docx(text, documentPath = "word/document.xml", extras = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${documentPath}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${documentPath}"/></Relationships>`);
  zip.file(documentPath, `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for (const [name, value] of Object.entries(extras)) zip.file(name, value);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
const extract = (buffer) => extractTextFromBuffer({ buffer, fileName: "test.docx", useDocling: false });

test("DOCX expansion rejection stays terminal through full extraction", async (t) => {
  // Only 256 KiB expanded: exercises the 200:1 ratio without exhausting the host.
  const buffer = await docx("A".repeat(256 * 1024));
  assert.equal((await mammoth.extractRawText({ buffer })).value.trim().length, 256 * 1024);
  const fallback = t.mock.method(mammoth, "extractRawText", async () => ({ value: "unsafe fallback" }));
  await assert.rejects(extract(buffer), /utrygg kompresjonsgrad/u);
  assert.equal(fallback.mock.callCount(), 0);
});

test("oversized DOCX auxiliary parts cannot reach a compatibility parser", async (t) => {
  const buffer = await docx("Gyldig innhold", "alternate/document.xml", { "word/comments.xml": "A".repeat(256 * 1024) });
  const fallback = t.mock.method(mammoth, "extractRawText", async () => ({ value: "unsafe fallback" }));
  await assert.rejects(extract(buffer), /utrygg kompresjonsgrad/u);
  assert.equal(fallback.mock.callCount(), 0);
});

test("ordinary DOCX retains XML extraction and the original source", async () => {
  const buffer = await docx("Et vanlig norsk dokument");
  const parsed = await extract(buffer);
  assert.equal(parsed.parserUsed, "docx-xml");
  assert.equal(parsed.rawText, "Et vanlig norsk dokument");
  assert.equal(parsed.fileBase64, buffer.toString("base64"));
});

test("valid alternate DOCX part uses Mammoth with normalized bytes and preserves source", async (t) => {
  const buffer = await docx("Kompatibelt norsk dokument", "alternate/document.xml");
  const original = mammoth.extractRawText;
  const fallback = t.mock.method(mammoth, "extractRawText", async (input) => {
    assert.notDeepEqual(input.buffer, buffer);
    return original(input);
  });
  const parsed = await extract(buffer);
  assert.equal(fallback.mock.callCount(), 1);
  assert.equal(parsed.parserUsed, "mammoth");
  assert.equal(parsed.rawText, "Kompatibelt norsk dokument");
  assert.equal(parsed.fileBase64, buffer.toString("base64"));
});
