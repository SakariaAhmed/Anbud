import type { ProjectDocument, ProjectJobKind, ProjectJobRecord } from "@/lib/types";

/** Poll interval while a job or document is still being processed. */
export const ACTIVE_PROJECT_POLL_MS = 5_000;
/** Heartbeat while idle, so other users' activity still appears. */
export const IDLE_PROJECT_POLL_MS = 60_000;
/** Focus and visibility events often arrive together; refresh once. */
export const PROJECT_WAKE_DEBOUNCE_MS = 500;

type ActivityDocument = Pick<ProjectDocument, "processing_status">;
type ActivityJob = Pick<ProjectJobRecord, "kind" | "status">;

const JOB_KIND_LABELS: Record<ProjectJobKind, string> = {
  document_ingestion: "Dokumentbehandlingen",
  document_docling_enhancement: "Docling-forbedringen av et dokument",
  customer_analysis: "Kundeanalysen",
  solution_evaluation: "Løsningsvurderingen",
  artifact_generation: "En generering",
  high_level_design: "High-level design",
  perfect_system_solution: "Forbedringen av systemløsningen",
  executive_summary: "Lederoppsummeringen",
};

function isActiveJob(job: ActivityJob) {
  return job.status === "queued" || job.status === "running";
}

function isProcessingDocument(document: ActivityDocument) {
  return document.processing_status === "queued" || document.processing_status === "processing";
}

export function hasActiveProjectWork(input: {
  jobs: readonly ActivityJob[];
  documents: readonly ActivityDocument[];
}) {
  return input.jobs.some(isActiveJob) || input.documents.some(isProcessingDocument);
}

export function projectActivityPollDelayMs(input: {
  jobs: readonly ActivityJob[];
  documents: readonly ActivityDocument[];
}) {
  return hasActiveProjectWork(input) ? ACTIVE_PROJECT_POLL_MS : IDLE_PROJECT_POLL_MS;
}

/**
 * Why the server would refuse a new generation right now, in the order
 * enqueue_project_job_serialized checks it: any queued or running job gives
 * PROJECT_WORKFLOW_BUSY, then any queued or processing document gives
 * DOCUMENT_INDEX_NOT_READY. The server stays authoritative; this only
 * explains a disabled button before the user tries.
 */
export function projectWorkflowBlockingReason(input: {
  jobs: readonly ActivityJob[];
  documents: readonly ActivityDocument[];
}) {
  const activeJobs = input.jobs.filter(isActiveJob);
  if (activeJobs.length > 1) {
    return `${activeJobs.length} jobber pågår eller står i kø. Ny generering kan startes når de er ferdige.`;
  }
  const [job] = activeJobs;
  if (job) {
    const state = job.status === "running" ? "pågår" : "står i kø";
    return `${JOB_KIND_LABELS[job.kind]} ${state}. Ny generering kan startes når jobben er ferdig.`;
  }
  if (input.documents.some(isProcessingDocument)) {
    return "Dokumentbehandlingen er ikke ferdig. Generering kan startes når dokumentene er klare.";
  }
  return null;
}

/**
 * Orders job-list reads and local writes. A read applies only if no newer read
 * or local write (a job the user just started) has been applied since it
 * began, so a slow older response cannot hide a newer job.
 */
export function createProjectJobsSource(input: {
  read: () => Promise<ProjectJobRecord[]>;
  onChange: (jobs: ProjectJobRecord[]) => void;
}) {
  let sequence = 0;
  let applied = 0;
  let jobs: ProjectJobRecord[] = [];

  return {
    async refresh() {
      const requested = ++sequence;
      const next = await input.read();
      if (requested <= applied) return false;
      applied = requested;
      jobs = next;
      input.onChange(jobs);
      return true;
    },
    record(job: ProjectJobRecord) {
      applied = ++sequence;
      jobs = [job, ...jobs.filter((current) => current.id !== job.id)];
      input.onChange(jobs);
    },
  };
}

type PollerTimers = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const browserTimers: PollerTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One refresh loop: the next run is scheduled after the previous one ends,
 * using the delay that matches the current activity. Nothing runs while the
 * page is hidden; waking refreshes once after a short debounce.
 */
export function createProjectActivityPoller(input: {
  refresh: () => Promise<void>;
  delayMs: () => number;
  isHidden: () => boolean;
  timers?: PollerTimers;
  wakeDebounceMs?: number;
}) {
  const timers = input.timers ?? browserTimers;
  let timer: unknown = null;
  let wakeTimer: unknown = null;
  let inFlight = false;
  let rerun = false;
  let stopped = false;

  const clearTimer = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const clearWakeTimer = () => {
    if (wakeTimer !== null) timers.clearTimeout(wakeTimer);
    wakeTimer = null;
  };
  const schedule = () => {
    clearTimer();
    if (stopped || input.isHidden()) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void run();
    }, input.delayMs());
  };
  async function run(): Promise<void> {
    clearTimer();
    if (stopped) return;
    if (inFlight) {
      // A refresh requested mid-flight may concern newer state; run it after.
      rerun = true;
      return;
    }
    inFlight = true;
    try {
      await input.refresh();
    } catch {
      // Keep the last confirmed state; the next run retries.
    } finally {
      inFlight = false;
    }
    if (rerun && !stopped) {
      rerun = false;
      return run();
    }
    schedule();
  }

  return {
    start: schedule,
    refreshNow: run,
    /** Re-plan the pending run after activity changed (e.g. a new upload). */
    reschedule() {
      if (!inFlight) schedule();
    },
    wake() {
      if (stopped || input.isHidden()) return;
      clearWakeTimer();
      wakeTimer = timers.setTimeout(() => {
        wakeTimer = null;
        void run();
      }, input.wakeDebounceMs ?? PROJECT_WAKE_DEBOUNCE_MS);
    },
    sleep() {
      clearTimer();
      clearWakeTimer();
    },
    stop() {
      stopped = true;
      clearTimer();
      clearWakeTimer();
    },
  };
}
