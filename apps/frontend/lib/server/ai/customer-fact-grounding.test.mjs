import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");

test("production AI sources contain no known synthetic tender constants", () => {
  const productionSource = [
    readFileSync(path.join(frontendRoot, "lib/server/ai.ts"), "utf8"),
    readFileSync(path.join(frontendRoot, "lib/server/prompts.ts"), "utf8"),
  ].join("\n");

  assert.doesNotMatch(
    productionSource,
    /Nordic Retail Logistics|Nordic Utilities|April 22 2026|May 20 2026|June 5 2026|September 30 2026|December 10 2026|RTO 60|RPO 15|140\s+(?:applications|applikasjoner)|architecture pack|controls matrix|cutover report|transition package|year-one budget|EUR\s*2\.?9|Net\s*60|oracle workloads|meter data provider/iu,
  );
});
