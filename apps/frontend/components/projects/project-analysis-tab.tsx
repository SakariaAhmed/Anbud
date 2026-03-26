"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/projects/primitives";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import {
  AnalysisTabEmptyState,
  SectionList,
  VALUE_LABELS,
  ValueBadges,
} from "@/components/projects/project-workspace-shared";
import type { CustomerAnalysisResult } from "@/lib/types";

export function ProjectAnalysisTab({
  customerAnalysis,
  busy,
  onGenerate,
}: {
  customerAnalysis: CustomerAnalysisResult | null;
  busy: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="grid gap-5">
      <Card className="border border-slate-200/80 bg-white shadow-none">
        <CardHeader className="border-b border-slate-200/80 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <CardTitle className="text-2xl font-semibold text-slate-950">Kundeanalyse</CardTitle>
              <CardDescription className="text-base leading-7 text-slate-600">
                Analyse av hvem kunden er, hva kunden prøver å oppnå, hvilke krav som er eksplisitte eller implisitte,
                og hvordan dere bør posisjonere dere.
              </CardDescription>
            </div>
            <Button size="lg" onClick={onGenerate} disabled={busy}>
              {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              Generer kundeanalyse
            </Button>
          </div>
        </CardHeader>
      </Card>

      {customerAnalysis ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <SectionList title="Kundeprofil" items={customerAnalysis.customer_profile} />
          <SectionList title="Kundens mål" items={customerAnalysis.customer_goals} />
          <SectionList title="Risiko og usikkerhet" items={customerAnalysis.risks} />
          <SectionList title="Mulige evalueringskriterier" items={customerAnalysis.likely_evaluation_criteria} />
          <SectionList title="Signalord og preferanser" items={customerAnalysis.signal_words} />
          <SectionList title="Anbefalt posisjonering" items={customerAnalysis.positioning_recommendations} />

          <Card className="border border-slate-200/80 bg-white shadow-none xl:col-span-2">
            <CardHeader className="border-b border-slate-200/80 pb-4">
              <CardTitle className="text-xl font-semibold text-slate-950">Eksplisitte krav</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-5">
              {customerAnalysis.explicit_requirements.map((requirement, index) => (
                <div key={`${requirement.title}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{requirement.category}</Badge>
                    <Badge variant="outline">{requirement.importance}</Badge>
                    <Badge variant="outline">{requirement.kind}</Badge>
                  </div>
                  <h3 className="mt-3 text-lg font-semibold text-slate-950">{requirement.title}</h3>
                  <div className="mt-2">
                    <MarkdownViewer content={requirement.description} className="text-base text-slate-700" />
                  </div>
                  <p className="mt-3 text-sm text-slate-500">
                    {requirement.source_reference || "Ingen presis referanse"} ·{" "}
                    {requirement.source_excerpt || "Ingen kildeutdrag tilgjengelig"}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border border-slate-200/80 bg-white shadow-none xl:col-span-2">
            <CardHeader className="border-b border-slate-200/80 pb-4">
              <CardTitle className="text-xl font-semibold text-slate-950">Implisitte krav</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-5">
              {customerAnalysis.implicit_requirements.map((requirement, index) => (
                <div key={`${requirement.title}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{requirement.category}</Badge>
                    <Badge variant="outline">{requirement.importance}</Badge>
                    <Badge variant="outline">{requirement.kind}</Badge>
                  </div>
                  <h3 className="mt-3 text-lg font-semibold text-slate-950">{requirement.title}</h3>
                  <div className="mt-2">
                    <MarkdownViewer content={requirement.description} className="text-base text-slate-700" />
                  </div>
                  <p className="mt-3 text-sm text-slate-500">
                    {requirement.source_reference || "Ingen presis referanse"} ·{" "}
                    {requirement.source_excerpt || "Ingen kildeutdrag tilgjengelig"}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border border-slate-200/80 bg-white shadow-none xl:col-span-2">
            <CardHeader className="border-b border-slate-200/80 pb-4">
              <CardTitle className="text-xl font-semibold text-slate-950">Verdimuligheter</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              {customerAnalysis.value_opportunities.map((item, index) => (
                <div key={`${item.title}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <h3 className="text-lg font-semibold text-slate-950">{item.title}</h3>
                  <div className="mt-2">
                    <MarkdownViewer content={item.description} className="text-base text-slate-700" />
                  </div>
                  <div className="mt-3">
                    <ValueBadges values={item.value_categories.filter((value) => VALUE_LABELS.includes(value))} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border border-slate-200/80 bg-white shadow-none xl:col-span-2">
            <CardHeader className="border-b border-slate-200/80 pb-4">
              <CardTitle className="text-xl font-semibold text-slate-950">Oppsummering for tilbudsteamet</CardTitle>
            </CardHeader>
            <CardContent className="pt-5">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
                <MarkdownViewer content={customerAnalysis.executive_summary} className="text-base text-slate-700" />
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <AnalysisTabEmptyState>Ingen analyse ennå. Last opp et primært kundedokument og generer analysen.</AnalysisTabEmptyState>
      )}
    </div>
  );
}
