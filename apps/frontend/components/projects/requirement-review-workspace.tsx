"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, CheckSquare, Pencil, Save, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/projects/primitives";
import { Textarea } from "@/components/ui/textarea";
import { OutputSourceEvidence } from "@/components/projects/output-source-evidence";
import { isRecord } from "@/lib/unknown-values";
import { SourceEvidenceButton } from "@/components/projects/source-evidence-panel";
import type { RequirementRegenerationSelection } from "@/lib/requirement-regeneration";
import { editRequirementReviewRow, requirementReviewRows, requirementReviewRowMatches, type RequirementReviewRow, type RequirementReviewFilter, type RequirementSourceCheck } from "@/lib/requirement-review";
import { requirementResponseArtifactMetadata } from "@/lib/requirement-response-metadata";
import type { GeneratedArtifact, ProjectDocument } from "@/lib/types";
import { cn } from "@/lib/utils";

export function RequirementReviewWorkspace({ artifact, projectId, documents, canDownloadDocuments = false, canEdit = false, busy = false, onSave, onRegenerate }: {
  artifact: GeneratedArtifact; projectId: string; documents: ProjectDocument[]; canDownloadDocuments?: boolean; canEdit?: boolean; busy?: boolean;
  onSave: (content: string, acknowledge: boolean) => Promise<void>;
  onRegenerate: (selection: RequirementRegenerationSelection) => Promise<void>;
}) {
  const rows = useMemo(() => requirementReviewRows(artifact.content_markdown, artifact.input_snapshot), [artifact]);
  const metadata = useMemo(() => requirementResponseArtifactMetadata(artifact.input_snapshot), [artifact.input_snapshot]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RequirementReviewFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<RequirementSourceCheck | "all">("all");
  const [activeKey, setActiveKey] = useState(rows[0]?.key ?? "");
  const [draftRow, setDraftRow] = useState<RequirementReviewRow | null>(null);
  const editing = draftRow !== null;
  const [answer, setAnswer] = useState("");
  const [evidence, setEvidence] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [regenerationOpen, setRegenerationOpen] = useState(false);
  const [error, setError] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  const filtered = rows.filter(row => requirementReviewRowMatches(row, { query, status: filter, sourceCheck: sourceFilter }));
  const active = draftRow ?? filtered.find(row => row.key === activeKey) ?? filtered[0];
  const activeIndex = active ? filtered.indexOf(active) : -1;
  const unresolved = rows.filter(row => row.needsReview).length;
  const navigate = (offset: number) => { if (!editing && !saving && filtered.length) setActiveKey(filtered[(activeIndex + offset + filtered.length) % filtered.length].key); };
  function edit(row: RequirementReviewRow) { if (!canEdit || busy || editing || saving) return; setAnswer(row.answer); setEvidence(row.evidence); setDraftRow(row); setAcknowledge(false); setError(""); }
  async function save() {
    if (!draftRow || !canEdit || saving || busy) return;
    setSaving(true); setError("");
    try { await onSave(editRequirementReviewRow(artifact.content_markdown, draftRow, { answer, evidence }), acknowledge); setDraftRow(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Kunne ikke lagre svaret. Endringene dine er fortsatt her."); }
    finally { setSaving(false); }
  }
  async function regenerate() {
    if (!canEdit || busy || saving || !artifact.artifact_version) return;
    const chosen = rows.filter(row => selected.has(row.key));
    if (!chosen.length || chosen.some(row => !row.rowHash)) return;
    setSaving(true); setError("");
    try { await onRegenerate({ artifactId: artifact.id, artifactVersion: artifact.artifact_version, rows: chosen.map(row => ({ index: row.index, rowHash: row.rowHash! })) }); setSelected(new Set()); setRegenerationOpen(false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Kunne ikke regenerere utvalgte krav. De lagrede svarene er bevart."); }
    finally { setSaving(false); }
  }
  function shortcuts(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (editing || saving || busy || event.altKey || event.metaKey || event.ctrlKey || target.closest("input,textarea,select,button,[contenteditable=true],[role=dialog]")) return;
    if (event.key === "j" || event.key === "k") { event.preventDefault(); navigate(event.key === "j" ? 1 : -1); }
    if (event.key === "e" && active && canEdit) { event.preventDefault(); edit(active); setTimeout(() => editor.current?.focus(), 0); }
    if (event.key === "a" && active) { event.preventDefault(); setFilter("review"); setSourceFilter("all"); setQuery(""); const next = rows.find(row => row.index > active.index && row.needsReview) ?? rows.find(row => row.needsReview); if (next) setActiveKey(next.key); }
  }
  if (!rows.length) return null;
  return <section aria-label="Gjennomgå kravbesvarelse" onKeyDown={shortcuts} tabIndex={0} className="min-w-0 space-y-3 outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h4 className="font-semibold">Gjennomgå kravbesvarelse</h4><span className="text-xs text-muted-foreground">{unresolved} av {rows.length} krav trenger oppfølging</span></div>
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 basis-48"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" value={query} disabled={editing || saving} onChange={event => setQuery(event.target.value)} placeholder="Søk i ID, krav, svar eller kilde" aria-label="Søk i kravbesvarelse" /></div>
      <select className="h-9 max-w-full rounded-md border bg-background px-2 text-sm" aria-label="Filtrer krav" disabled={editing || saving} value={filter} onChange={event => setFilter(event.target.value as RequirementReviewFilter)}>
        <option value="all">Alle krav</option><option value="review">Trenger oppfølging</option><option value="unanswered">Ubesvart</option><option value="source">Mangler kilde</option>
      </select>
      <select className="h-9 max-w-full rounded-md border bg-background px-2 text-sm" aria-label="Filtrer kildekontroll" disabled={editing || saving} value={sourceFilter} onChange={event => setSourceFilter(event.target.value as RequirementSourceCheck | "all")}>
        <option value="all">Alle kildekontroller</option><option value="verified">Har kontrollert kildeutdrag</option><option value="unverified">Ingen lagret kildekontroll</option><option value="needs_clarification">Kilde må avklares</option>
      </select>
      {metadata.ledgerConfidence?.level ? <span className="text-xs text-muted-foreground">Sikkerhet i kravuttak: {({ high: "høy", medium: "middels", low: "lav" } as Record<string, string>)[metadata.ledgerConfidence.level] ?? "ukjent"}</span> : null}
    </div>
    {canEdit ? <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={editing || busy || saving || !filtered.some(row => row.rowHash)} onClick={() => setSelected(new Set(filtered.filter(row => row.rowHash).slice(0, 100).map(row => row.key)))}>Velg viste krav (maks. 100)</Button><Button variant="outline" size="sm" disabled={editing || busy || saving || !selected.size} onClick={() => setSelected(new Set())}>Fjern utvalg</Button><Button size="sm" disabled={editing || busy || saving || !selected.size || selected.size > 100} onClick={() => setRegenerationOpen(true)}>Generer {selected.size || "valgte"} svar på nytt</Button></div> : null}
    {regenerationOpen ? <div role="region" aria-label="Bekreft regenerering av utvalgte svar" className="space-y-2 rounded-md border p-3 text-sm"><p>{selected.size} valgte svar erstattes i en ny versjon. Egen tekst i disse svarene erstattes også. De øvrige svarene beholdes.</p><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={saving} onClick={() => setRegenerationOpen(false)}>Avbryt</Button><Button size="sm" disabled={saving || busy} onClick={() => void regenerate()}>{saving ? "Genererer …" : "Erstatt valgte svar"}</Button></div></div> : null}
    <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(12rem,0.8fr)_minmax(0,2fr)]">
      <div aria-label="Kravliste" className="max-h-48 overflow-y-auto rounded-md border md:max-h-[42rem]">
        {filtered.map(row => <div key={row.key} className="flex items-start border-b last:border-0">{canEdit ? <input type="checkbox" aria-label={`Velg ${row.ref}, rad ${row.index + 1}`} className="ml-2 mt-3 shrink-0" checked={selected.has(row.key)} disabled={editing || busy || saving || !row.rowHash} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(row.key); else next.delete(row.key); return next; })} /> : null}<button type="button" disabled={editing || saving} aria-pressed={active?.key === row.key} onClick={() => setActiveKey(row.key)} className={cn("block min-h-12 w-full border-b px-3 py-2 text-left last:border-0 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60", active?.key === row.key && "bg-primary/5 ring-1 ring-inset ring-primary/40")}>
          <span className="flex flex-wrap items-center justify-between gap-1 text-xs"><strong>{row.ref || `Krav ${row.index + 1}`}</strong><span className={row.needsReview ? "text-amber-800" : "text-muted-foreground"}>{row.unanswered ? "Ubesvart" : row.missingSource ? "Mangler kilde" : row.needsReview ? "Må gjennomgås" : "Besvart"}</span></span>
          <span className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{row.requirement}</span>
        </button></div>)}
        {!filtered.length ? <p role="status" className="p-4 text-sm text-muted-foreground">Ingen krav samsvarer med søket og filteret.</p> : null}
      </div>
      {active ? <article className="min-w-0 space-y-4 rounded-md border p-3 sm:p-4 [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-semibold">{active.ref || `Krav ${active.index + 1}`}</h5><span className="text-xs text-muted-foreground">{activeIndex + 1} av {filtered.length}</span></div>
        <div><h6 className="mb-1 text-xs font-semibold text-muted-foreground">Kundens krav · {active.group}</h6><p className="whitespace-pre-wrap text-sm leading-6">{active.requirement}</p></div>
        {editing ? <div className="space-y-3">
          <label className="block text-sm font-medium">Svar<Textarea ref={editor} className="mt-1 min-h-40" value={answer} disabled={saving} onChange={event => setAnswer(event.target.value)} /></label>
          <label className="block text-sm font-medium">Svargrunnlag<Textarea className="mt-1 min-h-24" value={evidence} disabled={saving || active.columns.evidenceIndex < 0} onChange={event => setEvidence(event.target.value)} /></label>
          {active.needsReview && (metadata.templateRepairCount > 0 || metadata.controlRepairCount > 0) ? <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={acknowledge} disabled={saving} onChange={event => setAcknowledge(event.target.checked)} />Jeg har kontrollert den endrede raden mot kildene. Fjern kontrollmarkeringen fra denne raden ved lagring.</label> : null}
          <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" size="sm" disabled={saving} onClick={() => setDraftRow(null)}><X />Avbryt</Button><Button size="sm" disabled={saving || !answer.trim()} onClick={() => void save()}><Save />{saving ? "Lagrer …" : "Lagre svar"}</Button></div>
        </div> : <>
          <div><h6 className="mb-1 text-xs font-semibold text-muted-foreground">Svar</h6><p className="whitespace-pre-wrap text-sm leading-6">{active.answer || "Ikke besvart"}</p></div>
          <div><h6 className="mb-1 text-xs font-semibold text-muted-foreground">Svargrunnlag</h6><p className="whitespace-pre-wrap text-sm leading-6">{active.evidence || "Ingen dokumentasjon oppgitt. Kontroller svaret før innlevering."}</p></div>
          <SourceEvidenceButton projectId={projectId} canDownloadDocuments={canDownloadDocuments} source={{ source_type: "project_document", source_id: active.sourceDocumentId ?? "", document_title: documents.find(document => document.id === active.sourceDocumentId)?.title ?? "Kravgrunnlag", reference: active.sourceLocator || active.source || "Ingen presis henvisning", heading_path: [active.group], page_start: null, page_end: null, original_quote: active.requirement, classification: "needs_clarification" }}>Kilde: {active.source || "Mangler kildehenvisning"}</SourceEvidenceButton>
          <OutputSourceEvidence value={isRecord(artifact.input_snapshot) ? artifact.input_snapshot.source_evidence : undefined} path={`rows.${active.index}`} projectId={projectId} canDownloadDocuments={canDownloadDocuments} />
          {canEdit ? <Button variant="outline" size="sm" disabled={busy} onClick={() => edit(active)}><Pencil />Rediger dette svaret</Button> : null}
        </>}
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        <div className="flex flex-wrap gap-2 border-t pt-3"><Button variant="outline" size="sm" disabled={editing || saving || filtered.length < 2} onClick={() => navigate(-1)}><ArrowUp />Forrige</Button><Button variant="outline" size="sm" disabled={editing || saving || filtered.length < 2} onClick={() => navigate(1)}><ArrowDown />Neste</Button><Button variant="outline" size="sm" disabled={editing || saving || !unresolved} onClick={() => { setFilter("review"); setSourceFilter("all"); setQuery(""); const next = rows.find(row => row.index > active.index && row.needsReview) ?? rows.find(row => row.needsReview); if (next) setActiveKey(next.key); }}><CheckSquare />Neste uavklarte</Button></div>
      </article> : null}
    </div>
    <p className="text-xs leading-5 text-muted-foreground">Kildekontroll viser lagrede originalutdrag, ikke en vurdering av hele svarets kvalitet. Åpne kilden for kontroll mot gjeldende dokument. Tastatur: j/k neste/forrige · e rediger · a neste uavklarte og fjern søkefiltre. Endringer lagres som en ny versjon.</p>
  </section>;
}
