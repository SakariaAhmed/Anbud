"use client";

import { useCallback, useEffect, useRef } from "react";

import { pollProjectJob } from "@/lib/client/project-api";
import type { ProjectJobRecord } from "@/lib/types";

export function useProjectJobRunner({
  projectId,
  onStart,
  onStatus,
}: {
  projectId: string;
  onStart?: (job: ProjectJobRecord) => void;
  onStatus: (job: ProjectJobRecord) => void;
}) {
  const activeJobAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      activeJobAbortRef.current?.abort();
    };
  }, []);

  const waitForProjectJob = useCallback(
    async (
      jobId: string,
      failedFallbackMessage: string,
      initialJob?: ProjectJobRecord,
    ) => {
      activeJobAbortRef.current?.abort();
      const controller = new AbortController();
      activeJobAbortRef.current = controller;
      if (initialJob) {
        onStart?.(initialJob);
      }

      try {
        const job = await pollProjectJob({
          projectId,
          jobId,
          onStatus,
          signal: controller.signal,
        });

        if (job.status === "failed") {
          throw new Error(job.error || failedFallbackMessage);
        }

        return job;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error("Jobben ble avbrutt.");
        }
        throw error;
      } finally {
        if (activeJobAbortRef.current === controller) {
          activeJobAbortRef.current = null;
        }
      }
    },
    [onStart, onStatus, projectId],
  );

  return { waitForProjectJob };
}
