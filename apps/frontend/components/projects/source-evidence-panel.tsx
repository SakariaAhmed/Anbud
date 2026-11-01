"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { parseChatSourceReferences } from "@/lib/chat-source-references";
import { FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { ChatSourceReference } from "@/lib/types";

const roles = { primary_customer_document: "Kundens kravgrunnlag", primary_solution_document: "Leverandørens løsningsgrunnlag", supporting_document: "Støttedokument" };
export function SourceEvidenceButton({ source, projectId, canDownloadDocuments = false, children }: {
  source: ChatSourceReference;
  projectId?: string;
  canDownloadDocuments?: boolean;
  children?: ReactNode;
}) {
  const requestKey = `${projectId}:${source.source_id}:${source.source_revision}:${source.original_quote}`;
  const [resolution, setResolution] = useState<{ key: string; source: ChatSourceReference } | null>(null);
  const resolved = resolution?.key === requestKey ? resolution.source : null;
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const verificationError = failure?.key === requestKey ? failure.message : "";
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const checking = checkingKey === requestKey;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [requestKey]);
  const displayed = resolved ?? source;
  async function verify(open: boolean) {
    if (!open) { controller.current?.abort(); setCheckingKey(null); return; }
    if (!projectId || !source.source_id || source.source_type !== "project_document" || !source.original_quote || source.evidence_id || resolved) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setCheckingKey(requestKey); setFailure(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/source-evidence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: source.source_id, quote: source.original_quote, sourceRevision: source.source_revision }), signal: abort.signal });
      const payload: unknown = await response.json();
      const value = payload && typeof payload === "object" && "source" in payload ? parseChatSourceReferences([payload.source])[0] : undefined;
      if (!response.ok || !value?.evidence_id) throw new Error(response.status === 409 ? "Kilden er endret. Kontroller den gjeldende originalen." : "Utdraget kunne ikke bekreftes ordrett i kilden. Kontroller originaldokumentet.");
      if (!abort.signal.aborted) setResolution({ key: requestKey, source: { ...value, classification: source.classification === "interpretation" ? "interpretation" : value.classification } });
    } catch (failure) { if (!abort.signal.aborted) setFailure({ key: requestKey, message: failure instanceof Error ? failure.message : "Kunne ikke kontrollere kilden." }); }
    finally { if (!abort.signal.aborted) setCheckingKey(null); }
  }
  const classification = displayed.classification === "documented" && displayed.evidence_id && displayed.original_quote
    ? "Dokumentert" : displayed.classification === "interpretation" ? "Tolkning" : "Må avklares";
  const href = canDownloadDocuments && projectId && displayed.source_type === "project_document" && displayed.source_id
    ? `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(displayed.source_id)}?disposition=inline${displayed.page_start ? `#page=${displayed.page_start}` : ""}` : null;
  return <Sheet onOpenChange={open => void verify(open)}>
    <SheetTrigger className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-sm text-left text-xs font-medium text-primary underline underline-offset-4 outline-offset-4 hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-ring">
      <FileText className="size-3.5 shrink-0" /><span className="min-w-0 break-words">{children ?? `Kilde: ${displayed.document_title} · ${displayed.reference}`}</span>
    </SheetTrigger>
    <SheetContent showCloseButton={false} className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
      <SheetHeader className="border-b pr-14">
        <SheetTitle className="break-words">{displayed.document_title}</SheetTitle>
        <SheetDescription>{classification}{displayed.document_role ? ` · ${roles[displayed.document_role]}` : ""}</SheetDescription>
      </SheetHeader>
      <SheetClose render={<Button variant="ghost" size="icon-sm" className="absolute right-3 top-3" aria-label="Lukk kilde" />}><X /></SheetClose>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6 [overflow-wrap:anywhere]">
        {checking ? <p role="status" className="text-xs text-muted-foreground">Kontrollerer originalutdrag …</p> : null}
        {verificationError ? <p role="alert" className="text-sm text-amber-800">{verificationError}</p> : null}
        <dl className="space-y-2 text-sm">
          <div><dt className="font-semibold">Sted i dokumentet</dt><dd className="mt-1 text-muted-foreground">{[...displayed.heading_path, displayed.reference].filter(Boolean).join(" › ") || "Ingen presis henvisning er lagret."}{displayed.page_start ? ` · Side ${displayed.page_start}${displayed.page_end && displayed.page_end !== displayed.page_start ? `–${displayed.page_end}` : ""}` : ""}</dd></div>
        </dl>
        {displayed.original_quote ? <div><h3 className="mb-2 text-sm font-semibold">{classification === "Dokumentert" ? "Originalt kildeutdrag" : "Lagret utdrag"}</h3>{(displayed.quotation_excerpts?.length ? displayed.quotation_excerpts : [displayed.original_quote]).map((quote, index) => <blockquote key={index} className="mb-4 whitespace-pre-wrap text-sm leading-7">{quote}</blockquote>)}</div>
          : <p className="text-sm leading-6 text-muted-foreground">Denne eldre henvisningen har ikke et lagret originalutdrag. Åpne dokumentet og kontroller påstanden før den brukes.</p>}
        {classification === "Må avklares" && displayed.original_quote ? <p className="text-sm text-muted-foreground">Utdraget er ikke kontrollert mot originalkilden. Bekreft ordlyden i dokumentet.</p> : null}
        {href ? <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-md border px-3 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{displayed.page_start ? `Åpne på side ${displayed.page_start}` : "Åpne originaldokument"}</a>
          : <p className="text-xs leading-5 text-muted-foreground">{displayed.source_type === "generated_artifact" ? "Utdraget kommer fra et generert utkast og er en tolkning av kildegrunnlaget." : displayed.source_type === "service_document" ? "Originalen ligger i tjenestebiblioteket." : displayed.source_type === "chat_attachment" ? "Vedlegget ble brukt i denne meldingen. Det er ikke lagret som et prosjektdokument." : "Du har ikke tilgang til å åpne originaldokumentet."}</p>}
      </div>
    </SheetContent>
  </Sheet>;
}
