import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const jiti = createJiti(path.join(frontendRoot, "documents-security-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const { loadValidatedOfficeZip } = await jiti.import(
  path.join(frontendRoot, "lib/server/documents.ts"),
);

test("office ZIP preflight accepts a small archive and rejects extreme expansion", async () => {
  const safe = new JSZip();
  safe.file("word/document.xml", "<document><body>Trygt innhold</body></document>");
  const safeBuffer = await safe.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  await assert.doesNotReject(() =>
    loadValidatedOfficeZip(safeBuffer, "safe.docx"),
  );

  const bomb = new JSZip();
  bomb.file("word/document.xml", "A".repeat(2 * 1024 * 1024));
  const bombBuffer = await bomb.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  await assert.rejects(
    () => loadValidatedOfficeZip(bombBuffer, "bomb.docx"),
    /utrygg kompresjonsgrad/u,
  );
});
