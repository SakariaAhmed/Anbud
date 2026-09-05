"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/components/projects/project-workspace-shared";

type Entry = { id: string; kind: string; archived_at: string; reason: string; result_json: Record<string, unknown> };
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
export function ProjectResultHistory({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/customer-analysis?history=1`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Kunne ikke hente historikken.");
      setEntries(payload.history);
    } catch (e) { setError(e instanceof Error ? e.message : "Kunne ikke hente historikken."); }
    finally { setLoading(false); }
  }
  return <section className="mb-4 rounded-lg border bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-semibold">Tidligere resultater</h3><p className="text-xs text-slate-600">Bevarte versjoner fra tidligere grunnlag og redigeringer. De er ikke gjeldende.</p></div>
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>{loading ? "Henter …" : "Vis historikk"}</Button>
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    {entries?.length === 0 && <p className="mt-3 text-sm">Ingen tidligere resultater ennå.</p>}
    {entries?.map(entry => <details key={entry.id} className="mt-3 border-t pt-3">
      <summary className="cursor-pointer text-sm">{titles[entry.kind] ?? "Resultat"} · {formatDate(entry.archived_at)} · {entry.reason === "replaced" ? "Erstattet" : "Grunnlaget ble endret"}</summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6">{readable(entry.result_json)}</pre>
    </details>)}
  </section>;
}
