"use client";

import { useEffect, useState } from "react";
import {
  FileText,
  RefreshCw,
  Scale,
  ShieldCheck,
  Sparkles,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { AnalysisTabEmptyState } from "@/components/projects/project-workspace-shared";
import type { ProjectDocument, SolutionEvaluationResult } from "@/lib/types";

function getArchitectureComparison(evaluation: SolutionEvaluationResult) {
  return (
    evaluation.architecture_comparison ?? {
      winner: "Uavgjort" as const,
      architect_solution_score: 0,
      system_solution_score: 0,
      verdict: "",
      strong_critique: [],
      pragmatic_reflections: [],
      strategy_improvement_advice: [],
    }
  );
}

function ArchitectScoreCard({ score }: { score: number }) {
  const safeScore = Math.min(100, Math.max(0, Math.round(score || 0)));
  const scoreColor =
    safeScore >= 80
      ? "text-emerald-700"
      : safeScore >= 60
        ? "text-teal-700"
        : "text-amber-700";

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_18px_44px_rgba(15,23,42,0.08)]">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-500 via-yellow-400 to-emerald-500" />
      <div className="px-5 py-5 md:px-6 md:py-6">
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div className="min-w-0">
            <p className="text-[0.74rem] font-bold uppercase tracking-[0.14em] text-slate-500">
              Arkitektløsning
            </p>
            <h4 className="mt-2 text-2xl font-semibold leading-tight tracking-[-0.025em] text-slate-950">
              Score mot systemløsning
            </h4>
            <p className="mt-3 max-w-[38rem] text-[1rem] leading-7 text-slate-600">
              Viser hvor godt arkitektløsningen dekker kundebehov, risiko og
              konkurransekraft.
            </p>
          </div>
          <div className="shrink-0 text-left md:text-right">
            <div className={`text-5xl font-black leading-[0.9] tracking-[-0.04em] tabular-nums md:text-6xl ${scoreColor}`}>
              {safeScore}%
            </div>
          </div>
        </div>

        <div className="mt-7">
          <div className="relative h-4 overflow-hidden rounded-full bg-slate-100 shadow-inner">
            <div
              className="h-full rounded-full bg-gradient-to-r from-red-500 via-yellow-400 to-emerald-500"
              style={{ width: `${safeScore}%` }}
            />
            <div
              className="absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-slate-950 shadow-[0_8px_18px_rgba(15,23,42,0.25)]"
              style={{ left: `${safeScore}%` }}
            />
          </div>
          <div className="mt-3 grid grid-cols-3 text-xs font-semibold text-slate-400">
            <span>0%</span>
            <span className="text-center">50%</span>
            <span className="text-right">100%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComparisonList({
  items,
  markerClassName = "bg-slate-900",
}: {
  items: string[];
  markerClassName?: string;
}) {
  if (!items.length) {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        Ikke nok grunnlag i vurderingen.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {items.map((item, index) => (
        <div
          key={`${item}-${index}`}
          className="grid grid-cols-[1.4rem_minmax(0,1fr)] gap-2 rounded-lg bg-white/75 px-3 py-3"
        >
          <span
            className={`mt-1 flex size-5 items-center justify-center rounded-full text-[0.68rem] font-black text-white ${markerClassName}`}
          >
            {index + 1}
          </span>
          <MarkdownViewer
            content={item}
            className="analysis-prose min-w-0 text-sm leading-6 text-slate-700"
          />
        </div>
      ))}
    </div>
  );
}

function FindingPanel({
  title,
  count,
  icon: Icon,
  items,
  tone,
}: {
  title: string;
  count: number;
  icon: LucideIcon;
  items: string[];
  tone: "risk" | "gap" | "trust" | "improve";
}) {
  const toneMap = {
    risk: {
      shell: "border-rose-200 bg-rose-50/80",
      icon: "bg-rose-600 text-white",
      marker: "bg-rose-600",
    },
    gap: {
      shell: "border-amber-200 bg-amber-50/75",
      icon: "bg-amber-500 text-white",
      marker: "bg-amber-500",
    },
    trust: {
      shell: "border-emerald-200 bg-emerald-50/75",
      icon: "bg-emerald-600 text-white",
      marker: "bg-emerald-600",
    },
    improve: {
      shell: "border-blue-200 bg-blue-50/75",
      icon: "bg-blue-600 text-white",
      marker: "bg-blue-600",
    },
  }[tone];

  return (
    <div className={`rounded-xl border px-4 py-4 ${toneMap.shell}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${toneMap.icon}`}
          >
            <Icon className="size-5" />
          </span>
          <h3 className="min-w-0 text-sm font-black text-slate-950">
            {title}
          </h3>
        </div>
        <span className="shrink-0 rounded-full bg-white/80 px-2.5 py-1 text-xs font-black tabular-nums text-slate-800 shadow-sm">
          {count}
        </span>
      </div>
      <ComparisonList items={items} markerClassName={toneMap.marker} />
    </div>
  );
}

function buildArchitectureActions(evaluation: SolutionEvaluationResult) {
  const sourceItems = evaluation.rewrite_suggestions.length
    ? evaluation.rewrite_suggestions.map((suggestion, index) => ({
        location: suggestion.target || "Arkitektløsningen generelt",
        action: suggestion.suggestion,
        reason:
          evaluation.weaknesses[index] ??
          evaluation.missing_elements[index] ??
          evaluation.improvement_recommendations[index] ??
          "",
      }))
    : evaluation.weaknesses.slice(0, 4).map((weakness, index) => ({
        location:
          evaluation.generic_sections[index] ||
          evaluation.missing_elements[index] ||
          "Arkitektløsningen generelt",
        action:
          evaluation.improvement_recommendations[index] ||
          "Skriv delen mer konkret med ansvar, rekkefølge, beslutningspunkt og kundespesifikk konsekvens.",
        reason: weakness,
      }));

  return sourceItems.slice(0, 4);
}

function ArchitectureCallToAction({
  evaluation,
}: {
  evaluation: SolutionEvaluationResult;
}) {
  const actions = buildArchitectureActions(evaluation);

  if (!actions.length) {
    return null;
  }

  return (
    <section className="overflow-hidden rounded-xl border border-blue-200 bg-white shadow-sm">
      <div className="border-b border-blue-100 bg-blue-50/80 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
            <Sparkles className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-[0.7rem] font-black uppercase tracking-[0.18em] text-blue-700">
              Call To Action
            </p>
            <h3 className="mt-1 text-lg font-black text-slate-950">
              Adresser svakhetene i arkitektløsningen
            </h3>
          </div>
        </div>
      </div>
      <div className="grid gap-3 px-5 py-5 lg:grid-cols-2">
        {actions.map((item, index) => (
          <article
            key={`${item.location}-${index}`}
            className="rounded-lg border border-slate-200 bg-slate-50/80 px-4 py-4"
          >
            <div className="mb-3 flex items-start gap-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-black text-white">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[0.68rem] font-black uppercase tracking-[0.16em] text-slate-500">
                  Hvor i arkitektløsningen
                </p>
                <p className="mt-1 text-sm font-bold leading-6 text-slate-950">
                  {item.location}
                </p>
              </div>
            </div>
            {item.reason ? (
              <div className="mb-3 rounded-md border border-rose-100 bg-white px-3 py-3">
                <p className="mb-1 text-[0.68rem] font-black uppercase tracking-[0.14em] text-rose-600">
                  Svakhet
                </p>
                <MarkdownViewer
                  content={item.reason}
                  className="analysis-prose text-sm leading-6 text-slate-700"
                />
              </div>
            ) : null}
            <div className="rounded-md border border-blue-100 bg-white px-3 py-3">
              <p className="mb-1 text-[0.68rem] font-black uppercase tracking-[0.14em] text-blue-700">
                Gjør dette
              </p>
              <MarkdownViewer
                content={item.action}
                className="analysis-prose text-sm leading-6 text-slate-800"
              />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function ProjectEvaluationTab({
  documents,
  solutionEvaluation,
  hasSolutionDocument,
  busy,
  busyMessage,
  onGenerate,
}: {
  documents: ProjectDocument[];
  solutionEvaluation: SolutionEvaluationResult | null;
  hasSolutionDocument: boolean;
  busy: boolean;
  busyMessage: string;
  onGenerate: (documentId: string) => void;
}) {
  const [selectedDocumentId, setSelectedDocumentId] = useState(
    documents[0]?.id ?? "",
  );
  const evaluatedDocument = solutionEvaluation?.solution_document_id
    ? (documents.find(
        (document) => document.id === solutionEvaluation.solution_document_id,
      ) ?? documents[0] ?? null)
    : (documents.find((document) => document.id === selectedDocumentId) ??
      documents[0] ??
      null);
  const actionBusy = busy;

  useEffect(() => {
    if (
      solutionEvaluation?.solution_document_id &&
      documents.some(
        (document) => document.id === solutionEvaluation.solution_document_id,
      )
    ) {
      setSelectedDocumentId(solutionEvaluation.solution_document_id);
      return;
    }

    const selectedDocumentExists = documents.some(
      (document) => document.id === selectedDocumentId,
    );
    if (!selectedDocumentExists && documents[0]) {
      setSelectedDocumentId(documents[0].id);
    } else if (!documents.length && selectedDocumentId) {
      setSelectedDocumentId("");
    }
  }, [documents, selectedDocumentId, solutionEvaluation?.solution_document_id]);

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <div className="mb-6 flex flex-wrap justify-end gap-2">
        <Button
          onClick={() => onGenerate(selectedDocumentId)}
          disabled={actionBusy || !selectedDocumentId}
          size="lg"
        >
          {busy ? (
            <Spinner className="size-4" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          Generer sammenligning
        </Button>
      </div>

      <section className="mb-6 overflow-hidden rounded-xl border border-slate-200/80 bg-white px-5 py-5 shadow-sm">
        {solutionEvaluation ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Vurdering gjort fra
            </p>
            <div className="mt-3 flex min-w-0 items-start gap-3">
              <FileText className="mt-0.5 size-4 shrink-0 text-teal-700" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-950">
                  {evaluatedDocument?.title ?? "Ukjent dokumentgrunnlag"}
                </p>
                {evaluatedDocument ? (
                  <p className="mt-1 text-xs text-slate-500">
                    {evaluatedDocument.file_format.toUpperCase()} ·{" "}
                    {Math.max(
                      1,
                      Math.round(evaluatedDocument.file_size_bytes / 1024),
                    )}{" "}
                    KB
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-slate-500">
                    Dokumentet finnes ikke lenger i dokumentbanken.
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200/80 bg-white/78 px-4 py-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-foreground">
                  Velg fra opplastede dokumenter
                </h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  Velg hvilket dokument som skal vurderes som arkitektløsning.
                </p>
              </div>
            </div>

            {documents.length ? (
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {documents.map((document) => {
                  const isSelected = selectedDocumentId === document.id;

                  return (
                    <button
                      key={document.id}
                      type="button"
                      onClick={() => setSelectedDocumentId(document.id)}
                      className={`flex w-full min-w-0 items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${
                        isSelected
                          ? "border-slate-950 bg-white shadow-sm"
                          : "border-slate-200 bg-white/65 hover:border-slate-400 hover:bg-white"
                      }`}
                    >
                      <FileText className="mt-0.5 size-4 shrink-0 text-teal-700" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {document.title}
                          </span>
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {document.file_format.toUpperCase()} ·{" "}
                          {Math.max(
                            1,
                            Math.round(document.file_size_bytes / 1024),
                          )}{" "}
                          KB
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-white px-4 py-8 text-center text-sm text-muted-foreground">
                Ingen aktuelle dokumenter er lastet opp ennå.
              </div>
            )}
          </div>
        )}
      </section>

      {busy && busyMessage ? (
        <div className="mb-4 flex items-center gap-2 text-sm text-primary">
          <Spinner className="size-3.5" />
          <span>{busyMessage}</span>
        </div>
      ) : null}

      {solutionEvaluation ? (
        <div className="space-y-6">
          {(() => {
            const comparison = getArchitectureComparison(solutionEvaluation);

            return (
              <section className="space-y-4">
                <ArchitectScoreCard score={comparison.architect_solution_score} />

                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white px-5 py-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)] md:px-7 md:py-7">
                  <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white shadow-sm">
                        <Scale className="size-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-bold uppercase text-slate-500">
                          Konklusjon
                        </p>
                        <h3 className="mt-1 text-3xl font-black text-slate-950">
                          {comparison.winner}
                        </h3>
                      </div>
                    </div>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                      Arkitektløsning vurdert
                    </span>
                  </div>
                  <div className="rounded-lg border-l-4 border-teal-500 bg-slate-50 px-4 py-4">
                    <MarkdownViewer
                      content={comparison.verdict}
                      className="analysis-prose max-w-none text-[1rem] leading-7 text-slate-700"
                    />
                  </div>
                </div>
              </section>
            );
          })()}

          <div className="grid gap-5 lg:grid-cols-2">
            <FindingPanel
              title="Styrker"
              count={solutionEvaluation.strengths.length}
              icon={ShieldCheck}
              items={solutionEvaluation.strengths}
              tone="trust"
            />
            <FindingPanel
              title="Svakheter"
              count={solutionEvaluation.weaknesses.length}
              icon={XCircle}
              items={solutionEvaluation.weaknesses}
              tone="risk"
            />
          </div>

          <ArchitectureCallToAction evaluation={solutionEvaluation} />
        </div>
      ) : (
        <AnalysisTabEmptyState>
          {hasSolutionDocument
            ? "Ingen sammenligning ennå. Generer vurderingen for å sammenligne systemstrategien med arkitektløsningen."
            : "Last opp et dokument og velg det som arkitektløsning før du kjører sammenligningen."}
        </AnalysisTabEmptyState>
      )}
    </div>
  );
}
