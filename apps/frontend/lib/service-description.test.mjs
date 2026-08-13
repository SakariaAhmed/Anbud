import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "service-description-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot },
});

const { listSelectedServiceDocuments } = jiti(
  path.join(frontendRoot, "lib/service-description.ts"),
);

function service(id, selected, documentIds) {
  return {
    id,
    selected,
    documents: documentIds.map((documentId) => ({
      id: documentId,
      service_id: id,
      title: documentId,
    })),
  };
}

test("only selected service documents are exposed as project context", () => {
  const selected = service("selected-service", true, ["document-a", "document-b"]);
  const unselected = service("unselected-service", false, ["document-c"]);

  const result = listSelectedServiceDocuments([selected, unselected]);

  assert.deepEqual(
    result.map(({ service: item, document }) => [item.id, document.id]),
    [
      ["selected-service", "document-a"],
      ["selected-service", "document-b"],
    ],
  );
});
