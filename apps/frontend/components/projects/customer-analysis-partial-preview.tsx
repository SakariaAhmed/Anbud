"use client";

import { useEffect, useState } from "react";
import { createProjectActivityPoller } from "@/lib/client/project-activity";
import type { CustomerAnalysisPartial } from "@/lib/types";

const LABELS: Record<string, string> = {
  customer_profile_summary: "Kundesituasjon", customer_goals_summary: "Kundens mål",
  high_level_solution_design: "Anbefalt løsningsdesign", high_level_architecture_mermaid: "Arkitekturskisse",
  customer_profile: "Kundeprofil", customer_goals: "Mål", implicit_requirements: "Underliggende behov",
  prioritized_requirements: "Prioriterte krav", ambiguities: "Avklaringsbehov", risks: "Risiko",
  risks_for_us: "Risiko for oss", risks_for_customer: "Risiko for kunden", likely_evaluation_criteria: "Mulige evalueringskriterier",
  signal_words: "Nøkkelord", expected_solution_direction: "Forventet løsningsretning", recommended_services: "Anbefalte tjenester",
  value_opportunities: "Verdimuligheter", positioning_recommendations: "Anbefalt posisjonering", executive_summary: "Strategisk bakgrunn",
  title: "Tittel", description: "Beskrivelse", category: "Kategori", importance: "Betydning", kind: "Type",
  source_reference: "Kilde", source_excerpt: "Kildesitat", requirement: "Krav", priority: "Prioritet", reason: "Begrunnelse",
  service_name: "Tjeneste", usefulness_percent: "Nytte i prosent", customer_need: "Kundebehov", recommendation_reason: "Begrunnelse",
  evidence: "Grunnlag", risk_or_caveat: "Risiko eller forbehold", value_categories: "Verdikategori", profit_share_percent: "Andel i prosent",
};

function PreviewValue({ value }: { value: unknown }) {
  if (typeof value === "string" || typeof value === "number") return <p className="whitespace-pre-wrap break-words">{value}</p>;
  if (Array.isArray(value)) return value.length ? <ul className="space-y-2 pl-4 list-disc">{value.map((item, index) => <li key={index}><PreviewValue value={item} /></li>)}</ul> : <p>Ingen punkter i dette feltet.</p>;
  if (value && typeof value === "object") return <dl className="space-y-2">{Object.entries(value).filter(([key]) => key !== "service_id").map(([key, item]) => <div key={key}><dt className="font-medium">{LABELS[key] ?? "Opplysning"}</dt><dd><PreviewValue value={item} /></dd></div>)}</dl>;
  return null;
}

export function CustomerAnalysisPartialPreview({ projectId, busy }: { projectId: string; busy: boolean }) {
  const [partial, setPartial] = useState<CustomerAnalysisPartial | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let observedActive = false;
    async function read() {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/customer-analysis/partial`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Preview read failed");
        const body = await response.json() as { partial: CustomerAnalysisPartial | null };
        if (!controller.signal.aborted) {
          observedActive = body.partial?.job_status === "running";
          setPartial(body.partial); setReadFailed(false);
        }
      } catch {
        if (!controller.signal.aborted) { setPartial(null); setReadFailed(true); }
      }
    }
    // Discover other users' analysis independently of the 60-second idle jobs
    // snapshot. Reuse the shared visibility/wakeup and non-overlapping loop.
    const poller = createProjectActivityPoller({
      refresh: read,
      delayMs: () => busy || observedActive ? 2_000 : 5_000,
      isHidden: () => document.visibilityState === "hidden",
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
    void poller.refreshNow();
    return () => {
      controller.abort(); poller.stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("project-workflow-updated", onWorkflowUpdated);
    };
  }, [projectId, busy]);

  if (readFailed) return <p role="status" className="mb-4 text-sm text-amber-800">Forhåndsvisningen kunne ikke oppdateres. Last inn siden på nytt for å prøve igjen.</p>;
  if (!partial || !Object.keys(partial.fields).length) return null;
  return <section aria-label="Ufullstendig kundeanalyse" className="mb-5 min-w-0 border-l-4 border-amber-500 bg-amber-50 p-4 text-sm">
    <p role="status" className="font-semibold">Ufullstendig forhåndsvisning · {Object.keys(partial.fields).length} ferdig mottatte felt</p>
    <p className="mt-1">{partial.job_status === "failed" ? "Analysen stoppet før den ble ferdig. Mottatte felt er bevart. Start analysen på nytt for å få et fullstendig resultat." : "Analysen pågår. Her vises bare feltene som er ferdig mottatt."} Innholdet er foreløpig og brukes ikke i videre arbeid før hele analysen er lagret.</p>
    <div className="mt-3 space-y-2">{Object.entries(partial.fields).map(([key, value]) => <details key={key} className="min-w-0 border-t border-amber-200 pt-2">
      <summary className="cursor-pointer break-words font-medium focus-visible:outline-2 focus-visible:outline-blue-600">{LABELS[key] ?? "Analysefelt"}</summary>
      <div className="mt-2 min-w-0 leading-6 [overflow-wrap:anywhere]"><PreviewValue value={value} /></div>
    </details>)}</div>
  </section>;
}
