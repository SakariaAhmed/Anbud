import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("enhancement publication rejects a role/source revision changed during parsing before any write", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ingestion-revision-"));
  try {
    const backend = path.join(directory, "backend.cjs");
    writeFileSync(backend, `exports.createServiceClient = () => ({
      from(table) {
        if (table !== "documents") throw new Error("Unexpected table");
        const query = {
          select() { return query; }, eq() { return query; },
          async single() { return { data: { id: "document", project_id: "project", role: "supporting_document", supporting_subtype: "rfp", chunk_source_revision: 4, raw_text: "unchanged source", processing_status: "basic_ready" }, error: null }; },
          update() { throw new Error("Stale publication reached a write"); }
        }; return query;
      },
      rpc() { throw new Error("Stale publication reached an RPC"); }
    });`);
    const frontend = path.resolve(import.meta.dirname, "../../..");
    const load = createJiti(import.meta.url, { moduleCache: false, alias: {
      "@/lib/server/data-api": backend, "@": frontend, "server-only": "/dev/null",
    } });
    const { saveDocumentIngestionResult } = load("./data-store.ts");
    await assert.rejects(saveDocumentIngestionResult({
      projectId: "project", documentId: "document", expectedSourceRevision: 3,
      role: "primary_customer_document", title: "Krav", fileName: "krav.pdf",
      fileFormat: "pdf", contentType: "application/pdf", rawText: "enhanced source",
      structureMap: [], parserUsed: "docling", status: "enhanced_ready", message: "Ferdig",
      requirementRegister: [],
    }), /Dokumentgrunnlaget er endret under forbedringen/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
