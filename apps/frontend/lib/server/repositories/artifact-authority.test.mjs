import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const jiti = createJiti(path.join(frontendRoot, "artifact-authority-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const { currentArtifactTypesFromAuthority } = await jiti.import(
  path.join(frontendRoot, "lib/server/repositories/supabase-store.ts"),
);

test("artifact authority derives current types without loading a project snapshot", async () => {
  assert.deepEqual(
    currentArtifactTypesFromAuthority({
      forbedret_kravsvar: {
        id: "artifact-current",
        artifact_version: 2,
        source_is_current: true,
      },
      tilbudssammendrag: {
        id: "artifact-stale",
        artifact_version: 1,
        source_is_current: false,
      },
    }),
    ["forbedret_kravsvar"],
  );

  const route = await readFile(
    path.join(
      frontendRoot,
      "app/api/projects/[id]/artifact-authority/route.ts",
    ),
    "utf8",
  );
  assert.match(route, /getArtifactAuthoritySummary/u);
  assert.doesNotMatch(route, /getProjectSnapshot/u);
});
