"use client";
import { useMemo, useState } from "react";
import { Input } from "@/components/projects/primitives";
import { projectFollowUpItems, type ProjectFollowUp } from "@/lib/project-follow-up";
import type { CustomerAnalysisResult, GeneratedArtifact, SolutionEvaluationResult } from "@/lib/types";

export function ProjectFollowUpPanel({ artifacts, analysis, evaluation }: { artifacts: GeneratedArtifact[]; analysis: CustomerAnalysisResult | null; evaluation: SolutionEvaluationResult | null }) {
  const items = useMemo(() => projectFollowUpItems({ artifacts, analysis, evaluation }), [artifacts, analysis, evaluation]);
  const [kind, setKind] = useState<ProjectFollowUp["kind"] | "all">("all");
  const [query, setQuery] = useState("");
  const shown = items.filter(item => (kind === "all" || item.kind === kind) && `${item.reference} ${item.description}`.toLocaleLowerCase("nb").includes(query.toLocaleLowerCase("nb")));
  return <details className="min-w-0 rounded-md border">
    <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Hva mangler? <span className="ml-2 font-normal text-muted-foreground">{items.length} oppfølgingspunkter</span></summary>
    <div className="space-y-3 border-t p-3 sm:p-4">
      <p className="text-xs leading-5 text-muted-foreground">Fra gjeldende kravbesvarelse, lagret løsningsvurdering og åpne avklaringer. {evaluation ? "" : "Ingen løsningsvurdering er lastet inn; dekning er foreløpig ukjent."}</p>
      <div className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1 basis-48" aria-label="Søk i oppfølgingspunkter" placeholder="Søk etter krav, kriterium eller avklaring" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="Filtrer oppfølgingspunkter" className="h-9 max-w-full rounded-md border bg-background px-2 text-sm" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="all">Alle punkter</option><option value="requirement">Kravsvar</option><option value="coverage">Løsningsdekning</option><option value="criterion">Evalueringskriterier</option><option value="clarification">Avklaringer</option></select></div>
      <div className="max-h-96 overflow-y-auto">{shown.map(item => <article key={item.key} className="space-y-1 border-b py-3 last:border-0 [overflow-wrap:anywhere]"><h4 className="text-sm font-semibold">{item.reference}</h4><p className="whitespace-pre-wrap text-sm leading-6">{item.description}</p><p className="text-xs leading-5 text-muted-foreground">Neste steg: {item.nextAction}</p></article>)}{!shown.length ? <p className="py-3 text-sm text-muted-foreground">{items.length ? "Ingen punkter samsvarer med søket og filteret." : "Ingen oppfølgingspunkter er registrert i resultatene som er lastet inn. Kontroller at alle relevante kilder og vurderinger er med før innlevering."}</p> : null}</div>
    </div>
  </details>;
}
