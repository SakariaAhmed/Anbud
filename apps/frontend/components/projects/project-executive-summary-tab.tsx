"use client";

import { ArrowUpRight, ClipboardCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WorkflowBlockedHint } from "@/components/projects/workflow-blocked-hint";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import {
  AnalysisTabEmptyState,
  GenerationProgress,
} from "@/components/projects/project-workspace-shared";
import { Spinner } from "@/components/ui/spinner";
import type { ExecutiveSummaryResult } from "@/lib/types";

function ExecutiveList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;

  return (
    <section className="min-w-0 border-t border-slate-200 pt-4">
      <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
      <ol className="mt-3 list-decimal space-y-3 pl-5 marker:text-slate-500">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className="pl-1">
            <MarkdownViewer content={item} className="analysis-prose text-sm leading-6 text-slate-700" />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ProjectExecutiveSummaryTab({
  executiveSummary: summary,
  hasSolutionEvaluation,
  busy,
  busyMessage,
  busyProgress,
  workflowBlockedReason,
  onGenerate,
}: {
  executiveSummary: ExecutiveSummaryResult | null;
  hasSolutionEvaluation: boolean;
  busy: boolean;
  busyMessage: string;
  busyProgress: number;
  workflowBlockedReason?: string | null;
  onGenerate: () => void;
}) {
  const score = summary?.likely_score_assessment;
  const metrics = score ? [
    { label: "Kvalitet", value: score.quality },
    { label: "Gjennomføring", value: score.delivery_confidence },
    { label: "Risiko", value: score.risk },
    { label: "Konkurransekraft", value: score.competitiveness },
  ] : [];

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-col items-end gap-2 text-right">
        <Button
          variant={summary ? "outline" : "default"}
          onClick={onGenerate}
          aria-describedby={workflowBlockedReason && !busy ? "summary-workflow-blocked" : undefined}
          disabled={busy || !hasSolutionEvaluation || Boolean(workflowBlockedReason)}
        >
          {busy ? <Spinner className="size-4" /> : summary ? <ArrowUpRight data-icon="inline-start" /> : <ClipboardCheck data-icon="inline-start" />}
          {summary ? "Regenerer" : "Generer lederoppsummering"}
        </Button>
        {!busy ? <WorkflowBlockedHint id="summary-workflow-blocked" reason={workflowBlockedReason} /> : null}
      </div>
      {busy && busyMessage ? <GenerationProgress message={busyMessage} progress={busyProgress} /> : null}
      {summary ? (
        <>
          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            <section className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-950">Hovedkonklusjon</h3>
              <MarkdownViewer content={summary.executive_summary} className="analysis-prose mt-3 text-sm leading-7 text-slate-700" />
            </section>
            <section className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-950">Samsvar med kundebehov</h3>
              <MarkdownViewer content={summary.fit_to_customer_needs} className="analysis-prose mt-3 text-sm leading-7 text-slate-700" />
            </section>
          </div>
          <div className="grid min-w-0 gap-5 border-t border-slate-200 pt-4 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map((metric) => (
              <section key={metric.label} className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-950">{metric.label}</h3>
                <MarkdownViewer content={metric.value} className="analysis-prose mt-2 text-sm leading-6 text-slate-700" />
              </section>
            ))}
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <ExecutiveList title="Hva taler for" items={summary.strengths} />
            <ExecutiveList title="Hva må håndteres" items={summary.weaknesses} />
          </div>
        </>
      ) : (
        <AnalysisTabEmptyState>
          {hasSolutionEvaluation ? "Ingen lederoppsummering ennå. Generer den separat fra vurderingen." : "Generer vurdering før lederoppsummeringen kan lages."}
        </AnalysisTabEmptyState>
      )}
    </div>
  );
}
