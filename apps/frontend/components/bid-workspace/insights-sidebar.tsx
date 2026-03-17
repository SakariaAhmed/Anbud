"use client";

import { ShieldCheck, ShieldQuestion, TriangleAlert } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BidComplianceRow, BidCustomerAnalysis } from "@/lib/types";

import { requirementSourceLabel, statusTone } from "./helpers";

interface InsightsSidebarProps {
  selectedRow: BidComplianceRow | null;
  customerAnalysis: BidCustomerAnalysis | null;
}

export function InsightsSidebar({ selectedRow, customerAnalysis }: InsightsSidebarProps) {
  return (
    <aside className="grid gap-4 self-start print:grid-cols-2 2xl:sticky 2xl:top-6">
      <Card className="border border-foreground/10 bg-white/88 print:break-inside-avoid print:border-slate-300 print:bg-white">
        <CardHeader>
          <CardTitle>Detaljvisning</CardTitle>
          <CardDescription>Sammenlign krav, kilde og svar uten å forlate arbeidsflaten.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {selectedRow ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{selectedRow.requirement_code}</p>
                  <h3 className="mt-1 text-lg font-semibold text-slate-950">{selectedRow.requirement_summary}</h3>
                </div>
                <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(selectedRow.status)}`}>
                  {selectedRow.status}
                </span>
              </div>

              <div className="grid gap-3 rounded-2xl bg-slate-50 p-4 text-sm">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-medium text-slate-900">Kilde for kravet</div>
                    <span className="rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-sky-950">
                      {requirementSourceLabel()}
                    </span>
                  </div>
                  <div className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Referanse</div>
                    <div className="mt-1 text-slate-700">{selectedRow.source_reference || "Ingen presis referanse"}</div>
                  </div>
                  <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Kildeutdrag</div>
                    <div className="mt-1 leading-6 text-slate-700">{selectedRow.source_excerpt || "Ingen utdrag tilgjengelig."}</div>
                  </div>
                </div>
                <div className="border-t border-slate-200 pt-3">
                  <div className="font-medium text-slate-900">Funnet i Bilag 2</div>
                  <div className="mt-1 text-slate-600">{selectedRow.found_in || "Ikke funnet"}</div>
                  <div className="mt-2 text-slate-700">{selectedRow.answer_excerpt || "Ingen tydelig svartekst registrert."}</div>
                </div>
                {selectedRow.notes ? (
                  <div className="border-t border-slate-200 pt-3">
                    <div className="font-medium text-slate-900">Notat</div>
                    <div className="mt-1 text-slate-700">{selectedRow.notes}</div>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500">Velg et krav for å se detaljvisning.</p>
          )}
        </CardContent>
      </Card>

      <Card className="border border-foreground/10 bg-white/88 print:break-inside-avoid print:border-slate-300 print:bg-white">
        <CardHeader>
          <CardTitle>Kundeanalyse</CardTitle>
          <CardDescription>Bilag 1 tolket for en skyarkitekt som trenger raske beslutningspunkter.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="rounded-2xl bg-slate-50 p-4">
            <div className="mb-2 flex items-center gap-2 font-medium text-slate-900">
              <ShieldCheck className="size-4 text-emerald-600" />
              Hva er viktig for kunden
            </div>
            <ul className="grid gap-2 text-sm text-slate-700">
              {(customerAnalysis?.customer_priorities ?? []).length ? (
                customerAnalysis?.customer_priorities.map((item) => <li key={item}>• {item}</li>)
              ) : (
                <li>• Ingen analyse generert ennå.</li>
              )}
            </ul>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <div className="mb-2 flex items-center gap-2 font-medium text-slate-900">
              <ShieldQuestion className="size-4 text-amber-600" />
              Hvilke avklaringer og spørsmål må vi ta
            </div>
            <ul className="grid gap-2 text-sm text-slate-700">
              {(customerAnalysis?.clarifications ?? []).length ? (
                customerAnalysis?.clarifications.map((item) => <li key={item}>• {item}</li>)
              ) : (
                <li>• Ingen analyse generert ennå.</li>
              )}
            </ul>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <div className="mb-2 flex items-center gap-2 font-medium text-slate-900">
              <TriangleAlert className="size-4 text-sky-700" />
              Hvordan kan vi gi verdi
            </div>
            <ul className="grid gap-2 text-sm text-slate-700">
              {(customerAnalysis?.value_angles ?? []).length ? (
                customerAnalysis?.value_angles.map((item) => <li key={item}>• {item}</li>)
              ) : (
                <li>• Ingen analyse generert ennå.</li>
              )}
            </ul>
          </div>
        </CardContent>
      </Card>
    </aside>
  );
}
