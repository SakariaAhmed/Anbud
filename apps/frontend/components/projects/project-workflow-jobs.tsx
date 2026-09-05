"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { startProjectJob } from "@/lib/client/project-api";
import type { ProjectJobRecord } from "@/lib/types";

export function ProjectWorkflowJobs({ projectId }: { projectId: string }) {
  const [jobs, setJobs] = useState<ProjectJobRecord[]>([]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = false;
    const refresh = async () => {
      if (active || document.visibilityState === "hidden") return;
      active = true;
      try {
        const response = await fetch(`/api/projects/${projectId}/jobs`, { cache: "no-store", signal: controller.signal });
        if (response.ok) { const payload = await response.json(); if (!controller.signal.aborted) setJobs(payload.jobs); }
      } catch { /* Keep the last confirmed job state during a reconnect. */ }
      finally { active = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 10_000);
    window.addEventListener("project-workflow-updated", refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("project-workflow-updated", refresh); };
  }, [projectId]);
  const activeJobs = jobs.filter(job => job.status === "queued" || job.status === "running");
  const newestPerfect = jobs.find(job => job.kind === "perfect_system_solution");
  const pending = newestPerfect?.result && "completion_status" in newestPerfect.result && newestPerfect.result.completion_status === "evaluation_pending" ? newestPerfect.result : null;
  async function resume() {
    if (!pending || !("resume_request" in pending)) return;
    setStarting(true); setError("");
    try {
      const job = await startProjectJob({ projectId, body: pending.resume_request, fallbackMessage: "Kunne ikke fortsette revurderingen." });
      setJobs(current => [job, ...current]);
      window.dispatchEvent(new Event("project-workflow-updated"));
    } catch (e) { setError(e instanceof Error ? e.message : "Kunne ikke fortsette revurderingen."); }
    finally { setStarting(false); }
  }
  if (!activeJobs.length && !pending && !error) return null;
  return <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm" aria-live="polite">
    {activeJobs.map(job => <p key={job.id}>{job.status === "queued" ? "I kø" : "Pågår"}: {job.message}</p>)}
    {pending && <><p>Løsningsutkastet er lagret. Revurdering gjenstår.</p>
      <Button className="mt-2" size="sm" variant="outline" disabled={starting || activeJobs.length > 0} onClick={() => void resume()}>Fortsett revurdering</Button></>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </div>;
}
