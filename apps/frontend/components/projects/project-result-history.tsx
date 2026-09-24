"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, History } from "lucide-react";
import { archivedCustomerAnalysis, parseProjectResultHistory, type ProjectResultHistoryEntry } from "@/lib/project-result-history";
import type { CustomerAnalysisResult, ProjectDocument } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/components/projects/project-workspace-shared";

const HistoricalAnalysisTab = dynamic(
  () => import("@/components/projects/project-analysis-tab").then((module) => module.ProjectAnalysisTab),
  { ssr: false, loading: () => <p role="status" className="py-6 text-sm text-slate-600">Laster tidligere kundeanalyse …</p> },
);
const titles: Record<string, string> = { customer_analyses: "Kundeanalyse", solution_evaluations: "Løsningsvurdering", executive_summaries: "Lederoppsummering" };
const labels: Record<string, string> = {
  customer_profile_summary: "Kunden", customer_goals_summary: "Kundens mål", executive_summary: "Oppsummering",
  high_level_solution_design: "Løsningsdesign", high_level_architecture_mermaid: "Arkitekturdiagram",
  implicit_requirements: "Behov", prioritized_requirements: "Prioriterte krav", ambiguities: "Avklaringer",
  risks: "Risiko", risks_for_us: "Risiko for oss", risks_for_customer: "Risiko for kunden",
  recommended_services: "Anbefalte tjenester", value_opportunities: "Verdimuligheter",
  positioning_recommendations: "Posisjonering", section_histories: "Tidligere seksjonsversjoner",
  strengths: "Styrker", weaknesses: "Svakheter", improvement_recommendations: "Anbefalte forbedringer",
  missing_elements: "Mangler", architecture_comparison: "Arkitektursammenligning", requirement_coverage: "Kravdekning",
};
function readable(value: unknown, depth = 0): string {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(item => readable(item, depth + 1)).filter(Boolean).join("\n\n");
  return Object.entries(value).filter(([key]) => key !== "revision" && !/_ids?$/.test(key))
    .map(([key, item]) => {
      const text = readable(item, depth + 1);
      return text ? `${depth === 0 && labels[key] ? `${labels[key]}\n` : ""}${text}` : "";
    }).filter(Boolean).join("\n\n");
}
export function ProjectResultHistory({ projectId, documents, children }: {
  projectId: string;
  documents: ProjectDocument[];
  children: ReactNode;
}) {
  const [entries, setEntries] = useState<ProjectResultHistoryEntry[] | null>(null);
  const [selected, setSelected] = useState<{ entry: ProjectResultHistoryEntry; analysis: CustomerAnalysisResult } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (selected) historyHeading.current?.focus();
  }, [selected]);

  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/customer-analysis?history=1`, {
        cache: "no-store", signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("Kunne ikke hente historikken. Prøv igjen.");
      const history = parseProjectResultHistory(payload);
      if (!controller.signal.aborted) setEntries(history);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Kunne ikke hente historikken.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function openAnalysis(entry: ProjectResultHistoryEntry) {
    try {
      const analysis = archivedCustomerAnalysis(entry.result_json);
      setSelected({ entry, analysis });
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Kunne ikke vise denne versjonen.");
    }
  }

  function showCurrent() {
    setSelected(null);
    returnButton.current?.focus();
  }

  return <>
    <section className="mb-4 rounded-lg border bg-white p-4" aria-label="Tidligere resultater">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Tidligere resultater</h3>
          <p className="text-xs text-slate-600">Åpne en tidligere kundeanalyse med faner og full visning. Versjonene er skrivebeskyttet.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {expanded && entries && <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>Oppdater historikk</Button>}
          <Button ref={returnButton} variant="outline" size="sm" disabled={loading} aria-expanded={expanded} onClick={() => {
            setExpanded(!expanded);
            if (!expanded && !entries) void load();
          }}>{loading ? "Henter …" : expanded ? "Skjul historikk" : "Vis historikk"}</Button>
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {expanded && entries?.length === 0 && <p className="mt-3 text-sm">Ingen tidligere resultater ennå.</p>}
      {expanded && entries?.map(entry => entry.kind === "customer_analyses" ? (
        <button key={entry.id} type="button" aria-pressed={selected?.entry.id === entry.id}
          className="mt-3 flex w-full items-start gap-3 rounded-md border px-3 py-3 text-left text-sm text-slate-700 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 aria-pressed:border-blue-300 aria-pressed:bg-blue-50"
          onClick={() => openAnalysis(entry)}>
          <History className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0"><span className="block font-medium">Kundeanalyse · {formatDate(entry.archived_at)}</span>
            <span className="mt-1 block text-xs text-slate-500">{entry.reason === "replaced" ? "Erstattet" : "Grunnlaget ble endret"} · Åpne analyse</span>
          </span>
        </button>
      ) : <details key={entry.id} className="mt-3 border-t pt-3">
        <summary className="cursor-pointer text-sm">{titles[entry.kind] ?? "Resultat"} · {formatDate(entry.archived_at)} · {entry.reason === "replaced" ? "Erstattet" : "Grunnlaget ble endret"}</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6">{readable(entry.result_json)}</pre>
      </details>)}
    </section>
    {selected && <section aria-label="Historisk kundeanalyse" className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="min-w-0">
          <h3 ref={historyHeading} tabIndex={-1} className="text-sm font-semibold text-amber-950 focus:outline-none">Tidligere kundeanalyse · {formatDate(selected.entry.archived_at)}</h3>
          <p className="mt-1 text-xs text-amber-900">Historisk versjon. Vises for lesing og er ikke gjeldende analyse.</p>
        </div>
        <Button variant="outline" size="sm" className="max-w-full whitespace-normal" onClick={showCurrent}>
          <ArrowLeft data-icon="inline-start" />Tilbake til gjeldende analyse
        </Button>
      </div>
      <HistoricalAnalysisTab key={selected.entry.id} projectId={projectId} documents={documents}
        customerAnalysis={selected.analysis} readOnly busy={false} saveBusy={false}
        sectionBusy={null} busyMessage="" busyProgress={0} />
    </section>}
    <div hidden={Boolean(selected)}>{children}</div>
  </>;
}
