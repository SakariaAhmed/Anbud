import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const screenSource = await readFile(
  path.join(frontendRoot, "components/errors/secure-error-screen.tsx"),
  "utf8",
);
const boundarySources = await Promise.all(
  ["not-found.tsx", "unauthorized.tsx", "forbidden.tsx", "error.tsx", "global-error.tsx"].map(
    (file) => readFile(path.join(frontendRoot, "app", file), "utf8"),
  ),
);
const combinedSource = [screenSource, ...boundarySources].join("\n");

test("error pages cover 401, 403, 404 and 500 without reflecting request data", () => {
  for (const code of ["401", "403", "404", "500"]) {
    assert.match(screenSource, new RegExp(`"${code}"`));
  }

  assert.doesNotMatch(
    combinedSource,
    /usePathname|useSearchParams|window\.location|document\.location/iu,
  );
});

test("error pages never render exception internals or unsafe HTML", () => {
  assert.doesNotMatch(
    combinedSource,
    /dangerouslySetInnerHTML|error\.message|error\.stack|error\.digest/iu,
  );
  assert.match(screenSource, /ingen rutedata, ressurs-ID-er eller/iu);
});
