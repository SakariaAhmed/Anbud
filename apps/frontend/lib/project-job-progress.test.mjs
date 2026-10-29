import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(path.join(frontendRoot, "project-job-progress-tests.cjs"), {
  alias: { "@": frontendRoot },
});
const { formatJobProgress, parseJobProgress } = await jiti.import(
  path.join(frontendRoot, "lib/project-job-progress.ts"),
);

test("job progress written by the server is read back as a number and a label", () => {
  assert.deepEqual(parseJobProgress(formatJobProgress(58, "Analyserer kundedokumentet med AI ...")), {
    percent: 58,
    label: "Analyserer kundedokumentet med AI ...",
  });
  assert.equal(parseJobProgress(formatJobProgress(140.4, "Ferdig")).percent, 100);
  assert.equal(parseJobProgress(formatJobProgress(-3, "Start")).percent, 0);
});

test("messages without a progress marker carry no percentage", () => {
  // Wording no longer drives the progress bar; only the marker does.
  assert.deepEqual(parseJobProgress("Lagrer kundeanalysen ..."), {
    percent: null,
    label: "Lagrer kundeanalysen ...",
  });
});
