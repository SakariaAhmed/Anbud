"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
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
import { selectSolutionEvaluationDocumentCandidates } from "@/components/projects/project-evaluation-documents";
import {
  isDocumentReadyForEvaluation,
  isSolutionEvaluationCandidate,
} from "@/lib/document-processing";
import { summarizeRequirementCoverageCounters } from "@/lib/requirement-coverage-summary";
import { sortByRequirementOrder } from "@/lib/requirement-order";
import type { ProjectDocument, SolutionEvaluationResult } from "@/lib/types";

type SolutionDocumentFinding =
  SolutionEvaluationResult["document_findings"][number];
type RequirementCoverage = NonNullable<
  SolutionEvaluationResult["requirement_coverage"]
>;
type RequirementCoverageItem = RequirementCoverage["items"][number];

const eyebrowClass =
  "text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500";
const eyebrowAccentClass =
  "text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-blue-700";

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
  const scoreTone =
    safeScore >= 80
      ? { text: "text-emerald-700", bar: "bg-emerald-600" }
      : safeScore >= 60
        ? { text: "text-teal-700", bar: "bg-teal-600" }
        : { text: "text-amber-700", bar: "bg-amber-500" };

  return (
    <section className="border border-slate-200 bg-white px-5 py-5 md:px-7 md:py-6">
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div className="min-w-0">
            <p className={eyebrowClass}>Arkitektløsning</p>
            <h4 className="mt-2 text-2xl font-semibold leading-tight tracking-tight text-slate-900">
              Løsningsscore
            </h4>
            <p className="mt-2 max-w-[38rem] text-sm leading-6 text-slate-600">
              Viser hvor godt arkitektløsningen dekker kundebehov, risiko og
              konkurransekraft.
            </p>
          </div>
          <div className="shrink-0 text-left md:text-right">
            <div
              className={`text-5xl font-semibold leading-none tracking-tight tabular-nums md:text-6xl ${scoreTone.text}`}
            >
              {safeScore}%
            </div>
          </div>
        </div>

        <div className="mt-6">
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${scoreTone.bar}`}
              style={{ width: `${safeScore}%` }}
            />
          </div>
          <div className="mt-2 grid grid-cols-3 text-[0.68rem] font-medium tabular-nums text-slate-400">
            <span>0%</span>
            <span className="text-center">50%</span>
            <span className="text-right">100%</span>
          </div>
        </div>
    </section>
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
    <div className="space-y-2">
      {items.map((item, index) => (
        <div
          key={`${item}-${index}`}
          className="grid grid-cols-[1.4rem_minmax(0,1fr)] gap-2.5 rounded-lg bg-slate-50/80 px-3 py-2.5"
        >
          <span
            className={`mt-1 flex size-5 items-center justify-center rounded-full text-[0.65rem] font-semibold text-white ${markerClassName}`}
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
      accent: "bg-rose-500",
      icon: "bg-rose-50 text-rose-700",
      marker: "bg-rose-600",
    },
    gap: {
      accent: "bg-amber-400",
      icon: "bg-amber-50 text-amber-700",
      marker: "bg-amber-500",
    },
    trust: {
      accent: "bg-emerald-500",
      icon: "bg-emerald-50 text-emerald-700",
      marker: "bg-emerald-600",
    },
    improve: {
      accent: "bg-blue-600",
      icon: "bg-blue-50 text-blue-700",
      marker: "bg-blue-700",
    },
  }[tone];

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className={`absolute inset-y-0 left-0 w-1 ${toneMap.accent}`} />
      <div className="px-5 py-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${toneMap.icon}`}
            >
              <Icon className="size-4.5" />
            </span>
            <h3 className="min-w-0 font-serif text-base font-semibold tracking-tight text-slate-900">
              {title}
            </h3>
          </div>
          <span className="shrink-0 text-xs font-medium tabular-nums text-slate-500">
            {count}
          </span>
        </div>
        <ComparisonList items={items} markerClassName={toneMap.marker} />
      </div>
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
        accent: "border-l-emerald-500",
        badge: "border-emerald-200 bg-emerald-50 text-emerald-800",
        iconWrap: "bg-emerald-50 text-emerald-700",
        icon: CheckCircle2,
      };
    case "Dårlig":
      return {
        accent: "border-l-rose-500",
        badge: "border-rose-200 bg-rose-50 text-rose-800",
        iconWrap: "bg-rose-50 text-rose-700",
        icon: XCircle,
      };
    case "Mangler":
      return {
        accent: "border-l-amber-400",
        badge: "border-amber-200 bg-amber-50 text-amber-800",
        iconWrap: "bg-amber-50 text-amber-700",
        icon: AlertTriangle,
      };
    default:
      return {
        accent: "border-l-slate-300",
        badge: "border-slate-200 bg-slate-50 text-slate-700",
        iconWrap: "bg-slate-100 text-slate-600",
        icon: MapPin,
      };
  }
}

function assessmentTone(assessment: RequirementCoverageItem["assessment"]) {
  switch (assessment) {
    case "Godt":
      return {
        accent: "border-l-emerald-500",
        badge: "border-emerald-200 bg-emerald-50 text-emerald-800",
        iconWrap: "bg-emerald-50 text-emerald-700",
        icon: CheckCircle2,
      };
    case "Dårlig":
      return {
        accent: "border-l-rose-500",
        badge: "border-rose-200 bg-rose-50 text-rose-800",
        iconWrap: "bg-rose-50 text-rose-700",
        icon: XCircle,
      };
    case "Mangler":
      return {
        accent: "border-l-amber-400",
        badge: "border-amber-200 bg-amber-50 text-amber-800",
        iconWrap: "bg-amber-50 text-amber-700",
        icon: AlertTriangle,
      };
    default:
      return {
        accent: "border-l-slate-300",
        badge: "border-slate-200 bg-slate-50 text-slate-700",
        iconWrap: "bg-slate-100 text-slate-600",
        icon: MapPin,
      };
  }
}

function RequirementCoveragePanel({
  coverage,
}: {
  coverage?: RequirementCoverage | null;
}) {
  if (!coverage) {
    return null;
  }

  const counterSummary = summarizeRequirementCoverageCounters(coverage);
  const { total, assessed, assessedPercent } = counterSummary;
  const coverageItems = Array.isArray(coverage.items) ? coverage.items : [];
  const stats = [
    {
      label: "Godt",
      value: coverage.good ?? 0,
      dot: "bg-emerald-500",
      valueClass: "text-emerald-700",
    },
    {
      label: "Dårlig",
      value: coverage.weak ?? 0,
      dot: "bg-rose-500",
      valueClass: "text-rose-700",
    },
    {
      label: "Mangler",
      value: coverage.missing ?? 0,
      dot: "bg-amber-400",
      valueClass: "text-amber-700",
    },
    {
      label: "Uklart",
      value: coverage.unclear ?? 0,
      dot: "bg-slate-400",
      valueClass: "text-slate-700",
    },
  ];
  const orderedItems = sortByRequirementOrder(
    coverageItems,
    (item, index) => ({
      reference: item.reference,
      sourceReference: item.full_reference || item.source_reference,
      group: item.table_id,
      orderIndex: item.order_index,
      fallbackIndex: index,
    }),
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-5 py-4 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-900 text-white">
              <ListChecks className="size-4.5" />
            </span>
            <div className="min-w-0">
              <p className={eyebrowClass}>Kravdekning</p>
              <h3 className="mt-0.5 font-serif text-lg font-semibold tracking-tight text-slate-900">
                Krav vurdert mot arkitektens svar
              </h3>
            </div>
          </div>
          <span className="text-xs font-medium tabular-nums text-slate-500">
            {assessed} av {total} krav
          </span>
        </div>

        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-blue-900"
              style={{ width: `${assessedPercent}%` }}
            />
          </div>
          <p className="mt-2 text-xs font-medium text-slate-500">
            Dekningssikkerhet: {coverage.confidence}
          </p>
        </div>
      </div>

      <div className="px-5 py-5 md:px-6">
        {counterSummary.status !== "complete" ? (
          <div
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              counterSummary.status === "inconsistent"
                ? "border-rose-200 bg-rose-50 text-rose-900"
                : "border-amber-200 bg-amber-50 text-amber-950"
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="size-4" />
              {counterSummary.status === "inconsistent"
                ? "Kravdekningen har inkonsistente tellere"
                : "Kravvurderingen er ikke komplett"}
            </div>
            {counterSummary.status === "inconsistent" ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 leading-6">
                {counterSummary.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 leading-6">
                {total > 0
                  ? `Bare ${assessed} av ${total} krav er markert som vurdert.`
                  : "Vurderingen mangler et vurderbart kravgrunnlag."} Regenerer
                vurderingen før resultatet brukes som beslutningsgrunnlag.
              </p>
            )}
          </div>
        ) : null}

        {coverage.coverage_summary ? (
          <MarkdownViewer
            content={coverage.coverage_summary}
            className="analysis-prose mb-4 max-w-none text-sm leading-6 text-slate-700"
          />
        ) : null}

        <div className="mb-5 grid gap-2 sm:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-slate-200 bg-white px-3 py-3"
            >
              <p className="flex items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                <span className={`size-1.5 rounded-full ${stat.dot}`} />
                {stat.label}
              </p>
              <p
                className={`mt-1.5 font-serif text-2xl font-semibold tabular-nums tracking-tight ${stat.valueClass}`}
              >
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        {orderedItems.length ? (
          <div className="max-h-[34rem] space-y-3 overflow-auto pr-1">
            {orderedItems.map((item, index) => {
              const tone = assessmentTone(item.assessment);
              const Icon = tone.icon;

              return (
                <article
                  key={`${item.reference}-${index}`}
                  className={`rounded-xl border border-slate-200 border-l-[3px] bg-white px-4 py-4 shadow-sm ${tone.accent}`}
                >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${tone.iconWrap}`}
                    >
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone.badge}`}
                        >
                          {item.assessment}
                        </span>
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                          {item.reference
                            ? cleanEvaluationTypography(item.reference)
                            : "Kravreferanse mangler"}
                        </span>
                      </div>
                      <MarkdownViewer
                        content={item.requirement || "Kravtekst mangler."}
                        className="analysis-prose mt-3 max-w-none text-sm font-medium leading-6 text-slate-900"
                      />
                    </div>
                  </div>
                </div>

                <div className="mb-3 inline-flex max-w-full items-start gap-1.5 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs font-medium leading-5 text-slate-500">
                  <MapPin className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    {item.full_reference || item.source_reference
                      ? cleanEvaluationTypography(item.full_reference || item.source_reference)
                      : "Kilde mangler"}
                  </span>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-lg bg-slate-50 px-3 py-3">
                    <p className={`mb-1.5 ${eyebrowClass}`}>Vurdering</p>
                    <MarkdownViewer
                      content={item.rationale || "Ikke angitt."}
                      className="analysis-prose text-sm leading-6 text-slate-700"
                    />
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-3">
                    <p className={`mb-1.5 ${eyebrowClass}`}>Bevis</p>
                    <MarkdownViewer
                      content={item.evidence || "Ikke angitt."}
                      className="analysis-prose text-sm leading-6 text-slate-700"
                    />
                  </div>
                  <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-3">
                    <p className={`mb-1.5 ${eyebrowAccentClass}`}>Retting</p>
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
        ) : (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900">
            Vurderingen inneholder ingen kravrader. Regenerer vurderingen før den
            brukes.
          </p>
        )}
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
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-5 py-4 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={eyebrowClass}>Bilag 2-referanser</p>
            <h3 className="mt-0.5 font-serif text-lg font-semibold tracking-tight text-slate-900">
              Funn i arkitektens svar
            </h3>
          </div>
          <span className="text-xs font-medium tabular-nums text-slate-500">
            {findings.length} funn
          </span>
        </div>
      </div>

      <div className="grid gap-3 px-5 py-5 md:px-6">
        {findings.map((finding, index) => {
          const tone = findingTone(finding);
          const Icon = tone.icon;

          return (
            <article
              key={`${finding.reference}-${finding.finding}-${index}`}
              className={`rounded-xl border border-slate-200 border-l-[3px] bg-white px-4 py-4 shadow-sm ${tone.accent}`}
            >
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${tone.iconWrap}`}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone.badge}`}
                      >
                        {finding.assessment}
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-600">
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
                <div className="rounded-lg bg-slate-50 px-3 py-3">
                  <p className={`mb-1.5 ${eyebrowClass}`}>Bevis i Bilag 2</p>
                  <MarkdownViewer
                    content={finding.evidence || "Ikke angitt."}
                    className="analysis-prose text-sm leading-6 text-slate-700"
                  />
                </div>
                <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-3">
                  <p className={`mb-1.5 ${eyebrowAccentClass}`}>
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
    <section className="overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-sm">
      <div className="border-b border-blue-100 bg-blue-50/60 px-5 py-4 md:px-6">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-900 text-white">
            <Sparkles className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className={eyebrowAccentClass}>Call To Action</p>
            <h3 className="mt-0.5 font-serif text-lg font-semibold tracking-tight text-slate-900">
              Adresser svakhetene i arkitektløsningen
            </h3>
          </div>
        </div>
      </div>
      <div className="grid gap-3 px-5 py-5 md:px-6 lg:grid-cols-2">
        {actions.map((item, index) => (
          <article
            key={`${item.location}-${index}`}
            className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition-transform duration-[180ms] ease-out hover:-translate-y-0.5"
          >
            <div className="mb-3 flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-900 text-xs font-semibold text-white">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className={eyebrowClass}>Hvor i arkitektløsningen</p>
                <p className="mt-1 text-sm font-semibold leading-6 text-slate-900">
                  {cleanEvaluationTypography(item.location)}
                </p>
              </div>
            </div>
            {item.reason ? (
              <div className="mb-3 rounded-lg border-l-2 border-rose-300 bg-rose-50/50 px-3 py-3">
                <p className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-rose-600">
                  Svakhet
                </p>
                <MarkdownViewer
                  content={item.reason}
                  className="analysis-prose text-sm leading-6 text-slate-700"
                />
              </div>
            ) : null}
            <div className="rounded-lg border-l-2 border-blue-300 bg-blue-50/50 px-3 py-3">
              <p className={`mb-1.5 ${eyebrowAccentClass}`}>Gjør dette</p>
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
  onGenerate: (
    documentId: string,
    importedDocument?: ProjectDocument,
  ) => Promise<void>;
  importBusy: boolean;
  onImportArchitectureDocument: (file: File) => Promise<ProjectDocument | null>;
}) {
  const candidateDocuments = useMemo(
    () => selectSolutionEvaluationDocumentCandidates(documents),
    [documents],
  );
  const [selectedDocumentId, setSelectedDocumentId] = useState(
    candidateDocuments.find(isDocumentReadyForEvaluation)?.id ??
      candidateDocuments[0]?.id ??
      "",
  );
  const selectedDocument = candidateDocuments.find(
    (document) => document.id === selectedDocumentId,
  );
  const selectedDocumentReady = isDocumentReadyForEvaluation(selectedDocument);
  const selectedDocumentRunnable =
    Boolean(selectedDocument && isSolutionEvaluationCandidate(selectedDocument));
  const evaluatedDocument = solutionEvaluation?.solution_document_id
    ? (documents.find(
        (document) => document.id === solutionEvaluation.solution_document_id,
      ) ?? candidateDocuments[0] ?? null)
    : (selectedDocument ??
      candidateDocuments[0] ??
      null);
  const evaluatedGeneratedArtifactTitle =
    solutionEvaluation?.evaluation_context?.system_solution_artifact_title ??
    null;
  const evaluatesGeneratedArtifact = Boolean(
    solutionEvaluation?.evaluated_generated_artifact_id ??
      solutionEvaluation?.evaluation_context?.system_solution_artifact_id,
  );
  const actionBusy = busy || importBusy;
  const documentSelectId = "solution-evaluation-document-select";

  async function importAndEvaluate(file: File) {
    const document = await onImportArchitectureDocument(file);
    if (!document || !isSolutionEvaluationCandidate(document)) return;
    setSelectedDocumentId(document.id);
    await onGenerate(document.id, document);
  }

  function handleGenerateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionBusy || !selectedDocumentId || !selectedDocumentRunnable) {
      return;
    }
    void onGenerate(selectedDocumentId);
  }

  useEffect(() => {
    setSelectedDocumentId((currentId) => {
      const currentDocument = candidateDocuments.find(
        (document) => document.id === currentId,
      );
      if (isDocumentReadyForEvaluation(currentDocument)) {
        return currentId;
      }
      if (
        solutionEvaluation?.solution_document_id &&
        isDocumentReadyForEvaluation(
          candidateDocuments.find(
            (document) =>
              document.id === solutionEvaluation.solution_document_id,
          ),
        )
      ) {
        return solutionEvaluation.solution_document_id;
      }
      return (
        candidateDocuments.find(isDocumentReadyForEvaluation)?.id ??
        currentDocument?.id ??
        candidateDocuments[0]?.id ??
        ""
      );
    });
  }, [candidateDocuments, solutionEvaluation?.solution_document_id]);

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <section
        className="mb-5 border border-slate-200 bg-white px-5 py-5"
      >
        <form className="space-y-5" onSubmit={handleGenerateSubmit}>
          <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <label htmlFor={documentSelectId} className={eyebrowClass}>
              Dokument som skal vurderes
            </label>
            {candidateDocuments.length ? (
              <>
                <div className="relative mt-2.5">
                  <select
                    id={documentSelectId}
                    value={selectedDocumentId}
                    onChange={(event) => setSelectedDocumentId(event.target.value)}
                    disabled={actionBusy}
                    className="h-11 w-full appearance-none rounded-lg border border-slate-200 bg-white px-3 pr-10 text-sm font-medium text-slate-900 shadow-sm outline-none transition-colors duration-[180ms] focus:border-blue-700 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                  >
                    {candidateDocuments.map((document) => (
                      <option
                        key={document.id}
                        value={document.id}
                        disabled={!isDocumentReadyForEvaluation(document)}
                      >
                        {document.title}
                        {isDocumentReadyForEvaluation(document)
                          ? ""
                          : document.processing_status === "failed"
                            ? " — indeksering feilet"
                            : " — indekseres"}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
                </div>
                <div className="mt-3">
                  <DocumentSourceMeta
                    document={evaluatedDocument}
                    label="Vurdering gjort fra"
                  />
                </div>
                {selectedDocument && !selectedDocumentReady ? (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm font-medium text-amber-900">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {selectedDocument.processing_status === "failed"
                        ? selectedDocument.processing_error ||
                          "Dokumentindekseringen feilet. Last opp dokumentet på nytt før vurdering."
                        : selectedDocument.processing_message ||
                          "Dokumentet indekseres fortsatt. Vurderingen kan startes når dokumentet er RAG-klart."}
                    </span>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mt-2.5 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-sm font-medium text-slate-500">
                Ingen Bilag 2- eller støttedokumenter er lastet opp ennå.
              </div>
            )}
          </div>

          <div className="flex flex-col border-t border-slate-100 pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <h4 className={eyebrowClass}>Last inn dokument</h4>
            <div className="mt-2.5 flex flex-1 flex-col [&>button]:flex-1">
              <ArchitectureDocumentDropzone
                busy={importBusy}
                disabled={actionBusy}
                onFile={(file) => void importAndEvaluate(file)}
              />
            </div>
          </div>
          </div>

          <div className="border-t border-slate-100 pt-5">
          <Button
            type="submit"
            disabled={
              actionBusy || !selectedDocumentId || !selectedDocumentRunnable
            }
            className="h-11 w-full justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition-colors duration-[180ms] hover:bg-primary-hover disabled:bg-slate-200 disabled:text-slate-500"
          >
            {busy || importBusy ? (
              <Spinner className="size-4" />
            ) : (
              <CheckSquare data-icon="inline-start" />
            )}
            Generer sammenligning
          </Button>
          </div>
        </form>
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

                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white px-5 py-6 shadow-sm md:px-7 md:py-7">
                  <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3.5">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-blue-900 text-white">
                        <Scale className="size-5" />
                      </span>
                      <div className="min-w-0">
                        <p className={eyebrowClass}>Konklusjon</p>
                        <h3 className="mt-1 font-serif text-3xl font-bold tracking-tight text-slate-900">
                          {comparison.winner}
                        </h3>
                      </div>
                    </div>
                    <span className="max-w-sm text-right text-xs font-medium leading-5 text-slate-500">
                      {evaluatesGeneratedArtifact
                        ? `Systemartefakt vurdert${
                            evaluatedGeneratedArtifactTitle
                              ? `: ${evaluatedGeneratedArtifactTitle}`
                              : ""
                          }`
                        : "Arkitektløsning vurdert"}
                    </span>
                  </div>
                  <div className="rounded-lg border-l-4 border-blue-900 bg-slate-50 px-4 py-4">
                    <MarkdownViewer
                      content={comparison.verdict}
                      className="analysis-prose max-w-none text-[0.95rem] leading-7 text-slate-700"
                    />
                  </div>
                </div>
              </section>
            );
          })()}

          <div>
            <RequirementCoveragePanel
              coverage={solutionEvaluation.requirement_coverage}
            />
          </div>

          <div>
            <DocumentFindingsPanel
              findings={solutionEvaluation.document_findings}
            />
          </div>

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

          <div>
            <ArchitectureCallToAction evaluation={solutionEvaluation} />
          </div>
        </div>
      ) : (
        <AnalysisTabEmptyState>
          {hasSolutionDocument
            ? "Ingen sammenligning ennå. Generer vurderingen for å sammenligne systemstrategien med arkitektløsningen."
            : selectedDocument?.processing_status === "failed"
              ? selectedDocument.processing_error ||
                "Dokumentindekseringen feilet. Last opp dokumentet på nytt før vurdering."
            : candidateDocuments.length
              ? "Dokumentet indekseres fortsatt. Vurderingen kan startes når det er RAG-klart."
              : "Last opp et dokument og velg det som arkitektløsning før du kjører sammenligningen."}
        </AnalysisTabEmptyState>
      )}
    </div>
  );
}
