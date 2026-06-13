#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

if (!process.argv[2]) {
  process.argv.push(
    path.join(repoRoot, "scripts", "rag_eval_cases.example.json"),
  );
}

await import("../../../scripts/rag_eval.mjs");
