import assert from "node:assert/strict";
import path from "node:path";
import childProcess from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jiti = createJiti(path.join(root, "office-zip-tests.cjs"), {
  alias: { "@": root, "server-only": "/dev/null" },
  interopDefault: true,
});
const { loadValidatedOfficeZip, extractTextFromBuffer } = await jiti.import(path.join(root, "lib/server/documents.ts"));

function forgeDeclaredSize(buffer, size) {
  const result = Buffer.from(buffer);
  for (let offset = 0; offset <= result.length - 24; offset++) {
    const signature = result.readUInt32LE(offset);
    if (signature === 0x02014b50) result.writeUInt32LE(size, offset + 24);
    if (signature === 0x04034b50) result.writeUInt32LE(size, offset + 22);
  }
  return result;
}

for (const declared of [0, 32, 8192]) {
  test(`forged DEFLATE size ${declared} stops at the native output limit`, async () => {
    const zip = new JSZip();
    // A bounded 2 MiB fixture reproduces amplification without stressing the host.
    zip.file("word/document.xml", "A".repeat(2 * 1024 * 1024));
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await assert.rejects(loadValidatedOfficeZip(forgeDeclaredSize(buffer, declared), "forged.docx"), error => {
      assert.match(error.message, /grensen for utpakking/u);
      assert.equal(error.cause?.code, "ERR_BUFFER_TOO_LARGE");
      return true;
    });
  });
}

test("STORE entries cannot understate their actual byte length", async () => {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", "A".repeat(4096));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  await assert.rejects(loadValidatedOfficeZip(forgeDeclaredSize(buffer, 32), "forged.xlsx"), /grensen for utpakking/u);
});

test("all Office parts are validated even when Word XML itself is harmless", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "safe");
  zip.file("word/comments.xml", "A".repeat(256 * 1024));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await assert.rejects(loadValidatedOfficeZip(forgeDeclaredSize(buffer, 32), "forged.docx"));
});

for (const compression of ["STORE", "DEFLATE"]) {
  test(`valid ${compression} Office parts and empty files survive canonicalization`, async () => {
    const zip = new JSZip();
    const xml = "<document><body>Norsk innhold æøå</body></document>";
    zip.file("word/document.xml", xml);
    zip.file("empty", "");
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression });
    const validated = await loadValidatedOfficeZip(buffer, "valid.docx");
    assert.equal(await validated.file("word/document.xml").async("text"), xml);
    assert.equal(await validated.file("empty").async("text"), "");
    const canonical = await validated.generateAsync({ type: "nodebuffer", compression: "STORE" });
    const reread = await JSZip.loadAsync(canonical, { checkCRC32: true });
    assert.equal(await reread.file("word/document.xml").async("text"), xml);
  });
}

for (const fileFormat of ["docx", "xlsx"]) {
  test(`optional Docling ${fileFormat} rejects forged bytes before starting a subprocess`, async (t) => {
    const saved = { ingestion: process.env.DOCLING_INGESTION, formats: process.env.DOCLING_FORMATS };
    t.after(() => {
      for (const [name, value] of [["DOCLING_INGESTION", saved.ingestion], ["DOCLING_FORMATS", saved.formats]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    });
    process.env.DOCLING_INGESTION = "on";
    process.env.DOCLING_FORMATS = "all";
    const subprocess = t.mock.method(childProcess, "execFile", () => { throw new Error("Unexpected subprocess"); });
    const zip = new JSZip();
    zip.file("word/document.xml", "A".repeat(256 * 1024));
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await assert.rejects(extractTextFromBuffer({ buffer: forgeDeclaredSize(buffer, 32), fileName: `forged.${fileFormat}` }), /grensen for utpakking/u);
    assert.equal(subprocess.mock.callCount(), 0);
  });
}

test("ordinary XLSX parses its canonical archive and keeps the original upload", async () => {
  const xlsx = await import("@e965/xlsx");
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([["Krav", "Svar"], ["Tilgjengelighet", "Ja"]]), "Krav");
  const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
  const parsed = await extractTextFromBuffer({ buffer, fileName: "krav.xlsx", useDocling: false });
  assert.match(parsed.rawText, /Tilgjengelighet/u);
  assert.equal(parsed.fileBase64, buffer.toString("base64"));
});

test("unsafe ZIP names and unsupported directory representations fail closed", async () => {
  const zip = new JSZip();
  zip.file("../word/document.xml", "content", { createFolders: false });
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  await assert.rejects(loadValidatedOfficeZip(buffer, "unsafe.docx"), /ZIP-filnavn/u);
  const multiVolume = Buffer.from(buffer);
  multiVolume.writeUInt16LE(1, multiVolume.length - 22 + 4);
  await assert.rejects(loadValidatedOfficeZip(multiVolume, "multivolume.docx"), /ugyldige ZIP-data/u);
  const zip64 = Buffer.from(buffer);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
  await assert.rejects(loadValidatedOfficeZip(zip64, "zip64.docx"), /ugyldige ZIP-data/u);
});

test("archive end records cannot disagree between preflight and JSZip", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "safe");
  const buffer = await zip.generateAsync({ type: "nodebuffer", comment: "ordinary comment" });
  await assert.doesNotReject(loadValidatedOfficeZip(buffer, "comment.docx"));
  const ambiguous = await zip.generateAsync({ type: "nodebuffer", comment: "ambiguous PK\u0005\u0006 comment" });
  await assert.rejects(loadValidatedOfficeZip(ambiguous, "ambiguous.docx"), /ugyldige ZIP-data/u);
});
