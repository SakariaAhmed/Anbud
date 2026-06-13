import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const FIXTURE_ROOT_ENV_NAMES = [
  "REQUIREMENT_VERIFY_FIXTURE_ROOTS",
  "REQUIREMENT_VERIFY_FIXTURE_ROOT",
  "REQUIREMENT_FIXTURE_ROOT",
];

function pathEnvEntries(value) {
  return String(value ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function existingCanonicalRoot(root) {
  if (!root || root.includes("\0")) return null;
  const resolved = path.resolve(root);
  if (!existsSync(resolved)) return null;
  return realpathSync(resolved);
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

export function fixtureSearchRoots(env = process.env) {
  const configuredRoots = FIXTURE_ROOT_ENV_NAMES.flatMap((name) =>
    pathEnvEntries(env[name]),
  );
  const candidateRoots = configuredRoots.length
    ? configuredRoots
    : env.HOME
      ? [`${env.HOME}/Downloads`]
      : [];

  return uniquePaths(
    candidateRoots
      .map(existingCanonicalRoot)
      .filter((root) => typeof root === "string"),
  );
}

function normalizeFixtureRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("Fixture path must be a non-empty relative path.");
  }
  if (relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe fixture path: ${relativePath}`);
  }

  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (
    !segments.length ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe fixture path: ${relativePath}`);
  }

  return segments;
}

export function resolveFixturePathInRoot(root, relativePath) {
  const rootRealPath = existingCanonicalRoot(root);
  if (!rootRealPath) return null;

  const segments = normalizeFixtureRelativePath(relativePath);
  const candidate = path.resolve(rootRealPath, ...segments);
  const insideRoot =
    candidate === rootRealPath ||
    candidate.startsWith(`${rootRealPath}${path.sep}`);

  if (!insideRoot) {
    throw new Error(`Fixture path escapes configured root: ${relativePath}`);
  }

  return candidate;
}

export function resolveExistingFixturePath(relativePath, roots = fixtureSearchRoots()) {
  for (const root of roots) {
    const candidate = resolveFixturePathInRoot(root, relativePath);
    if (candidate && existsSync(candidate)) return candidate;
  }

  return null;
}

export function resolveExistingExplicitFilePath(filePath) {
  if (
    typeof filePath !== "string" ||
    !filePath.trim() ||
    filePath.includes("\0")
  ) {
    return null;
  }

  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) return null;
  return realpathSync(resolved);
}
