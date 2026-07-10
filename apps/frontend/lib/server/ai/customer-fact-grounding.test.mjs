import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "customer-fact-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const { buildVerifiedFoundationControls } = jiti(
  path.join(
    frontendRoot,
    "lib/server/ai/verified-foundation-controls.ts",
  ),
);

function enrichFrom(text) {
  return buildVerifiedFoundationControls([
    {
      label: "Verifisert utdrag",
      text,
      source: "Kundedokument, side 1",
    },
  ]);
}

const unrelatedSyntheticFacts =
  /Nordic Retail|Nordic Utilities|140\s+(?:applications|applikasjoner)|2026-2028|April 22 2026|May 20 2026|June 5 2026|September 30 2026|December 10 2026|RTO\s*60|RPO\s*15|Net\s*60|D[2-5]\b/iu;

test("common customer terms never inject unrelated names, counts, dates, or thresholds", () => {
  const commonTerms = [
    "ERP WMS CRM logistics",
    "Wave 1",
    "D1",
    "RTO RPO",
    "backup failover API integration",
  ];

  for (const sourceText of commonTerms) {
    const output = JSON.stringify(enrichFrom(sourceText));
    assert.doesNotMatch(output, unrelatedSyntheticFacts, sourceText);
  }
});

test("exact verified source values are preserved without replacement defaults", () => {
  const output = JSON.stringify(
    enrichFrom(
      "The verified scope is 37 applications in Wave 2 by 17 March 2027. RTO is 90 minutes and RPO is 30 minutes.",
    ),
  );

  assert.match(output, /37 applications/u);
  assert.match(output, /Wave 2/u);
  assert.match(output, /17 March 2027/u);
  assert.match(output, /RTO is 90 minutes/u);
  assert.match(output, /RPO is 30 minutes/u);
  assert.doesNotMatch(output, unrelatedSyntheticFacts);
});

test("production AI sources contain no known synthetic tender constants", () => {
  const productionSource = [
    readFileSync(path.join(frontendRoot, "lib/server/ai.ts"), "utf8"),
    readFileSync(path.join(frontendRoot, "lib/server/prompts.ts"), "utf8"),
  ].join("\n");

  assert.doesNotMatch(
    productionSource,
    /Nordic Retail Logistics|Nordic Utilities|April 22 2026|May 20 2026|June 5 2026|September 30 2026|December 10 2026|RTO 60|RPO 15|140 applikasjoner/iu,
  );
});
