import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const require = createRequire(path.join(frontend, "package.json"));
const jiti = require("jiti").createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { extractRequirementLedgerForDocument } = jiti(path.join(frontend, "lib/server/requirements/extraction.ts"));
const frozen = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/generation-inputs.json"), "utf8"));
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8);
if (!label || !/^[a-z0-9-]+$/.test(label)) throw new Error("Use a new explicit diagnostic label.");
const output = path.join(root, `output/speed-quality-2026-09-08/frozen-ledgers-${label}.json`);
if (existsSync(output)) throw new Error("Preserve existing evidence.");
globalThis.fetch = async () => { throw new Error("Offline extraction diagnostic must not use the network."); };
const result = [];
for (const fixture of frozen.cases.filter((fixture) => fixture.split !== "holdout")) {
  const document = fixture.input.customerDocument;
  const start = performance.now();
  const rows = await extractRequirementLedgerForDocument(document);
  result.push({ caseId: fixture.caseId, inputSha256: fixture.inputSha256, sourceChars: document.raw_text.length, structureEntries: document.structure_map.length, elapsedMs: performance.now() - start, count: rows.length, ids: rows.map((r) => r.id), rows });
}
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.map(({ rows, ...summary }) => summary), null, 2));
