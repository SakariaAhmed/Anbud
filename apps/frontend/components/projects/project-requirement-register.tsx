"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { recordWorkflowRenderAfterPaint, workflowCacheState } from "@/lib/client/workflow-render-metric";
import { Input } from "@/components/projects/primitives";
import { Button } from "@/components/ui/button";
import { parseProjectRequirementRegister } from "@/lib/project-requirement-register";
import type { ProjectRequirementRegister } from "@/lib/types";

export function ProjectRequirementRegisterPreview({ projectId, refreshKey, processing = false }: { projectId: string; refreshKey: string; processing?: boolean }) {
  const [register, setRegister] = useState<ProjectRequirementRegister | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const viewEpisode = useRef<{ projectId: string; startedAt: number; firstRead: boolean } | null>(null);
  useEffect(() => {
    // Processing, refresh and retry updates belong to the same open view.
    // Capture its object so an abandoned request cannot consume a new project's read.
    if (!viewEpisode.current || viewEpisode.current.projectId !== projectId) {
      viewEpisode.current = { projectId, startedAt: performance.now(), firstRead: true };
    }
    const episode = viewEpisode.current;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRegister(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/requirement-register`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Kunne ikke hente kravregisteret.");
        const next = parseProjectRequirementRegister(await response.json());
        if (!abort.signal.aborted) {
          setRegister(next); setError("");
          // Only this view's first read measures rendering. Rows that appear
          // while polling measure ingestion, which upload_to_ready already owns.
          for (const document of next.documents) {
            // Successful empty reads count for cache state, even though only
            // an initially populated response qualifies for render timing.
            const cacheState = workflowCacheState(`register:${document.id}:${document.source_revision}`);
            if (!episode.firstRead || !document.rows.length) continue;
            recordWorkflowRenderAfterPaint(projectId, { phase: "requirement_register_render", traceId: document.id, documentId: document.id, sourceRevision: document.source_revision, cacheState }, episode.startedAt, abort.signal);
          }
          episode.firstRead = false;
        }
      } catch { if (!abort.signal.aborted) { episode.firstRead = false; setError("Kunne ikke hente kravregisteret. Prøv igjen."); } }
      finally { if (processing && !abort.signal.aborted) timer = setTimeout(() => void load(), 2500); }
    };
    void load();
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [projectId, refreshKey, processing, retry]);
  const rows = useMemo(() => register?.documents.flatMap(document => document.rows.map(row => ({ ...row, documentId: document.id, documentTitle: document.title }))) ?? [], [register]);
  // Rows show the source's own dashes; a typed hyphen still finds them.
  const searchable = (value: string) => value.replace(/[‐‑‒–—]/gu, "-").toLocaleLowerCase("nb");
  const filtered = rows.filter(row => searchable(`${row.id} ${row.text} ${row.heading} ${row.documentTitle}`).includes(searchable(query)));
  if (!register && !error) return <p role="status" className="py-3 text-sm text-muted-foreground">Henter dokumentets kravregister …</p>;
  if (!rows.length && !error) return processing ? <p role="status" className="py-3 text-sm text-muted-foreground">Kravregisteret vises så snart dokumentet er lest og lagret. Dokumentbehandlingen pågår.</p> : null;
  return <section aria-label="Kravregister" className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-base font-semibold">Kravregister</h3><p className="text-xs text-muted-foreground">{rows.length} krav · hentet fra lagrede dokumenter</p></div>
    {processing ? <p className="text-xs text-muted-foreground">Du kan lese kravene nå. Ny generering venter til dokumentbehandlingen er ferdig.</p> : null}
    {error ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm"><span>{error}</span><Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>Prøv igjen</Button></div> : null}
    <Input aria-label="Søk i kravregister" placeholder="Søk etter krav-ID, tekst eller kapittel" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="max-h-96 overflow-y-auto rounded-md border">
      {filtered.length ? filtered.map((row, index) => <article key={`${row.documentId}:${row.id}:${index}`} className="min-w-0 border-b p-3 last:border-0 [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><h4 className="font-semibold">{row.id}</h4>{row.id_origin !== "source" ? <span className="text-xs text-muted-foreground">{row.id_origin === "inferred" ? "Utledet ID – må kontrolleres" : "Lokal ID – mangler ID i kilden"}</span> : null}</div>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{row.text}</p>
        <p className="mt-1 text-xs text-muted-foreground">{row.text_origin === "observed" ? "Ordlyden er funnet i originalteksten." : row.text_origin === "reconstructed" ? "Sammenstilt ordlyd – kontroller originaldokumentet." : "Ordlydens opprinnelse er ikke kontrollert for dette eldre registeret."}</p>
        {row.original_text && row.original_text.replace(/\s+/gu, " ").trim() !== row.text ? <details className="mt-1 text-xs"><summary>Vis original ordlyd</summary><blockquote className="mt-1 whitespace-pre-wrap">{row.original_text}</blockquote></details> : null}
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{[row.documentTitle, row.heading, row.pages.length ? `Side ${row.pages.join(", ")}` : "Side ikke oppgitt"].filter(Boolean).join(" · ")}</p>
      </article>) : <p className="p-3 text-sm text-muted-foreground">Ingen krav samsvarer med søket. Prøv en annen formulering.</p>}
    </div>
  </section>;
}
