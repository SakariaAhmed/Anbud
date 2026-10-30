"use client";
import { useState } from "react";
import { WorkflowBlockedHint } from "@/components/projects/workflow-blocked-hint";
import { Button } from "@/components/ui/button";
import { isProjectWorkflowBusyError, startProjectJob } from "@/lib/client/project-api";
import type { ProjectJobRecord } from "@/lib/types";
import { parseJobProgress } from "@/lib/project-job-progress";

/** Active jobs and a resumable solution draft, from the workspace activity loop. */
export function ProjectWorkflowJobs({
  projectId,
  jobs,
  blockedReason,
  onJobStarted,
  onRefreshJobs,
}: {
  projectId: string;
  jobs: ProjectJobRecord[];
  /** Why the server would refuse a new job now (active jobs or unfinished documents). */
  blockedReason: string | null;
  onJobStarted: (job: ProjectJobRecord) => void;
  onRefreshJobs: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [starting, setStarting] = useState(false);
  const activeJobs = jobs.filter(job => job.status === "queued" || job.status === "running");
  const newestPerfect = jobs.find(job => job.kind === "perfect_system_solution");
  const pending = newestPerfect?.result && "completion_status" in newestPerfect.result && newestPerfect.result.completion_status === "evaluation_pending" ? newestPerfect.result : null;
  async function resume() {
    if (!pending || !("resume_request" in pending)) return;
    setStarting(true); setError(""); setNotice("");
    try {
      const job = await startProjectJob({ projectId, body: pending.resume_request, fallbackMessage: "Kunne ikke fortsette revurderingen." });
      onJobStarted(job);
      window.dispatchEvent(new Event("project-workflow-updated"));
    } catch (e) {
      if (isProjectWorkflowBusyError(e)) {
        setNotice(e instanceof Error ? e.message : "");
        void onRefreshJobs();
      } else {
        setError(e instanceof Error ? e.message : "Kunne ikke fortsette revurderingen.");
      }
    }
    finally { setStarting(false); }
  }
  if (!activeJobs.length && !pending && !error && !notice) return null;
  return <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm" aria-live="polite">
    {activeJobs.map(job => <p key={job.id}>{job.status === "queued" ? "I kø" : "Pågår"}: {parseJobProgress(job.message).label}</p>)}
    {pending && <><p>Løsningsutkastet er lagret. Revurdering gjenstår.</p>
      <Button className="mt-2" size="sm" variant="outline" aria-describedby={blockedReason && !activeJobs.length ? "resume-workflow-blocked" : undefined} disabled={starting || Boolean(blockedReason)} onClick={() => void resume()}>Fortsett revurdering</Button>
      {!activeJobs.length ? <div className="mt-2"><WorkflowBlockedHint id="resume-workflow-blocked" reason={blockedReason} /></div> : null}</>}
    {notice && !activeJobs.length && <p className="mt-2">{notice}</p>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </div>;
}
