// Explicit, free regeneration of the fictional tender's parser snapshot.
// The retrieval gate reads the committed snapshot; it never re-parses PDFs or
// uses a paid model. Parsing changes must be reviewed separately.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "apps/frontend");
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
const app = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { extractTextFromBuffer } = app(path.join(frontend, "lib/server/documents.ts"));
const folder = "test-data/tenders/halandsvik-2026/documents";
const documents = [];
for (const file of fs.readdirSync(path.join(root, folder)).sort()) {
  const buffer = fs.readFileSync(path.join(root, folder, file));
  const role = file.startsWith("01") ? "primary_customer_document" : file.startsWith("04") ? "primary_solution_document" : "supporting_document";
  const parsed = await extractTextFromBuffer({ buffer, fileName: file, role, useDocling: false });
  documents.push({ key: `halandsvik-${file.slice(0, 2)}`, source_file: `${folder}/${file}`, source_sha256: createHash("sha256").update(buffer).digest("hex"),
    parser: parsed.parserUsed, role, supporting_subtype: file.startsWith("02") ? "kravdokument" : null,
    title: file.replace(/\.[^.]+$/u, "").replaceAll("_", " "), file_name: file, file_format: parsed.fileFormat, raw_text: parsed.rawText, structure_map: parsed.sourceMap });
}
fs.writeFileSync(path.join(root, "test-data/rag-retrieval/halandsvik-parser-snapshot.json"), `${JSON.stringify({ version: 1, scope: "Fictional checked-in tender; local-parser source snapshots, not a Docling/OCR evaluation.", documents }, null, 2)}\n`);
console.log(JSON.stringify(documents.map(document => ({ key: document.key, characters: document.raw_text.length, sections: document.structure_map.length, parser: document.parser }))));
