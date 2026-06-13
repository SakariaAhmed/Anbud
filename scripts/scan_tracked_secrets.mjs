#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const args = new Set(process.argv.slice(2));
const scanHistory = args.has("--history");

const secretPatterns = [
  {
    label: "OpenAI API key",
    pattern: /sk(?:-proj)?-[A-Za-z0-9_\-]{30,}/,
  },
  {
    label: "Generic private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    label: "Supabase service role key",
    pattern: /SUPABASE_SERVICE_ROLE_KEY\s*=\s*eyJ[A-Za-z0-9_-]{20,}/,
  },
];

const allowlistedFiles = new Set([".env.example"]);
const envSecretKeyPattern =
  /(?:API_KEY|SERVICE_ROLE_KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE_KEY|ENCRYPTION_KEY)$/i;
const ignoredPathPrefixes = [
  ".next/",
  "apps/frontend/.next/",
  "apps/frontend/node_modules/",
  "node_modules/",
  "coverage/",
  "dist/",
  "build/",
];

function isIgnoredPath(file) {
  return (
    allowlistedFiles.has(file) ||
    ignoredPathPrefixes.some((prefix) => file.startsWith(prefix))
  );
}

function isEnvPath(file) {
  const name = path.basename(file);
  return name === ".env" || name.startsWith(".env.");
}

function isPlaceholderSecret(value) {
  const normalized = value.replace(/^['"]|['"]$/g, "").trim();
  return (
    !normalized ||
    /^<[^>]+>$/.test(normalized) ||
    /^(?:changeme|change-me|example|placeholder|dummy|test|todo|replace_me|your_.+|xxx+)$/i.test(
      normalized,
    )
  );
}

function classifyLine({ file, lineText }) {
  const findings = [];

  for (const { label, pattern } of secretPatterns) {
    if (pattern.test(lineText)) {
      findings.push({ label });
    }
  }

  if (isEnvPath(file)) {
    const assignment = lineText.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (assignment) {
      const [, key, rawValue] = assignment;
      if (envSecretKeyPattern.test(key) && !isPlaceholderSecret(rawValue)) {
        findings.push({ label: `Env secret assignment (${key})` });
      }
    }
  }

  const seen = new Set();
  return findings.filter((finding) => {
    const key = finding.label;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function scanContent({ content, file, scope, commit }) {
  const findings = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    for (const finding of classifyLine({ file, lineText: lines[index] ?? "" })) {
      findings.push({
        ...finding,
        scope,
        commit,
        file,
        line: index + 1,
      });
    }
  }

  return findings;
}

function gitOutput(gitArgs, options = {}) {
  return execFileSync("git", gitArgs, {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    ...options,
  });
}

const files = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: GIT_MAX_BUFFER_BYTES,
})
  .split("\0")
  .filter(Boolean)
  .filter((file) => !isIgnoredPath(file));
const findings = [];
const skippedFiles = [];

for (const file of files) {
  let content = "";
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      skippedFiles.push(file);
      continue;
    }
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const finding of scanContent({ content, file, scope: "current" })) {
    findings.push(finding);
  }
}

function parseGitGrepLine(line) {
  const match = line.match(/^([0-9a-f]{40}):(.+?):(\d+):(.*)$/);
  if (!match) {
    return null;
  }

  const [, commit, file, lineNumber, lineText] = match;
  return {
    commit,
    file,
    line: Number.parseInt(lineNumber, 10),
    lineText,
  };
}

function runGitGrep(grepArgs) {
  const result = spawnSync("git", grepArgs, {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });

  if (result.status && result.status > 1) {
    throw new Error(result.stderr || `git grep failed with status ${result.status}`);
  }

  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function historyFindings() {
  if (!scanHistory) {
    return [];
  }

  const commits = gitOutput(["rev-list", "--all"])
    .split(/\r?\n/)
    .filter(Boolean);
  if (!commits.length) {
    return [];
  }

  const pathspecs = [
    "--",
    ".",
    ":(exclude).next/**",
    ":(exclude)apps/frontend/.next/**",
    ":(exclude)node_modules/**",
    ":(exclude)apps/frontend/node_modules/**",
    ":(exclude)coverage/**",
    ":(exclude)dist/**",
    ":(exclude)build/**",
  ];
  const envPathspecs = [
    "--",
    ":(glob).env*",
    ":(glob)**/.env*",
    ":(exclude).env.example",
    ":(exclude)**/.env.example",
    ":(exclude).next/**",
    ":(exclude)apps/frontend/.next/**",
    ":(exclude)node_modules/**",
    ":(exclude)apps/frontend/node_modules/**",
  ];
  const highConfidencePattern =
    "sk(-proj)?-[A-Za-z0-9_-]{30,}|-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|SUPABASE_SERVICE_ROLE_KEY[[:space:]]*=[[:space:]]*eyJ[A-Za-z0-9_-]{20,}";
  const envAssignmentPattern =
    "^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*(API_KEY|SERVICE_ROLE_KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE_KEY|ENCRYPTION_KEY)[A-Za-z0-9_]*[[:space:]]*=";
  const rawLines = [
    ...runGitGrep(["grep", "-I", "-n", "-E", highConfidencePattern, ...commits, ...pathspecs]),
    ...runGitGrep(["grep", "-I", "-n", "-E", envAssignmentPattern, ...commits, ...envPathspecs]),
  ];
  const history = [];

  for (const rawLine of rawLines) {
    const parsed = parseGitGrepLine(rawLine);
    if (!parsed || isIgnoredPath(parsed.file)) {
      continue;
    }

    for (const finding of classifyLine({
      file: parsed.file,
      lineText: parsed.lineText,
    })) {
      history.push({
        ...finding,
        scope: "history",
        commit: parsed.commit,
        file: parsed.file,
        line: parsed.line,
      });
    }
  }

  return history;
}

findings.push(...historyFindings());

function aggregateHistoryFindings(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.scope !== "history") {
      continue;
    }

    const key = `${item.file}\0${item.label}`;
    const group = groups.get(key) ?? {
      ...item,
      commits: new Set(),
      firstCommit: item.commit,
      lastCommit: item.commit,
    };
    group.commits.add(item.commit);
    group.lastCommit = item.commit;
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    commitCount: group.commits.size,
    commits: undefined,
  }));
}

if (findings.length) {
  console.error("Potential tracked secrets found:");
  for (const finding of findings.filter((item) => item.scope !== "history")) {
    console.error(`- ${finding.file}:${finding.line} ${finding.label}`);
  }
  for (const finding of aggregateHistoryFindings(findings)) {
    console.error(
      `- history ${finding.file}:${finding.line} ${finding.label} commits=${finding.commitCount} first=${finding.firstCommit.slice(0, 12)} last=${finding.lastCommit.slice(0, 12)}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    scanHistory
      ? "No tracked secrets found in current tracked files or reachable history."
      : "No tracked secrets found.",
  );
  if (skippedFiles.length) {
    console.log(
      `Skipped ${skippedFiles.length} non-regular or large tracked files.`,
    );
  }
}
