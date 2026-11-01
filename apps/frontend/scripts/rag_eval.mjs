#!/usr/bin/env node

if (process.argv[2] && !process.argv[2].startsWith("--")) {
  await import("../../../scripts/rag_eval.mjs");
} else {
  if (!process.argv.includes("--gate")) process.argv.push("--gate");
  await import("../../../scripts/rag_retrieval_eval.mjs");
}
