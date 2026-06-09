"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  CheckCircle2,
  CheckSquare,
  ListChecks,
  MapPin,
  Scale,
  ShieldCheck,
  Sparkles,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import {
  AnalysisTabEmptyState,
  DocumentSourceMeta,
  DocumentUploadDropzoneContent,
  GenerationProgress,
  documentDropzoneClass,
} from "@/components/projects/project-workspace-shared";
import type { ProjectDocument, SolutionEvaluationResult } from "@/lib/types";

type SolutionDocumentFinding =
  SolutionEvaluationResult["document_findings"][number];
type RequirementCoverage = NonNullable<
  SolutionEvaluationResult["requirement_coverage"]
>;
type RequirementCoverageItem = RequirementCoverage["items"][number];

function cleanEvaluationTypography(value: string) {
  let text = value
    .replace(/\b(Tabell\s+ID\s+\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/gi, "$1-$2")
    .replace(/\bID\s+(\d{1,3})\s*[-.]\s*(\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/gi, "ID $1-$2-$3")
    .replace(/\s+/g, " ")
    .trim();

  for (let index = 0; index < 4; index += 1) {
    const next = text
      .replace(/\b(\p{Lu}[\p{Ll}]{2,})\s+(\p{Ll})\s+(\p{Ll}{2,})\b/gu, "$1$2$3")
      .replace(/\b([A-ZÆØÅ]{2,})\s+([A-ZÆØÅ])\s+([A-ZÆØÅ]{2,})\b/g, "$1$2$3")
      .replace(/\b(\p{Lu}[\p{Ll}]{6,})\s+(ing|ering|nning|erhet|dtering)\b/gu, "$1$2");

    if (next === text) {
      break;
    }

    text = next;
  }

  return text;
}

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
              Løsningsscore
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
  const referencedFindings = evaluation.document_findings
    .filter((finding) => finding.assessment !== "Godt")
    .map((finding) => ({
      location: finding.reference || "Arkitektløsningen generelt",
      action:
        finding.recommendation ||
        "Rett svaret slik at det kobles tydeligere til kundens behov, krav og evalueringssignaler.",
      reason: finding.finding || finding.evidence,
    }));

  const sourceItems = referencedFindings.length
    ? referencedFindings
    : evaluation.rewrite_suggestions.length
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

function findingTone(finding: SolutionDocumentFinding) {
  switch (finding.assessment) {
    case "Godt":
      return {
        shell: "border-emerald-200 bg-emerald-50/70",
        badge: "border-emerald-200 bg-emerald-100 text-emerald-800",
        icon: CheckCircle2,
      };
    case "Dårlig":
      return {
        shell: "border-rose-200 bg-rose-50/70",
        badge: "border-rose-200 bg-rose-100 text-rose-800",
        icon: XCircle,
      };
    case "Mangler":
      return {
        shell: "border-amber-200 bg-amber-50/70",
        badge: "border-amber-200 bg-amber-100 text-amber-800",
        icon: AlertTriangle,
      };
    default:
      return {
        shell: "border-slate-200 bg-slate-50/80",
        badge: "border-slate-200 bg-slate-100 text-slate-700",
        icon: MapPin,
      };
  }
}

function assessmentTone(assessment: RequirementCoverageItem["assessment"]) {
  switch (assessment) {
    case "Godt":
      return {
        shell: "border-emerald-200 bg-emerald-50/70",
        badge: "border-emerald-200 bg-emerald-100 text-emerald-800",
        icon: CheckCircle2,
      };
    case "Dårlig":
      return {
        shell: "border-rose-200 bg-rose-50/70",
        badge: "border-rose-200 bg-rose-100 text-rose-800",
        icon: XCircle,
      };
    case "Mangler":
      return {
        shell: "border-amber-200 bg-amber-50/70",
        badge: "border-amber-200 bg-amber-100 text-amber-800",
        icon: AlertTriangle,
      };
    default:
      return {
        shell: "border-slate-200 bg-slate-50/80",
        badge: "border-slate-200 bg-slate-100 text-slate-700",
        icon: MapPin,
      };
  }
}

function RequirementCoveragePanel({
  coverage,
}: {
  coverage?: RequirementCoverage | null;
}) {
  if (!coverage?.items.length) {
    return null;
  }

  const total = Math.max(
    coverage.total_requirements || 0,
    coverage.items.length,
  );
  const assessed = Math.min(total, coverage.assessed_requirements || coverage.items.length);
  const assessedPercent = total ? Math.round((assessed / total) * 100) : 0;
  const stats = [
    {
      label: "Godt",
      value: coverage.good,
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    },
    {
      label: "Dårlig",
      value: coverage.weak,
      className: "border-rose-200 bg-rose-50 text-rose-800",
    },
    {
      label: "Mangler",
      value: coverage.missing,
      className: "border-amber-200 bg-amber-50 text-amber-800",
    },
    {
      label: "Uklart",
      value: coverage.unclear,
      className: "border-slate-200 bg-slate-50 text-slate-700",
    },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white shadow-sm">
              <ListChecks className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[0.7rem] font-black uppercase tracking-[0.18em] text-slate-500">
                Kravdekning
              </p>
              <h3 className="mt-1 text-lg font-black text-slate-950">
                Krav vurdert mot arkitektens svar
              </h3>
            </div>
          </div>
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-bold text-slate-600">
            {assessed} av {total} krav
          </span>
        </div>

        <div className="mt-4">
          <div className="h-2 overflow-hidden rounded-full bg-white shadow-inner">
            <div
              className="h-full rounded-full bg-slate-950"
              style={{ width: `${assessedPercent}%` }}
            />
          </div>
          <p className="mt-2 text-xs font-semibold text-slate-500">
            Dekningssikkerhet: {coverage.confidence}
          </p>
        </div>
      </div>

      <div className="px-5 py-5">
        {coverage.coverage_summary ? (
          <MarkdownViewer
            content={coverage.coverage_summary}
            className="analysis-prose mb-4 max-w-none text-sm leading-6 text-slate-700"
          />
        ) : null}

        <div className="mb-4 grid gap-2 sm:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className={`rounded-lg border px-3 py-3 ${stat.className}`}
            >
              <p className="text-[0.68rem] font-black uppercase tracking-[0.14em]">
                {stat.label}
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums">
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        <div className="max-h-[34rem] space-y-3 overflow-auto pr-1">
          {coverage.items.map((item, index) => {
            const tone = assessmentTone(item.assessment);
            const Icon = tone.icon;

            return (
              <article
                key={`${item.reference}-${index}`}
                className={`rounded-xl border px-4 py-4 ${tone.shell}`}
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-slate-800 shadow-sm">
                      <Icon className="size-4.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${tone.badge}`}>
                          {item.assessment}
                        </span>
                        <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-700">
                          {item.reference
                            ? cleanEvaluationTypography(item.reference)
                            : "Kravreferanse mangler"}
                        </span>
                      </div>
                      <MarkdownViewer
                        content={item.requirement || "Kravtekst mangler."}
                        className="analysis-prose mt-3 max-w-none text-sm font-semibold leading-6 text-slate-900"
                      />
                    </div>
                  </div>
                </div>

                <div className="mb-3 inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-600">
                  <MapPin className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">
                    {item.source_reference
                      ? cleanEvaluationTypography(item.source_reference)
                      : "Kilde mangler"}
                  </span>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-lg border border-white/80 bg-white/80 px-3 py-3">
                    <p className="mb-1 text-[0.68rem] font-black uppercase tracking-[0.14em] text-slate-500">
                      Vurdering
                    </p>
                    <MarkdownViewer
                      content={item.rationale || "Ikke angitt."}
                      className="analysis-prose text-sm leading-6 text-slate-700"
                    />
                  </div>
                  <div className="rounded-lg border border-white/80 bg-white/80 px-3 py-3">
                    <p className="mb-1 text-[0.68rem] font-black uppercase tracking-[0.14em] text-slate-500">
                      Bevis
                    </p>
                    <MarkdownViewer
                      content={item.evidence || "Ikke angitt."}
                      className="analysis-prose text-sm leading-6 text-slate-700"
                    />
                  </div>
                  <div className="rounded-lg border border-white/80 bg-white/80 px-3 py-3">
                    <p className="mb-1 text-[0.68rem] font-black uppercase tracking-[0.14em] text-blue-700">
                      Retting
                    </p>
                    <MarkdownViewer
                      content={item.recommendation || "Ikke angitt."}
                      className="analysis-prose text-sm leading-6 text-slate-800"
                    />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function DocumentFindingsPanel({
  findings,
}: {
  findings: SolutionDocumentFinding[];
}) {
  if (!findings.length) {
    return null;
  }

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[0.7rem] font-black uppercase tracking-[0.18em] text-slate-500">
              Bilag 2-referanser
            </p>
            <h3 className="mt-1 text-lg font-black text-slate-950">
              Funn i arkitektens svar
            </h3>
          </div>
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-bold text-slate-600">
            {findings.length} funn
          </span>
        </div>
      </div>

      <div className="grid gap-3 px-5 py-5">
        {findings.map((finding, index) => {
          const tone = findingTone(finding);
          const Icon = tone.icon;

          return (
            <article
              key={`${finding.reference}-${finding.finding}-${index}`}
              className={`rounded-xl border px-4 py-4 ${tone.shell}`}
            >
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-slate-800 shadow-sm">
                    <Icon className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${tone.badge}`}>
                        {finding.assessment}
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-700">
                        <MapPin className="size-3.5 shrink-0" />
                        <span className="min-w-0 truncate">
                          {finding.reference
                            ? cleanEvaluationTypography(finding.reference)
                            : "Referanse mangler"}
                        </span>
                      </span>
                    </div>
                    <MarkdownViewer
                      content={finding.finding || "Ingen vurderingstekst."}
                      className="analysis-prose mt-3 max-w-none text-sm font-medium leading-6 text-slate-800"
                    />
                  </div>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-white/80 bg-white/80 px-3 py-3">
                  <p className="mb-1 text-[0.68rem] font-black uppercase tracking-[0.14em] text-slate-500">
                    Bevis i Bilag 2
                  </p>
                  <MarkdownViewer
                    content={finding.evidence || "Ikke angitt."}
                    className="analysis-prose text-sm leading-6 text-slate-700"
                  />
                </div>
                <div className="rounded-lg border border-white/80 bg-white/80 px-3 py-3">
                  <p className="mb-1 text-[0.68rem] font-black uppercase tracking-[0.14em] text-blue-700">
                    Anbefalt retting
                  </p>
                  <MarkdownViewer
                    content={finding.recommendation || "Ikke angitt."}
                    className="analysis-prose text-sm leading-6 text-slate-800"
                  />
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ArchitectureDocumentDropzone({
  busy,
  disabled,
  onFile,
}: {
  busy: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  function handleFiles(files: FileList | null) {
    const nextFile = files?.[0];
    if (!nextFile || disabled) return;
    onFile(nextFile);
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(false);
    handleFiles(event.dataTransfer.files);
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    handleFiles(event.target.files);
    event.target.value = "";
  }

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
      disabled={disabled}
      className={documentDropzoneClass({ active: dragActive, disabled })}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.txt,.md,.xlsx,.xls"
        className="hidden"
        onChange={onInputChange}
        disabled={disabled}
      />
      <DocumentUploadDropzoneContent
        busy={busy}
        busyLabel="Laster inn dokumentet ..."
      />
    </button>
  );
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
                  {cleanEvaluationTypography(item.location)}
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
  busyProgress,
  onGenerate,
  importBusy,
  onImportArchitectureDocument,
}: {
  documents: ProjectDocument[];
  solutionEvaluation: SolutionEvaluationResult | null;
  hasSolutionDocument: boolean;
  busy: boolean;
  busyMessage: string;
  busyProgress: number;
  onGenerate: (documentId: string) => void;
  importBusy: boolean;
  onImportArchitectureDocument: (file: File) => Promise<ProjectDocument | null>;
}) {
  const candidateDocuments = useMemo(
    () =>
      documents.filter(
        (document) => document.role !== "primary_customer_document",
      ),
    [documents],
  );
  const [selectedDocumentId, setSelectedDocumentId] = useState(
    candidateDocuments[0]?.id ?? "",
  );
  const selectedDocument = candidateDocuments.find(
    (document) => document.id === selectedDocumentId,
  );
  const evaluatedDocument = solutionEvaluation?.solution_document_id
    ? (documents.find(
        (document) => document.id === solutionEvaluation.solution_document_id,
      ) ?? candidateDocuments[0] ?? null)
    : (selectedDocument ??
      candidateDocuments[0] ??
      null);
  const actionBusy = busy || importBusy;

  async function importAndEvaluate(file: File) {
    const document = await onImportArchitectureDocument(file);
    if (!document) return;
    setSelectedDocumentId(document.id);
    onGenerate(document.id);
  }

  useEffect(() => {
    if (
      solutionEvaluation?.solution_document_id &&
      candidateDocuments.some(
        (document) => document.id === solutionEvaluation.solution_document_id,
      )
    ) {
      setSelectedDocumentId(solutionEvaluation.solution_document_id);
      return;
    }

    const selectedDocumentExists = candidateDocuments.some(
      (document) => document.id === selectedDocumentId,
    );
    if (!selectedDocumentExists && candidateDocuments[0]) {
      setSelectedDocumentId(candidateDocuments[0].id);
    } else if (!candidateDocuments.length && selectedDocumentId) {
      setSelectedDocumentId("");
    }
  }, [candidateDocuments, selectedDocumentId, solutionEvaluation?.solution_document_id]);

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <section className="mb-5 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
        <div className="space-y-4">
          <div>
            <label className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">
              Dokument som skal vurderes
            </label>
            {candidateDocuments.length ? (
              <>
                <div className="relative mt-3">
                  <select
                    value={selectedDocumentId}
                    onChange={(event) => setSelectedDocumentId(event.target.value)}
                    disabled={actionBusy}
                    className="h-11 w-full appearance-none rounded-lg border border-slate-200 bg-white px-3 pr-10 text-sm font-semibold text-slate-950 shadow-sm outline-none transition-colors focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                  >
                    {candidateDocuments.map((document) => (
                      <option key={document.id} value={document.id}>
                        {document.title}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-950" />
                </div>
                <div className="mt-3">
                  <DocumentSourceMeta
                    document={evaluatedDocument}
                    label="Vurdering gjort fra"
                  />
                </div>
              </>
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-sm font-medium text-slate-500">
                Ingen Bilag 2- eller støttedokumenter er lastet opp ennå.
              </div>
            )}
          </div>

          <div>
            <h4 className="text-sm font-semibold text-slate-700">
              Last inn dokument
            </h4>
            <div className="mt-3">
              <ArchitectureDocumentDropzone
                busy={importBusy}
                disabled={actionBusy}
                onFile={(file) => void importAndEvaluate(file)}
              />
            </div>
          </div>

          <Button
            onClick={() => onGenerate(selectedDocumentId)}
            disabled={actionBusy || !selectedDocumentId}
            className="h-10 w-full justify-center rounded-lg bg-blue-900 text-sm font-bold text-white hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-500"
          >
            {busy || importBusy ? (
              <Spinner className="size-4" />
            ) : (
              <CheckSquare data-icon="inline-start" />
            )}
            Generer sammenligning
          </Button>
        </div>
      </section>

      {busy && busyMessage ? (
        <div className="mb-4">
          <GenerationProgress message={busyMessage} progress={busyProgress} />
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

          <RequirementCoveragePanel
            coverage={solutionEvaluation.requirement_coverage}
          />

          <DocumentFindingsPanel
            findings={solutionEvaluation.document_findings}
          />

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
