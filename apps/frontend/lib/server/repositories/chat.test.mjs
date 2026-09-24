import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");

test("all chat source locators survive encrypted persistence and subsequent reload", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-repository-"));
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = "fictional-chat-source-regression-key";
  const state = { rows: [], invalidations: [] };
  globalThis.__chatRepositoryTest = state;
  try {
    const dataApi = path.join(directory, "data-api.cjs");
    const cache = path.join(directory, "cache.cjs");
    writeFileSync(dataApi, `exports.createServiceClient = () => ({ from(table) {
      const state = globalThis.__chatRepositoryTest;
      const query = {
        insert(payload) { state.rows.push({ id: "message", created_at: "2026-01-01T00:00:00Z", ...payload }); return query; },
        select() { return query; }, eq() { return query; }, order() { return query; }, update() { return query; },
        async single() { return { data: state.rows.at(-1), error: null }; },
        async limit() { return { data: [...state.rows], error: null }; },
      }; return query;
    } });`);
    writeFileSync(cache, `exports.revalidateProjectCaches = projectId => globalThis.__chatRepositoryTest.invalidations.push(projectId);`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/data-api": dataApi, "@/lib/server/repositories/repository-cache": cache,
      "@": frontend, "server-only": "/dev/null",
    } });
    const { appendChatMessage, listChatMessages } = load("./chat.ts");
    const sources = Array.from({ length: 16 }, (_, index) => ({
      document_title: `Dokument ${index + 1}`, reference: `Side ${index + 1}, avsnitt 2`,
      heading_path: ["Krav", `Tema ${index + 1}`], page_start: index + 1, page_end: index + 1,
      source_type: index % 2 ? "service_document" : "project_document", source_id: `source-${index + 1}`,
    }));
    const stored = await appendChatMessage("fictional-project", "assistant", "Et svar med kilder.", { source_references: [...sources, null, 7, {}] }, { sessionId: "fictional-session" });
    assert.deepEqual(stored.source_references, sources);
    assert.equal(state.rows[0].context_snapshot.encrypted, true);
    assert.match(state.rows[0].context_snapshot.payload, /^enc:v1:/);
    assert.ok(!JSON.stringify(state.rows[0].context_snapshot).includes("Dokument 16"));
    const reloaded = await listChatMessages("fictional-project");
    assert.deepEqual(reloaded[0].source_references, sources);
    assert.equal(reloaded[0].session_id, "fictional-session");
    assert.deepEqual(state.invalidations, ["fictional-project"]);
  } finally {
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = previousKey;
    delete globalThis.__chatRepositoryTest;
    rmSync(directory, { recursive: true, force: true });
  }
});
