import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./project-analysis-tab.tsx", import.meta.url),
  "utf8",
);

test("customer analysis navigation excludes the keyword tab", () => {
  const tabsBlock = source.match(
    /const SECTION_TABS = \[([\s\S]*?)\] as const;/u,
  )?.[1];
  assert.ok(tabsBlock, "SECTION_TABS registry must remain discoverable");

  const tabs = [...tabsBlock.matchAll(
    /\{ value: "([^"]+)", label: "([^"]+)" \}/gu,
  )].map((match) => ({
    value: match[1],
    label: match[2],
  }));

  assert.deepEqual(tabs, [
    { value: "summary", label: "Oppsummering" },
    { value: "strategy", label: "Strategi" },
    { value: "clarifications", label: "Avklaringer" },
    { value: "design", label: "Design" },
    { value: "risks", label: "Risiko" },
    { value: "needs", label: "Behov" },
    { value: "services", label: "Anbefalt tjeneste" },
    { value: "value", label: "Verdi" },
  ]);
  assert.doesNotMatch(tabsBlock, /Nøkkelord|value: "keywords"/u);
});
