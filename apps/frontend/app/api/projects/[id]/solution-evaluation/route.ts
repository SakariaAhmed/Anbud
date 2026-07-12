import { NextResponse } from "next/server";

import {
  getFreshCustomerAnalysis,
  getFreshSolutionEvaluation,
} from "@/lib/server/repositories/analyses";
import { auditEvent } from "@/lib/server/observability";
import { prepareProjectAiJsonRoute } from "@/lib/server/project-ai-route";
import {
  getProjectJob,
  queueSolutionEvaluationJob,
  runQueuedProjectJob,
  scheduleHeavyProjectJobAutorun,
} from "@/lib/server/project-jobs";
import { projectWorkflowTimeoutMs } from "@/lib/server/project-workflow-deadline";
import {
  DirectSolutionEvaluationWaitTimeoutError,
  legacySolutionEvaluationPayload,
  requestPrefersAsyncSolutionEvaluation,
  waitForDirectSolutionEvaluationJob,
  waitForDirectSolutionEvaluationTask,
} from "@/lib/server/direct-solution-evaluation";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

const READ_CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
};

export const maxDuration = 2100;

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const evaluation = await getFreshSolutionEvaluation(id);

    return NextResponse.json({ evaluation }, { headers: READ_CACHE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(
          error,
          "Kunne ikke hente løsningsvurderingen.",
        ),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const preflight = await prepareProjectAiJsonRoute<{
      solution_document_id?: string;
    }>(
      request,
      context,
      {
        scopePrefix: "solution-evaluation",
        message: "For mange løsningsvurderinger på kort tid.",
        limit: 8,
        windowMs: 5 * 60_000,
        fallbackBody: {},
      },
    );
    if (preflight.response) {
      return preflight.response;
    }

    const { id, model, body } = preflight;

    if (!(await getFreshCustomerAnalysis(id))) {
      return NextResponse.json({ error: "Generer kundeanalyse før løsningsvurdering." }, { status: 400 });
    }

    let queueCoalesced = false;
    const queuedJob = await queueSolutionEvaluationJob(
      {
        projectId: id,
        solutionDocumentId:
          typeof body.solution_document_id === "string"
            ? body.solution_document_id
            : undefined,
        model,
      },
      {
        autoRun: false,
        onDisposition: ({ coalesced }) => {
          queueCoalesced = coalesced;
        },
      },
    );
    await auditEvent({
      action: "project_job_accepted",
      projectId: id,
      entityType: "project_job",
      entityId: queuedJob.id,
      metadata: {
        route: "direct",
        kind: "solution_evaluation",
        coalesced: queueCoalesced,
        solution_document_id:
          typeof body.solution_document_id === "string"
            ? body.solution_document_id
            : null,
        model: model ?? null,
      },
    });

    if (requestPrefersAsyncSolutionEvaluation(request)) {
      return NextResponse.json({ job: queuedJob }, { status: 202 });
    }

    const directTimeoutMs =
      projectWorkflowTimeoutMs("solution_evaluation") + 60_000;
    const directDeadline = Date.now() + directTimeoutMs;
    let directRunFailed = false;
    let directRunError: unknown;
    if (!queueCoalesced || queuedJob.status === "queued") {
      await waitForDirectSolutionEvaluationTask({
        task: scheduleHeavyProjectJobAutorun(async () => {
          try {
            await runQueuedProjectJob(queuedJob.id);
          } catch (error) {
            directRunFailed = true;
            directRunError = error;
            throw error;
          }
        }),
        signal: request.signal,
        timeoutMs: directTimeoutMs,
      });
    }
    if (directRunFailed) {
      throw directRunError;
    }
    const currentJob = await waitForDirectSolutionEvaluationTask({
      task: getProjectJob(id, queuedJob.id),
      signal: request.signal,
      timeoutMs: Math.max(0, directDeadline - Date.now()),
    });
    const terminalJob = await waitForDirectSolutionEvaluationJob({
      initialJob: currentJob ?? queuedJob,
      readJob: () => getProjectJob(id, queuedJob.id),
      signal: request.signal,
      timeoutMs: Math.max(0, directDeadline - Date.now()),
    });
    const result = legacySolutionEvaluationPayload(terminalJob);

    return NextResponse.json(result);
  } catch (error) {
    const timedOut = error instanceof DirectSolutionEvaluationWaitTimeoutError;
    return NextResponse.json(
      {
        error: timedOut
          ? "Løsningsvurderingen fortsetter i bakgrunnen. Prøv å hente resultatet igjen om litt."
          : productionSafeErrorMessage(
              error,
              "Kunne ikke generere løsningsvurdering.",
            ),
      },
      { status: timedOut ? 504 : 500 },
    );
  }
}
