import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "postgrest-client-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});
const { PostgrestClient } = jiti(
  path.join(frontendRoot, "lib/server/postgrest-client.ts"),
);

function response(body, init = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

test("table reads encode filters, ordering, ranges, schema and credentials", async () => {
  const calls = [];
  const client = new PostgrestClient("https://data.internal", {
    schema: "public",
    headers: { apikey: "service-key", Authorization: "Bearer service-key" },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return response([{ id: "p-1" }], {
        headers: { "Content-Range": "0-0/1" },
      });
    },
  });

  const result = await client
    .from("projects")
    .select("id, name", { count: "exact" })
    .eq("owner_id", "user/1")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(0, 9);

  assert.deepEqual(result.data, [{ id: "p-1" }]);
  assert.equal(result.count, 1);
  const request = calls[0];
  const url = new URL(request.url);
  assert.equal(url.pathname, "/projects");
  assert.equal(url.searchParams.get("select"), "id,name");
  assert.equal(url.searchParams.get("owner_id"), "eq.user/1");
  assert.equal(url.searchParams.get("deleted_at"), "is.null");
  assert.equal(url.searchParams.get("order"), "created_at.desc");
  assert.equal(request.init.headers.get("Accept-Profile"), "public");
  assert.equal(request.init.headers.get("Authorization"), "Bearer service-key");
  assert.equal(request.init.headers.get("Prefer"), "count=exact");
  assert.equal(request.init.headers.get("Range"), "0-9");
});

test("upserts and RPCs preserve PostgREST mutation semantics", async () => {
  const calls = [];
  const client = new PostgrestClient("https://data.internal", {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return response([{ id: "p-1" }], { status: 201 });
    },
  });

  await client
    .from("projects")
    .upsert({ id: "p-1" }, { onConflict: "id" })
    .select("id")
    .single();
  await client.rpc("replace_group_members", {
    p_group_id: "g-1",
    p_principal_ids: ["u-1"],
  });

  assert.equal(calls[0].init.method, "POST");
  assert.equal(new URL(calls[0].url).searchParams.get("on_conflict"), "id");
  assert.equal(
    calls[0].init.headers.get("Prefer"),
    "resolution=merge-duplicates,return=representation",
  );
  assert.equal(
    calls[0].init.headers.get("Accept"),
    "application/vnd.pgrst.object+json",
  );
  assert.equal(new URL(calls[1].url).pathname, "/rpc/replace_group_members");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    p_group_id: "g-1",
    p_principal_ids: ["u-1"],
  });
});

test("maybeSingle maps a zero-row object response to null but keeps real errors", async () => {
  const zeroRows = new PostgrestClient("https://data.internal", {
    fetch: async () =>
      response(
        {
          code: "PGRST116",
          details: "The result contains 0 rows",
          hint: null,
          message: "Cannot coerce the result to a single JSON object",
        },
        { status: 406 },
      ),
  });
  assert.deepEqual(
    await zeroRows.from("projects").select("id").maybeSingle(),
    { data: null, error: null, count: null, status: 200, statusText: "OK" },
  );

  const failure = new PostgrestClient("https://data.internal", {
    fetch: async () => {
      throw new Error("https://data.internal?secret=must-not-leak");
    },
  });
  const result = await failure.from("projects").select("id");
  assert.equal(result.status, 0);
  assert.equal(result.error.message, "Data API request failed.");
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/u);
});
