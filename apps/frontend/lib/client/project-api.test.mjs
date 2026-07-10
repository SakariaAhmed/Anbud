import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

const jiti = createJiti(path.join(frontendRoot, "project-api-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
  },
});

const {
  fetchCustomerAnalysis,
  fetchGeneratedArtifacts,
  fetchProjectServices,
  readJsonPayload,
} = jiti(path.join(frontendRoot, "lib/client/project-api.ts"));

test("readJsonPayload maps JSON detail errors to the shared error field", async () => {
  const payload = await readJsonPayload(
    new Response(JSON.stringify({ detail: "Unsupported content type" }), {
      status: 415,
      headers: { "content-type": "application/json" },
    }),
    "Kunne ikke starte jobben.",
  );

  assert.equal(
    payload.error,
    "Kunne ikke starte jobben. Serveren mottok en forespørsel med feil innholdstype. Last siden på nytt og prøv igjen.",
  );
});

test("readJsonPayload parses non-json JSON text errors", async () => {
  const payload = await readJsonPayload(
    new Response('{"detail":"Unsupported content type"}', {
      status: 415,
      headers: { "content-type": "text/plain" },
    }),
    "Kunne ikke laste opp dokumentet.",
  );

  assert.equal(
    payload.error,
    "Kunne ikke laste opp dokumentet. Serveren mottok en forespørsel med feil innholdstype. Last siden på nytt og prøv igjen.",
  );
});

test("signal-bound project reads bypass shared pending requests", async () => {
  const originalFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = async (_url, init) => {
    signals.push(init?.signal);
    return new Response(JSON.stringify({ analysis: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const first = new AbortController();
    const second = new AbortController();
    await Promise.all([
      fetchCustomerAnalysis("signal-project", { signal: first.signal }),
      fetchCustomerAnalysis("signal-project", { signal: second.signal }),
    ]);

    assert.equal(signals.length, 2);
    assert.equal(signals[0], first.signal);
    assert.equal(signals[1], second.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signal-bound project reads reuse an existing unsignaled prefetch", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => {
      resolveFetch = resolve;
    });
    return new Response(JSON.stringify({ analysis: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const prefetched = fetchCustomerAnalysis("dedupe-prefetch-project");
    const controller = new AbortController();
    const activeRead = fetchCustomerAnalysis("dedupe-prefetch-project", {
      signal: controller.signal,
    });

    assert.equal(fetchCount, 1);
    resolveFetch();
    assert.deepEqual(await Promise.all([prefetched, activeRead]), [null, null]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("service reads reuse an existing unsignaled prefetch", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => {
      resolveFetch = resolve;
    });
    return new Response(JSON.stringify({ services: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const prefetched = fetchProjectServices("service-prefetch-project");
    const controller = new AbortController();
    const activeRead = fetchProjectServices("service-prefetch-project", {
      signal: controller.signal,
    });

    assert.equal(fetchCount, 1);
    resolveFetch();
    assert.deepEqual(await Promise.all([prefetched, activeRead]), [[], []]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generated artifact reads request only the selected artifact type", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ artifacts: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await fetchGeneratedArtifacts("artifact-type-project", {
      artifactType: "bilag1_rekonstruksjon",
    });

    assert.match(
      requestedUrl,
      /\/api\/projects\/artifact-type-project\/generate\?artifact_type=bilag1_rekonstruksjon$/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
