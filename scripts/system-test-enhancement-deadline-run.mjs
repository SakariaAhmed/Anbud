#!/usr/bin/env node
// Runs one queued enhancement job as the worker would, against the owned stack,
// with a parser that outlives the shortest deadline the application accepts.
// Only the deadline and the parser command differ from the running application.
import { createRequire } from "node:module";
import path from "node:path";

const [jobId, cacheStub, lateMs] = process.argv.slice(2);
const frontend = path.resolve(import.meta.dirname, "../apps/frontend");
const { createJiti } = createRequire(path.join(frontend, "package.json"))("jiti");
// next/cache needs a request store; the harness reads authoritative state instead.
const app = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null", "next/cache": cacheStub } });
const { runQueuedProjectJob } = await app.import(path.join(frontend, "lib/server/project-jobs.ts"));
await runQueuedProjectJob(jobId);
// Stay alive so the abandoned workflow can attempt to write when its parser returns.
await new Promise(resolve => setTimeout(resolve, Number(lateMs)));
process.exit(0);
