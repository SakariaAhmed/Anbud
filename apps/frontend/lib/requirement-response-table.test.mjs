import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(path.join(frontendRoot, "requirement-response-table-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const load = (file) => jiti.import(path.join(frontendRoot, file));
const { requirementTableMarkdown } = await load("lib/server/requirements/presentation.ts");
const { requirementResponseRequirementCount } = await load("lib/requirement-response-count.ts");
const { requirementResponseTableColumns } = await load("lib/requirement-response-table.ts");
const { splitMarkdownTableRow } = await load("lib/markdown-table-row.ts");

test("the client reads the requirement table the server writes", () => {
  const lines = requirementTableMarkdown([
    ["K-1", "Løsningen skal ha SSO.", "Ja, via Entra ID.", "Avsnitt 2", "Bilag 1"],
    ["K-2", "Logg skal lagres i 90 dager.", "Ja.", "Avsnitt 4", "Bilag 1"],
  ]);
  assert.deepEqual(requirementResponseTableColumns(splitMarkdownTableRow(lines[0])), {
    refIndex: 0,
    requirementIndex: 1,
    answerIndex: 2,
    evidenceIndex: 3,
    sourceIndex: 4,
  });
  assert.equal(requirementResponseRequirementCount(lines.join("\n")), 2);
});
