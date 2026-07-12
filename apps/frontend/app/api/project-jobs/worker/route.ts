import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { runAvailableProjectJobs } from "@/lib/server/project-jobs";
import { checkRateLimit } from "@/lib/server/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One workflow may use the full 30-minute internal deadline. Keep five minutes
// for the scheduled container's server startup, queue claim, and shutdown.
export const maxDuration = 2100;

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

  try {
    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      stale_after_ms?: number;
    };
    // A scheduled invocation must never claim a second job after spending most
    // of its replica lifetime on the first one.
    const limit = 1;
    const staleAfterMs =
      Number.isFinite(body.stale_after_ms) && body.stale_after_ms
        ? Math.max(60_000, Number(body.stale_after_ms))
        : undefined;
    const results = await runAvailableProjectJobs({ limit, staleAfterMs });

    return NextResponse.json({
      processed: results.filter((result) => result.status === "processed")
        .length,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Kunne ikke kjøre jobbkøen.",
      },
      { status: 500 },
    );
  }
}
