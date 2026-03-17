import Link from "next/link";
import { ArrowRight, FileCheck2, FileText, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BidSummary } from "@/lib/types";

function statusLabel(value: boolean, yes: string, no: string) {
  return value ? yes : no;
}

export function BidList({ bids }: { bids: BidSummary[] }) {
  if (!bids.length) {
    return (
      <Card className="border-dashed border-foreground/15 bg-white/70">
        <CardHeader>
          <CardTitle>Ingen saker ennå</CardTitle>
          <CardDescription>
            Opprett en analyse over og last opp Bilag 1 og Bilag 2 for å starte compliance-kontrollen.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      {bids.map((bid) => (
        <Link key={bid.id} href={`/bids/${bid.id}`} className="block">
          <Card className="border border-foreground/10 bg-white/85 transition hover:-translate-y-0.5 hover:shadow-[0_22px_64px_rgba(15,23,42,0.12)]">
            <CardContent className="grid gap-4 py-5 md:grid-cols-[1.5fr_1.2fr_auto] md:items-center">
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-500">Sak</p>
                <h3 className="text-xl font-semibold text-slate-950">{bid.customer_name}</h3>
                <p className="text-sm text-slate-600">{bid.title}</p>
              </div>

              <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
                <div className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-2">
                  <FileText className="size-4 text-slate-500" />
                  {statusLabel(bid.bilag1_uploaded, "Bilag 1 lastet opp", "Bilag 1 mangler")}
                </div>
                <div className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-2">
                  <FileText className="size-4 text-slate-500" />
                  {statusLabel(bid.bilag2_uploaded, "Bilag 2 lastet opp", "Bilag 2 mangler")}
                </div>
                <div className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-2">
                  <FileCheck2 className="size-4 text-emerald-600" />
                  {statusLabel(bid.analysis_generated, "Analyse generert", "Analyse ikke kjørt")}
                </div>
                <div className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-2">
                  <ShieldAlert className="size-4 text-amber-600" />
                  {bid.missing_requirements} mangler
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 md:block">
                <div className="text-right text-sm text-slate-500">
                  <div>{bid.total_requirements} krav</div>
                  <div>Oppdatert {bid.updated_at.slice(0, 10)}</div>
                </div>
                <div className="mt-3 flex justify-end text-sm font-medium text-slate-950">
                  Åpne arbeidsflate <ArrowRight className="ml-2 size-4" />
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
