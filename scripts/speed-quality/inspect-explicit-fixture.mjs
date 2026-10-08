import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const require = createRequire(path.join(frontend, "package.json"));
const jiti = require("jiti").createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { extractTextFromBuffer } = jiti(path.join(frontend, "lib/server/documents.ts"));
const { extractRequirementLedgerForDocument } = jiti(path.join(frontend, "lib/server/requirements/extraction.ts"));
// No paid fallback or remote file access is allowed during fixture inspection.
globalThis.fetch = async () => { throw new Error("Network is disabled during fixture inspection."); };
const scenario = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/large-explicit-tender-case.json"), "utf8")).cases[0];
const parsed = await extractTextFromBuffer({ buffer: Buffer.from(scenario.customerText), fileName: "explicit.md", role: "primary_customer_document", useDocling: false });
const rows = await extractRequirementLedgerForDocument({ id: "local-explicit-fixture", project_id: "local-fixture", role: "primary_customer_document", title: scenario.customerName, file_name: "explicit.md", file_format: parsed.fileFormat, raw_text: parsed.rawText, structure_map: parsed.sourceMap });
const expected = Array.from({ length: 32 }, (_, i) => `L-${String(i + 1).padStart(2, "0")}`);
const result = { caseId: scenario.id, count: rows.length, expectedIds: expected, actualIds: rows.map((r) => r.id), allIdsPresent: expected.every((id) => rows.some((r) => r.id === id)), rows };
writeFileSync(path.join(root, "output/speed-quality-2026-09-08/explicit-fixture-extraction.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
if (!result.allIdsPresent || rows.length !== 32) process.exitCode = 1;
