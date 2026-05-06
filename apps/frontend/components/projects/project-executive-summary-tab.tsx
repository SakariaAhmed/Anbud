"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ClipboardCheck,
  FileWarning,
  Target,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { AnalysisTabEmptyState } from "@/components/projects/project-workspace-shared";
import { Spinner } from "@/components/ui/spinner";
import type { ExecutiveSummaryResult } from "@/lib/types";

function splitExecutiveLead(content: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    return { lead: "", rest: "" };
  }

  const match = trimmed.match(/^(.+?[.!?])(?:\s+|$)([\s\S]*)$/);
  if (!match) {
    return { lead: trimmed, rest: "" };
  }

  return {
    lead: match[1].trim(),
    rest: match[2].trim(),
  };
}

function ExecutiveMetric({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: "quality" | "delivery" | "risk" | "competition";
}) {
  const toneClassName = {
    quality: "border-sky-200 bg-sky-50 text-sky-950",
    delivery: "border-emerald-200 bg-emerald-50 text-emerald-950",
    risk: "border-rose-200 bg-rose-50 text-rose-950",
    competition: "border-amber-200 bg-amber-50 text-amber-950",
  }[tone];

  return (
    <div className={`min-w-0 rounded-xl border px-4 py-4 ${toneClassName}`}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/85 text-slate-950 shadow-sm">
          <Icon className="size-4" />
        </span>
        <p className="min-w-0 break-words text-[0.68rem] font-black uppercase tracking-[0.16em] opacity-70">
          {label}
        </p>
      </div>
      <MarkdownViewer
        content={value}
        className="analysis-prose text-sm leading-6 text-current"
      />
    </div>
  );
}

function ExecutiveList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "trust" | "risk";
}) {
  const markerClassName = tone === "trust" ? "bg-emerald-600" : "bg-rose-600";

  if (!items.length) {
    return null;
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
      <div className="flex items-center gap-2.5">
        {tone === "trust" ? (
          <CheckCircle2 className="size-4 text-emerald-600" />
        ) : (
          <AlertTriangle className="size-4 text-rose-600" />
        )}
        <p className="text-[0.72rem] font-black uppercase tracking-[0.18em] text-slate-500">
          {title}
        </p>
      </div>
      <div className="mt-4 space-y-3">
        {items.slice(0, 4).map((item, index) => (
          <div
            key={`${title}-${index}`}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 rounded-lg bg-slate-50 px-3 py-3"
          >
            <span
              className={`mt-1 flex size-5 items-center justify-center rounded-full text-[0.68rem] font-black text-white ${markerClassName}`}
            >
              {index + 1}
            </span>
            <MarkdownViewer
              content={item}
              className="analysis-prose text-sm leading-6 text-slate-700"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProjectExecutiveSummaryTab({
  executiveSummary: summary,
  hasSolutionEvaluation,
  busy,
  busyMessage,
  onGenerate,
}: {
  executiveSummary: ExecutiveSummaryResult | null;
  hasSolutionEvaluation: boolean;
  busy: boolean;
  busyMessage: string;
  onGenerate: () => void;
}) {
  if (!summary) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <Button
            onClick={onGenerate}
            disabled={busy || !hasSolutionEvaluation}
            size="lg"
          >
            {busy ? (
              <Spinner className="size-4" />
            ) : (
              <ClipboardCheck data-icon="inline-start" />
            )}
            Generer lederoppsummering
          </Button>
        </div>
        {busy && busyMessage ? (
          <div className="flex items-center gap-2 text-sm text-primary">
            <Spinner className="size-3.5" />
            <span>{busyMessage}</span>
          </div>
        ) : null}
        <AnalysisTabEmptyState>
          {hasSolutionEvaluation
            ? "Ingen lederoppsummering ennå. Generer den separat fra vurderingen."
            : "Generer vurdering før lederoppsummeringen kan lages."}
        </AnalysisTabEmptyState>
      </div>
    );
  }

  const score = summary.likely_score_assessment;
  const executiveSummaryText = splitExecutiveLead(summary.executive_summary);

  return (
    <div className="min-w-0 space-y-5">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-[linear-gradient(180deg,rgba(248,250,252,0.98),rgba(255,255,255,0.94))] px-5 py-5 md:px-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[0.72rem] font-black uppercase tracking-[0.2em] text-slate-500">
                Leder oppsummering
              </p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                Beslutningsbildet på ett blikk
              </h2>
            </div>
            <Button
              variant="outline"
              onClick={onGenerate}
              disabled={busy || !hasSolutionEvaluation}
            >
              {busy ? (
                <Spinner className="size-4" />
              ) : (
                <ArrowUpRight data-icon="inline-start" />
              )}
              Rediger
            </Button>
          </div>
        </div>

        {busy && busyMessage ? (
          <div className="border-b border-slate-200 px-5 py-3 text-sm text-primary md:px-7">
            <span className="inline-flex items-center gap-2">
              <Spinner className="size-3.5" />
              {busyMessage}
            </span>
          </div>
        ) : null}

        <div className="min-w-0 space-y-5 px-5 py-6 md:px-7">
          <div className="overflow-hidden rounded-xl border border-cyan-200 bg-cyan-950 text-white shadow-[0_18px_42px_rgba(8,47,73,0.16)]">
            <div className="grid min-w-0 gap-0 xl:grid-cols-[minmax(0,1.08fr)_minmax(20rem,0.92fr)]">
              <div className="min-w-0 px-5 py-5 md:px-6 md:py-6">
                <p className="text-[0.68rem] font-black uppercase tracking-[0.18em] text-cyan-200/85">
                  Hovedkonklusjon
                </p>
                <MarkdownViewer
                  content={
                    executiveSummaryText.lead || summary.executive_summary
                  }
                  className="analysis-prose mt-3 max-w-none text-[1.25rem] font-semibold leading-8 text-white"
                />
                {executiveSummaryText.rest ? (
                  <MarkdownViewer
                    content={executiveSummaryText.rest}
                    className="analysis-prose mt-4 max-w-none border-t border-cyan-200/20 pt-4 text-[1rem] leading-7 text-cyan-50/90"
                  />
                ) : null}
              </div>

              <div className="min-w-0 border-t border-cyan-200/20 bg-lime-50 px-5 py-5 text-lime-950 xl:border-t-0 xl:border-l md:px-6 md:py-6">
                <div className="mb-3 flex items-center gap-2">
                  <Target className="size-4 text-lime-800" />
                  <p className="text-[0.72rem] font-black uppercase tracking-[0.18em] text-lime-900/70">
                    Fit mot kundebehov
                  </p>
                </div>
                <MarkdownViewer
                  content={summary.fit_to_customer_needs}
                  className="analysis-prose text-[1rem] leading-7 text-lime-950/90"
                />
              </div>
            </div>
          </div>

          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ExecutiveMetric
              label="Kvalitet"
              value={score.quality}
              icon={ClipboardCheck}
              tone="quality"
            />
            <ExecutiveMetric
              label="Gjennomføring"
              value={score.delivery_confidence}
              icon={Target}
              tone="delivery"
            />
            <ExecutiveMetric
              label="Risiko"
              value={score.risk}
              icon={FileWarning}
              tone="risk"
            />
            <ExecutiveMetric
              label="Konkurransekraft"
              value={score.competitiveness}
              icon={TrendingUp}
              tone="competition"
            />
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <ExecutiveList
          title="Hva taler for"
          items={summary.strengths}
          tone="trust"
        />
        <ExecutiveList
          title="Hva må håndteres"
          items={summary.weaknesses}
          tone="risk"
        />
      </div>
    </div>
  );
}
