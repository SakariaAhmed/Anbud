import { getProjectJob } from "@/lib/server/project-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const encoder = new TextEncoder();

function encodeEvent(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id, jobId } = await context.params;

  const stream = new ReadableStream({
    async start(controller) {
      let previousSignature = "";
      const startedAt = Date.now();

      controller.enqueue(encoder.encode("retry: 1500\n\n"));

      while (!request.signal.aborted) {
        try {
          const job = await getProjectJob(id, jobId);
          if (!job) {
            controller.enqueue(
              encodeEvent("error", { error: "Jobben finnes ikke." }),
            );
            break;
          }

          const signature = JSON.stringify({
            status: job.status,
            message: job.message,
            updated_at: job.updated_at,
            error: job.error,
            has_result: Boolean(job.result),
          });

          if (signature !== previousSignature) {
            controller.enqueue(encodeEvent("job", { job }));
            previousSignature = signature;
          } else {
            controller.enqueue(encodeEvent("heartbeat", { ok: true }));
          }

          if (job.status === "completed" || job.status === "failed") {
            break;
          }

          if (Date.now() - startedAt > 55_000) {
            controller.enqueue(encodeEvent("heartbeat", { reconnect: true }));
            break;
          }
        } catch (error) {
          controller.enqueue(
            encodeEvent("error", {
              error:
                error instanceof Error
                  ? error.message
                  : "Kunne ikke hente jobbstatus.",
            }),
          );
          break;
        }

        await sleep(750, request.signal);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
