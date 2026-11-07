#!/usr/bin/env node

import { reportBackfillFailure, runBackfillCommand } from "../../../scripts/backfill_document_chunks.mjs";

runBackfillCommand().catch(reportBackfillFailure);
