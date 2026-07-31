import { createHash } from "node:crypto";

import { normalizeDocumentChunkStructureMap } from "@/lib/server/document-chunk-structure";

export function documentSourceContentHash(input: {
  rawText: string;
  structureMap: unknown;
}) {
  return createHash("sha256")
    .update(input.rawText)
    .update("\n")
    .update(JSON.stringify(normalizeDocumentChunkStructureMap(input.structureMap)))
    .digest("hex");
}
