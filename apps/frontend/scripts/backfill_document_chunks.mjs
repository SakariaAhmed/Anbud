#!/usr/bin/env node

import { runBackfillCommand } from "../../../scripts/backfill_document_chunks.mjs";

runBackfillCommand().catch(() => {
  console.error("Backfill failed; inspect the target and source revision before retrying.");
  process.exitCode = 1;
});
