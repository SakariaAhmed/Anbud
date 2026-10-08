"use client";

import { useEffect, useState, type ReactNode } from "react";
import { archivedCustomerAnalysis, parseProjectResultHistory } from "@/lib/project-result-history";
import type { CustomerAnalysisResult } from "@/lib/types";
import { Button } from "@/components/ui/button";

export function ProjectAnalysisResult({ projectId, currentAnalysis, hasCurrentAnalysis, snapshotRevision, children }: {
  projectId: string;
  currentAnalysis: CustomerAnalysisResult | null;
  hasCurrentAnalysis: boolean;
  snapshotRevision?: number;
  children: (fallback: CustomerAnalysisResult | null) => ReactNode;
}) {
  const [latest, setLatest] = useState<CustomerAnalysisResult | null>(null);
  const [latestLoaded, setLatestLoaded] = useState(false);
  const [latestError, setLatestError] = useState("");
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (currentAnalysis) {
      setLatest(currentAnalysis);
      setLatestLoaded(true);
      return;
    }
    if (hasCurrentAnalysis) return;
    const controller = new AbortController();
    setLatestError("");
    void fetch(`/api/projects/${projectId}/customer-analysis?history=latest`, {
      cache: "no-store", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("Kunne ikke hente siste lagrede kundeanalyse.");
      const history = parseProjectResultHistory(await response.json());
      const analysis = history[0] ? archivedCustomerAnalysis(history[0].result_json) : null;
      if (!controller.signal.aborted) {
        setLatest(analysis);
        setLatestLoaded(true);
      }
    }).catch(error => {
      if (!controller.signal.aborted) setLatestError(error instanceof Error ? error.message : "Kunne ikke hente siste lagrede kundeanalyse.");
    });
    return () => controller.abort();
  }, [projectId, currentAnalysis, hasCurrentAnalysis, snapshotRevision, retryToken]);

  return <>
      {!currentAnalysis && !hasCurrentAnalysis && latestError && <div role="alert" className="mb-4 rounded-lg border p-4">
        <p className="text-sm text-red-700">{latestError}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => setRetryToken(value => value + 1)}>Prøv igjen</Button>
      </div>}
      {!currentAnalysis && !hasCurrentAnalysis && latest && <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        Siste lagrede kundeanalyse vises. Dokumentgrunnlaget er endret. Generer en ny analyse for å ta med endringene.
      </p>}
      {!currentAnalysis && !hasCurrentAnalysis && !latestLoaded && !latestError
        ? <p role="status" className="py-6 text-sm text-slate-600">Henter siste lagrede kundeanalyse …</p>
        : hasCurrentAnalysis || currentAnalysis
          ? children(null)
          : (latest || !latestError) && children(latest)}
  </>;
}
