import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("./scan_tracked_secrets.mjs", import.meta.url));
function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "tracked-secrets-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "apps/frontend"), { recursive: true });
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  git("init", "--quiet");
  for (const [file, text] of Object.entries(files)) write(file, text);
  git("add", ".");
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Secret scanner test", "-c", "user.email=scanner@example.test", "commit", "--quiet", "-m", "Synthetic scanner fixture");
  };
  const scan = (directory = root, args = []) => {
    const result = spawnSync(process.execPath, [scanner, ...args], { cwd: directory, encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  return { root, frontend: path.join(root, "apps/frontend"), write, commit, scan };
}

test("root and frontend invocations scan the same repository, including tracked unstaged files", (t) => {
  const legacy = ["sk", "A".repeat(40)].join("-");
  const project = ["sk", "proj", "B".repeat(48)].join("-");
  const fakePassword = "synthetic-password-for-scanner-regression";
  const privateHeader = ["-----BEGIN", " PRIVATE KEY-----"].join("");
  const f = fixture(t, {
    "root-key.txt": "clean tracked contents\n",
    "apps/frontend/project-key.txt": `key=${project}\n`,
    ".env.local": `APP_ADMIN_PASSWORD=${fakePassword}\n`,
    "private-key.txt": `${privateHeader}\nsynthetic body\n`,
  });
  // The scanner must inspect current contents, not only the staged version.
  f.write("root-key.txt", `key=${legacy}\n`);
  const atRoot = f.scan(), atFrontend = f.scan(f.frontend);
  assert.equal(atRoot.status, 1);
  assert.deepEqual(atFrontend, atRoot);
  assert.match(atRoot.output, /root-key\.txt:1 OpenAI API key/u);
  assert.match(atRoot.output, /apps\/frontend\/project-key\.txt:1 OpenAI API key/u);
  assert.match(atRoot.output, /\.env\.local:1 Env secret assignment \(APP_ADMIN_PASSWORD\)/u);
  assert.match(atRoot.output, /private-key\.txt:1 Generic private key/u);
  for (const secret of [legacy, project, fakePassword, privateHeader]) assert.equal(atRoot.output.includes(secret), false);
});

test("task identifiers and key-like substrings inside larger tokens are not credentials", (t) => {
  const suffix = "task-source-version-".repeat(4);
  const key = ["sk", "C".repeat(40)].join("-");
  const f = fixture(t, { "docs/task-identifiers.json": JSON.stringify([
    `task-sources-v-${suffix}`, `prefix-${key}`, `prefix_${key}`, `æ${key}`, `${key}ø`,
  ]) });
  const atRoot = f.scan();
  assert.equal(atRoot.status, 0, atRoot.output);
  assert.deepEqual(f.scan(f.frontend), atRoot);
  assert.match(atRoot.output, /No tracked secrets found/u);
});

test("history scanning keeps token boundaries and repository scope from either directory", (t) => {
  const key = ["sk", "proj", "D".repeat(48)].join("-");
  const f = fixture(t, {
    "retired-key.txt": `key="${key}"\n`,
    "docs/task-identifiers.json": JSON.stringify({ task: `task-sources-v-${"source-id-".repeat(8)}` }),
  });
  f.commit();
  f.write("retired-key.txt", "credential removed\n");
  f.commit();
  assert.equal(f.scan().status, 0);
  const atRoot = f.scan(f.root, ["--history"]);
  assert.equal(atRoot.status, 1);
  assert.deepEqual(f.scan(f.frontend, ["--history"]), atRoot);
  assert.match(atRoot.output, /history retired-key\.txt:1 OpenAI API key commits=1/u);
  assert.doesNotMatch(atRoot.output, /task-identifiers\.json/u);
  assert.equal(atRoot.output.includes(key), false);
});
