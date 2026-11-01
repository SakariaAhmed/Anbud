"use client";
import type { ReactNode } from "react";
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
  const classification = source.classification === "documented" && source.evidence_id && source.original_quote
    ? "Dokumentert" : source.classification === "interpretation" ? "Tolkning" : "Må avklares";
  const href = canDownloadDocuments && projectId && source.source_type === "project_document"
    ? `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(source.source_id)}?disposition=inline${source.page_start ? `#page=${source.page_start}` : ""}` : null;
  return <Sheet>
    <SheetTrigger className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-sm text-left text-xs font-medium text-primary underline underline-offset-4 outline-offset-4 hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-ring">
      <FileText className="size-3.5 shrink-0" /><span className="min-w-0 break-words">{children ?? `Kilde: ${source.document_title} · ${source.reference}`}</span>
    </SheetTrigger>
    <SheetContent showCloseButton={false} className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
      <SheetHeader className="border-b pr-14">
        <SheetTitle className="break-words">{source.document_title}</SheetTitle>
        <SheetDescription>{classification}{source.document_role ? ` · ${roles[source.document_role]}` : ""}</SheetDescription>
      </SheetHeader>
      <SheetClose render={<Button variant="ghost" size="icon-sm" className="absolute right-3 top-3" aria-label="Lukk kilde" />}><X /></SheetClose>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6 [overflow-wrap:anywhere]">
        <dl className="space-y-2 text-sm">
          <div><dt className="font-semibold">Sted i dokumentet</dt><dd className="mt-1 text-muted-foreground">{[...source.heading_path, source.reference].filter(Boolean).join(" › ") || "Ingen presis henvisning er lagret."}{source.page_start ? ` · Side ${source.page_start}${source.page_end && source.page_end !== source.page_start ? `–${source.page_end}` : ""}` : ""}</dd></div>
        </dl>
        {source.original_quote ? <div><h3 className="mb-2 text-sm font-semibold">{classification === "Dokumentert" ? "Originalt kildeutdrag" : "Lagret utdrag"}</h3><blockquote className="whitespace-pre-wrap text-sm leading-7">{source.original_quote}</blockquote></div>
          : <p className="text-sm leading-6 text-muted-foreground">Denne eldre henvisningen har ikke et lagret originalutdrag. Åpne dokumentet og kontroller påstanden før den brukes.</p>}
        {classification === "Må avklares" && source.original_quote ? <p className="text-sm text-muted-foreground">Utdraget er ikke kontrollert mot originalkilden. Bekreft ordlyden i dokumentet.</p> : null}
        {href ? <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-md border px-3 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{source.page_start ? `Åpne på side ${source.page_start}` : "Åpne originaldokument"}</a>
          : <p className="text-xs leading-5 text-muted-foreground">{source.source_type === "service_document" ? "Originalen ligger i tjenestebiblioteket." : "Du har ikke tilgang til å åpne originaldokumentet."}</p>}
      </div>
    </SheetContent>
  </Sheet>;
}
