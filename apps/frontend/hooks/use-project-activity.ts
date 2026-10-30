"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import {
  createProjectActivityPoller,
  createProjectJobsSource,
  hasActiveProjectWork,
  projectActivityPollDelayMs,
  projectWorkflowBlockingReason,
} from "@/lib/client/project-activity";
import { fetchProjectJobs, invalidateProjectJobsCache } from "@/lib/client/project-api";
import type { ProjectDocument, ProjectJobRecord } from "@/lib/types";

type ActivityControls = {
  source: ReturnType<typeof createProjectJobsSource>;
  poller: ReturnType<typeof createProjectActivityPoller>;
};

/**
 * The workspace's single refresh loop for project jobs and project state.
 * It polls quickly only while jobs or documents are being processed, keeps a
 * slow heartbeat otherwise, pauses while the tab is hidden and refreshes once
 * when the user returns. "project-workflow-updated" refreshes immediately.
 */
export function useProjectActivity(input: {
  projectId: string;
  documents: readonly Pick<ProjectDocument, "processing_status">[];
  refreshProject: () => Promise<void>;
}) {
  const { projectId, documents } = input;
  const [jobs, setJobs] = useState<ProjectJobRecord[]>([]);
  const jobsRef = useRef(jobs);
  const documentsRef = useRef(documents);
  const refreshProjectRef = useRef(input.refreshProject);
  const controlsRef = useRef<ActivityControls | null>(null);
  useEffect(() => {
    documentsRef.current = documents;
    refreshProjectRef.current = input.refreshProject;
  });

  useEffect(() => {
    let disposed = false;
    const source = createProjectJobsSource({
      read: () => fetchProjectJobs(projectId),
      invalidate: () => invalidateProjectJobsCache(projectId),
      onChange(next) {
        jobsRef.current = next;
        // The first job read lands while server-rendered tabs may still be
        // hydrating; as a transition it cannot force them back to "Laster ...".
        if (!disposed) startTransition(() => setJobs(next));
      },
    });
    const poller = createProjectActivityPoller({
      async refresh() {
        await Promise.all([source.refresh(), refreshProjectRef.current()]);
      },
      delayMs: () =>
        projectActivityPollDelayMs({
          jobs: jobsRef.current,
          documents: documentsRef.current,
        }),
      isHidden: () => document.visibilityState === "hidden",
    });
    const controls = { source, poller };
    controlsRef.current = controls;

    // The server rendered the project; only the job list needs a first read.
    void source.refresh().catch(() => undefined).finally(() => {
      if (!disposed) poller.start();
    });
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") poller.sleep();
      else poller.wake();
    };
    const onFocus = () => poller.wake();
    const onWorkflowUpdated = () => void poller.refreshNow();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("project-workflow-updated", onWorkflowUpdated);
    return () => {
      disposed = true;
      poller.stop();
      if (controlsRef.current === controls) controlsRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("project-workflow-updated", onWorkflowUpdated);
    };
  }, [projectId]);

  const active = hasActiveProjectWork({ jobs, documents });
  useEffect(() => {
    controlsRef.current?.poller.reschedule();
  }, [active]);

  /**
   * Apply a job the user started, or a status update the page already read.
   * The cadence follows through the activity effect above, so frequent status
   * updates do not keep postponing the next project refresh.
   */
  const recordJob = useCallback((job: ProjectJobRecord) => {
    controlsRef.current?.source.record(job);
  }, []);
  const refreshJobs = useCallback(
    () => controlsRef.current?.poller.refreshNow() ?? Promise.resolve(),
    [],
  );

  return {
    jobs,
    blockingReason: projectWorkflowBlockingReason({ jobs, documents }),
    recordJob,
    refreshJobs,
  };
}
