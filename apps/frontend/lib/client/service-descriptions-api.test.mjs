import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "service-api-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot },
});

const { clearClientCache } = jiti(
  path.join(frontendRoot, "lib/client-cache.ts"),
);
const { fetchServiceDescriptions } = jiti(
  path.join(frontendRoot, "lib/client/service-descriptions-api.ts"),
);

test("global service-description reads share one pending request and cache it", async () => {
  const originalFetch = globalThis.fetch;
  let releaseFetch;
  let fetchCount = 0;
  clearClientCache("service-descriptions");
  globalThis.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => {
      releaseFetch = resolve;
    });
    return new Response(
      JSON.stringify({ services: [{ id: "service-a", documents: [] }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const first = fetchServiceDescriptions();
    const controller = new AbortController();
    const second = fetchServiceDescriptions({ signal: controller.signal });
    assert.equal(fetchCount, 1);

    releaseFetch();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult[0].id, "service-a");
    assert.equal(secondResult[0].id, "service-a");

    const cached = await fetchServiceDescriptions();
    assert.equal(cached[0].id, "service-a");
    assert.equal(fetchCount, 1);
  } finally {
    clearClientCache("service-descriptions");
    globalThis.fetch = originalFetch;
  }
});
