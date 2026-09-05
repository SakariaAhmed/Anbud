import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "project-chat-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { inferProjectChatDomains } = jiti(
  path.join(frontendRoot, "lib/server/ai/project-chat.ts"),
);

test("chat domain inference moved behind the project-chat boundary", () => {
  assert.deepEqual(
    inferProjectChatDomains({
      question: "Hvordan bør Azure-arkitektur og integrasjoner utformes?",
    }),
    ["Arkitektur og løsning"],
  );
  assert.deepEqual(
    inferProjectChatDomains({ question: "Kan du utdype?" }),
    ["Kunde og behov"],
  );
});
