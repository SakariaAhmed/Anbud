import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { runAvailableProjectJobs } from "@/lib/server/project-jobs";
import { PROJECT_JOB_WORKER_MAX_JOBS } from "@/lib/server/project-job-worker-budget";
import { checkRateLimit } from "@/lib/server/observability";
import { routeErrorResponse } from "@/lib/server/api-responses";
import { readJsonObject } from "@/lib/server/request-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One workflow may use the full 30-minute internal deadline. Keep five minutes
// for the scheduled container's server startup, queue claim, and shutdown.
export const maxDuration = 2100;
const SHUTDOWN_ALLOWANCE_MS = 60_000;
const DEFAULT_STARTUP_ALLOWANCE_MS = 120_000;

/**
 * The scheduled worker sends the deadline measured from its own process start.
 * Without one, assume the slowest server startup. Either way the invocation
 * never plans past its own maximum duration.
 */
function workerDeadlineAt(body: Record<string, unknown>, requestStartedAt: number) {
  const latest = requestStartedAt + maxDuration * 1000 - SHUTDOWN_ALLOWANCE_MS;
  const requested = body.deadline_at;
  if (typeof requested === "number" && Number.isFinite(requested)) {
    return Math.min(requested, latest);
  }
  return latest - DEFAULT_STARTUP_ALLOWANCE_MS;
}

function workerJobLimit(body: Record<string, unknown>) {
  const requested = body.limit;
  return typeof requested === "number" && Number.isSafeInteger(requested)
    ? Math.min(Math.max(requested, 1), PROJECT_JOB_WORKER_MAX_JOBS)
    : 1;
}

function safeTokenEquals(candidate: string | null, expected: string) {
  if (!candidate) {
    return false;
  }

  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function isAuthorized(request: Request) {
  const token = process.env.PROJECT_JOB_WORKER_TOKEN;
  if (!token) {
    return process.env.NODE_ENV !== "production";
  }

  return safeTokenEquals(request.headers.get("x-worker-token"), token);
}

export async function POST(request: Request) {
  const rateLimit = await checkRateLimit(request, "project-jobs-worker", {
    limit: 30,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "For mange worker-kall på kort tid." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Ikke autorisert." }, { status: 401 });
  }

  const requestStartedAt = Date.now();
  try {
    const body = await readJsonObject(request);
    // Further jobs are claimed only while the remaining replica time covers
    // the candidate's full workflow deadline (runProjectJobsWithinBudget).
    const limit = workerJobLimit(body);
    const deadlineAt = workerDeadlineAt(body, requestStartedAt);
    const staleAfterMs =
      typeof body.stale_after_ms === "number" &&
      Number.isFinite(body.stale_after_ms) &&
      body.stale_after_ms
        ? Math.max(60_000, body.stale_after_ms)
        : undefined;
    const results = await runAvailableProjectJobs({ limit, staleAfterMs, deadlineAt });

    return NextResponse.json({
      processed: results.filter((result) => result.status === "processed")
        .length,
      results,
    });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke kjøre jobbkøen.");
  }
}
