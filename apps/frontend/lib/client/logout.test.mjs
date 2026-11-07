import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { logOutAndRedirect } = createJiti(import.meta.url)("./logout.ts");

for (const failure of ["503", "network"]) {
  test(`logout keeps the current page on ${failure} and permits a successful retry`, async (t) => {
    let redirects = 0;
    let attempts = 0;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(url, "/api/auth/logout"); assert.equal(init.method, "POST");
      if (attempts++ === 0) {
        if (failure === "network") throw new TypeError("synthetic network failure");
        return Response.json({ error: "retry" }, { status: 503 });
      }
      return Response.json({ ok: true });
    });
    const redirect = () => { redirects++; };
    await assert.rejects(logOutAndRedirect(redirect));
    assert.equal(redirects, 0);
    await logOutAndRedirect(redirect);
    assert.equal(redirects, 1);
  });
}
