"use client";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BidSummaryCounts } from "@/lib/types";

export function SummaryCards({ summary }: { summary: BidSummaryCounts }) {
  return (
    <section className="grid gap-4 md:grid-cols-4">
      <Card className="bg-slate-950 text-white">
        <CardHeader>
          <CardDescription className="text-slate-300">Totalt krav</CardDescription>
          <CardTitle className="text-4xl">{summary.total_requirements}</CardTitle>
        </CardHeader>
      </Card>
      <Card className="bg-emerald-50">
        <CardHeader>
          <CardDescription>Besvart</CardDescription>
          <CardTitle className="text-4xl text-emerald-900">{summary.besvart}</CardTitle>
        </CardHeader>
      </Card>
      <Card className="bg-amber-50">
        <CardHeader>
          <CardDescription>Delvis besvart</CardDescription>
          <CardTitle className="text-4xl text-amber-900">{summary.delvis_besvart}</CardTitle>
        </CardHeader>
      </Card>
      <Card className="bg-rose-50">
        <CardHeader>
          <CardDescription>Ikke besvart</CardDescription>
          <CardTitle className="text-4xl text-rose-900">{summary.ikke_besvart}</CardTitle>
        </CardHeader>
      </Card>
    </section>
  );
}
