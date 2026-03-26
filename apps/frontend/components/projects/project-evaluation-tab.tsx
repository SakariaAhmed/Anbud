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
import type { SolutionEvaluationResult } from "@/lib/types";

export function ProjectEvaluationTab({
  solutionEvaluation,
  hasSolutionDocument,
  busy,
  busyMessage,
  onGenerate,
}: {
  solutionEvaluation: SolutionEvaluationResult | null;
  hasSolutionDocument: boolean;
  busy: boolean;
  busyMessage: string;
  onGenerate: () => void;
}) {
  return (
    <div className="grid gap-5">
      <Card className="border border-slate-200/80 bg-white shadow-none">
        <CardHeader className="border-b border-slate-200/80 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <CardTitle className="text-2xl font-semibold text-slate-950">Løsningsvurdering</CardTitle>
              <CardDescription className="text-base leading-7 text-slate-600">
                Vurder hvordan løsningsdokumentet faktisk svarer på kundens behov, hvor det er sterkt, og hva som må
                forbedres for å bli konkurransedyktig. Hvis primært løsningsdokument mangler, kan systemet generere et
                internt utkast etter at brukeren bekrefter det.
              </CardDescription>
            </div>
            <Button size="lg" onClick={onGenerate} disabled={busy}>
              {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              Generer løsningsvurdering
            </Button>
          </div>
        </CardHeader>
      </Card>

      {busy && busyMessage ? (
        <Card className="border border-sky-200 bg-sky-50 shadow-none">
          <CardContent className="flex items-center gap-3 p-5 text-base text-sky-900">
            <LoaderCircle className="size-5 animate-spin text-sky-700" />
            <span>{busyMessage}</span>
          </CardContent>
        </Card>
      ) : null}

      {solutionEvaluation ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card className="border border-slate-200/80 bg-white shadow-none xl:col-span-2">
            <CardHeader className="border-b border-slate-200/80 pb-4">
              <CardTitle className="text-xl font-semibold text-slate-950">Fit mot kundebehov</CardTitle>
            </CardHeader>
            <CardContent className="pt-5">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
                <MarkdownViewer content={solutionEvaluation.fit_to_customer_needs} className="text-base text-slate-700" />
              </div>
            </CardContent>
          </Card>

          <SectionList title="Styrker" items={solutionEvaluation.strengths} />
          <SectionList title="Svakheter" items={solutionEvaluation.weaknesses} />
          <SectionList title="Generiske partier" items={solutionEvaluation.generic_sections} />
          <SectionList title="Manglende elementer" items={solutionEvaluation.missing_elements} />
          <SectionList title="Risiko for kunden" items={solutionEvaluation.risks_to_customer} />
          <SectionList title="Tillitssignaler" items={solutionEvaluation.trust_signals} />
          <SectionList title="Forbedringsforslag" items={solutionEvaluation.improvement_recommendations} />

          <Card className="border border-slate-200/80 bg-white shadow-none xl:col-span-2">
            <CardHeader className="border-b border-slate-200/80 pb-4">
              <CardTitle className="text-xl font-semibold text-slate-950">Sannsynlig scorevurdering</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 pt-5 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Kvalitet</p>
                <div className="mt-3">
                  <MarkdownViewer content={solutionEvaluation.likely_score_assessment.quality} className="text-base text-slate-800" />
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Gjennomføringsevne</p>
                <div className="mt-3">
                  <MarkdownViewer content={solutionEvaluation.likely_score_assessment.delivery_confidence} className="text-base text-slate-800" />
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Risiko</p>
                <div className="mt-3">
                  <MarkdownViewer content={solutionEvaluation.likely_score_assessment.risk} className="text-base text-slate-800" />
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Konkurransekraft</p>
                <div className="mt-3">
                  <MarkdownViewer content={solutionEvaluation.likely_score_assessment.competitiveness} className="text-base text-slate-800" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200/80 bg-white shadow-none xl:col-span-2">
            <CardHeader className="border-b border-slate-200/80 pb-4">
              <CardTitle className="text-xl font-semibold text-slate-950">Verdivurdering</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              {solutionEvaluation.value_assessment.map((item, index) => (
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
              <CardTitle className="text-xl font-semibold text-slate-950">Omskrivingsforslag</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-5">
              {solutionEvaluation.rewrite_suggestions.map((suggestion, index) => (
                <div key={`${suggestion.target}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{suggestion.target}</Badge>
                  </div>
                  <div className="mt-3">
                    <MarkdownViewer content={suggestion.suggestion} className="text-base text-slate-700" />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border border-slate-200/80 bg-white shadow-none xl:col-span-2">
            <CardHeader className="border-b border-slate-200/80 pb-4">
              <CardTitle className="text-xl font-semibold text-slate-950">Ledelsesoppsummering</CardTitle>
            </CardHeader>
            <CardContent className="pt-5">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
                <MarkdownViewer content={solutionEvaluation.executive_summary} className="text-base text-slate-700" />
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <AnalysisTabEmptyState>
          {hasSolutionDocument
            ? "Ingen løsningsvurdering ennå. Last opp primært kundedokument, generer kundeanalyse og kjør vurderingen."
            : "Ingen løsningsvurdering ennå. Last opp primært kundedokument og generer kundeanalyse. Hvis løsningsdokument mangler, kan systemet lage et internt utkast etter bekreftelse."}
        </AnalysisTabEmptyState>
      )}
    </div>
  );
}
