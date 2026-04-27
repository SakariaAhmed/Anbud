"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  FileWarning,
  Gauge,
  Lightbulb,
  RefreshCw,
  Scale,
  ShieldCheck,
  Target,
  TrendingUp,
  Upload,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { Input, Label } from "@/components/projects/primitives";
import {
  AnalysisTabEmptyState,
  VALUE_LABELS,
  ValueTags,
} from "@/components/projects/project-workspace-shared";
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

function ScoreBar({
  label,
  score,
  tone,
}: {
  label: string;
  score: number;
  tone: "system" | "architect";
}) {
  const safeScore = Math.min(100, Math.max(0, Math.round(score || 0)));
  const toneClassName =
    tone === "architect"
      ? "from-emerald-500 via-teal-500 to-cyan-500"
      : "from-blue-600 via-indigo-500 to-sky-500";

  return (
    <div className="rounded-lg border border-white/70 bg-white/86 px-4 py-4 shadow-[0_12px_28px_rgba(15,23,42,0.07)]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-slate-900">{label}</p>
        <span className="text-xl font-black tabular-nums text-slate-950">
          {safeScore}/100
        </span>
      </div>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200/85 shadow-inner">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${toneClassName}`}
          style={{ width: `${safeScore}%` }}
        />
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

function StatTile({
  label,
  value,
  icon: Icon,
  className,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  className: string;
}) {
  return (
    <div className={`min-w-0 px-4 py-4 ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/80 text-slate-950 shadow-sm">
          <Icon className="size-4" />
        </span>
        <p className="text-[0.7rem] font-black uppercase tracking-[0.16em] text-slate-700/70">
          {label}
        </p>
      </div>
      <MarkdownViewer
        content={value}
        className="analysis-prose text-[0.95rem] leading-6 text-slate-900"
      />
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

function DetailList({ items }: { items: string[] }) {
  if (!items.length) {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        Ingen punkter registrert.
      </p>
    );
  }

  return (
    <ul className="grid gap-2.5">
      {items.map((item, index) => (
        <li
          key={`${item}-${index}`}
          className="rounded-lg border border-slate-200/80 bg-white px-3 py-3 text-sm text-foreground shadow-sm"
        >
          <MarkdownViewer
            content={item}
            className="analysis-prose text-sm leading-6 text-slate-700"
          />
        </li>
      ))}
    </ul>
  );
}

export function ProjectEvaluationTab({
  documents,
  solutionEvaluation,
  hasSolutionDocument,
  busy,
  uploadBusy,
  selectBusy,
  improveBusy,
  busyMessage,
  onUploadArchitectureDocument,
  onSelectArchitectureDocument,
  onGenerate,
  onImproveSystemSolution,
}: {
  documents: ProjectDocument[];
  solutionEvaluation: SolutionEvaluationResult | null;
  hasSolutionDocument: boolean;
  busy: boolean;
  uploadBusy: boolean;
  selectBusy: boolean;
  improveBusy: boolean;
  busyMessage: string;
  onUploadArchitectureDocument: (file: File, title: string) => Promise<void>;
  onSelectArchitectureDocument: (documentId: string) => Promise<void>;
  onGenerate: () => void;
  onImproveSystemSolution: () => void;
}) {
  const [architectureTitle, setArchitectureTitle] = useState("");
  const [architectureFile, setArchitectureFile] = useState<File | null>(null);
  const [architectureFileInputKey, setArchitectureFileInputKey] = useState(0);
  const [selectedDocumentId, setSelectedDocumentId] = useState(
    documents.find((document) => document.role === "primary_solution_document")
      ?.id ?? "",
  );
  const architectureDocuments = documents.filter(
    (document) => document.role !== "primary_customer_document",
  );
  const currentArchitectureDocument =
    documents.find((document) => document.role === "primary_solution_document") ??
    null;
  const systemSolutionScore =
    solutionEvaluation?.architecture_comparison?.system_solution_score ?? null;
  const canImproveSystemSolution =
    systemSolutionScore !== null && Math.round(systemSolutionScore) < 100;
  const actionBusy = busy || uploadBusy || selectBusy || improveBusy;

  useEffect(() => {
    if (currentArchitectureDocument) {
      setSelectedDocumentId(currentArchitectureDocument.id);
    }
  }, [currentArchitectureDocument?.id]);

  async function handleUploadArchitecture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!architectureFile) {
      return;
    }
    await onUploadArchitectureDocument(architectureFile, architectureTitle.trim());
    setArchitectureTitle("");
    setArchitectureFile(null);
    setArchitectureFileInputKey((current) => current + 1);
  }

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <div className="mb-6 flex flex-wrap justify-end gap-2">
        {canImproveSystemSolution ? (
          <Button
            onClick={onImproveSystemSolution}
            disabled={actionBusy}
            size="lg"
            variant="outline"
          >
            {improveBusy ? (
              <Spinner className="size-4" />
            ) : (
              <Target data-icon="inline-start" />
            )}
            Forbedre systemløsning til 100%
          </Button>
        ) : null}
        <Button
          onClick={onGenerate}
          disabled={actionBusy || !hasSolutionDocument}
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

      <section className="mb-6 overflow-hidden rounded-xl border border-slate-200/80 bg-[linear-gradient(135deg,rgba(255,255,255,0.98),rgba(240,253,250,0.74)_42%,rgba(239,246,255,0.72))] shadow-sm">
        <div className="grid min-w-0 gap-5 px-5 py-5 xl:grid-cols-[minmax(20rem,0.85fr)_minmax(0,1.15fr)]">
          <form
            onSubmit={handleUploadArchitecture}
            className="rounded-xl border border-teal-200/80 bg-white/78 px-4 py-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]"
          >
            <div className="mb-4 flex items-start gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-teal-600 text-white shadow-sm">
                <Upload className="size-5" />
              </div>
              <div className="min-w-0">
                <h4 className="text-sm font-bold text-foreground">
                  Last opp ny arkitektløsning
                </h4>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  PDF, DOCX, TXT eller MD lagres som primært løsningsdokument.
                </p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="architectureTitle">Tittel</Label>
                <Input
                  id="architectureTitle"
                  value={architectureTitle}
                  onChange={(event) =>
                    setArchitectureTitle(event.target.value)
                  }
                  placeholder="F.eks. Arkitektens løsningsforslag"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="architectureFile">Fil</Label>
                <Input
                  key={architectureFileInputKey}
                  id="architectureFile"
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  onChange={(event) =>
                    setArchitectureFile(event.target.files?.[0] ?? null)
                  }
                />
              </div>
              <Button
                type="submit"
                disabled={busy || selectBusy || uploadBusy || !architectureFile}
                className="w-full"
              >
                {uploadBusy ? (
                  <Spinner className="size-4" />
                ) : (
                  <Upload data-icon="inline-start" />
                )}
                Last opp og bruk
              </Button>
            </div>
          </form>

          <div className="rounded-xl border border-slate-200/80 bg-white/78 px-4 py-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-foreground">
                  Velg fra opplastede dokumenter
                </h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  Scroll i listen og marker dokumentet som arkitektløsning.
                </p>
              </div>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  uploadBusy ||
                  selectBusy ||
                  !selectedDocumentId ||
                  selectedDocumentId === currentArchitectureDocument?.id
                }
                onClick={() => onSelectArchitectureDocument(selectedDocumentId)}
              >
                {selectBusy ? (
                  <Spinner className="size-4" />
                ) : (
                  <CheckCircle2 data-icon="inline-start" />
                )}
                Bruk valgt
              </Button>
            </div>

            {architectureDocuments.length ? (
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {architectureDocuments.map((document) => {
                  const isSelected = selectedDocumentId === document.id;
                  const isActive =
                    document.role === "primary_solution_document";

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
                          {isActive ? (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[0.7rem] font-bold uppercase tracking-[0.08em] text-emerald-800">
                              Aktiv
                            </span>
                          ) : null}
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
        </div>
      </section>

      {(busy || improveBusy) && busyMessage ? (
        <div className="mb-4 flex items-center gap-2 text-sm text-primary">
          <Spinner className="size-3.5" />
          <span>{busyMessage}</span>
        </div>
      ) : null}

      {solutionEvaluation ? (
        <div className="space-y-6">
          {(() => {
            const comparison = getArchitectureComparison(solutionEvaluation);
            const scoreDelta =
              Math.round(comparison.system_solution_score || 0) -
              Math.round(comparison.architect_solution_score || 0);

            return (
              <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm">
                <div className="grid min-w-0 lg:grid-cols-[minmax(0,0.95fr)_minmax(18rem,0.55fr)]">
                  <div className="min-w-0 bg-[linear-gradient(135deg,rgba(15,23,42,0.98),rgba(17,94,89,0.92))] px-5 py-6 text-white md:px-6">
                    <div className="mb-4 flex items-center gap-3">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-white text-slate-950">
                        <Scale className="size-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[0.68rem] font-black uppercase tracking-[0.18em] text-cyan-100">
                          Konklusjon
                        </p>
                        <h3 className="mt-1 text-2xl font-black tracking-tight text-white">
                          {comparison.winner}
                        </h3>
                      </div>
                    </div>
                    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm font-bold text-slate-200">
                      <span>Arkitektløsning</span>
                      <ArrowRight className="size-4 text-cyan-200" />
                      <span>Systemstrategi</span>
                      <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-cyan-100">
                        Delta {scoreDelta > 0 ? "+" : ""}
                        {scoreDelta}
                      </span>
                    </div>
                    <MarkdownViewer
                      content={comparison.verdict}
                      className="analysis-prose max-w-none text-[1rem] leading-7 text-slate-100"
                    />
                  </div>
                  <div className="grid content-center gap-4 bg-slate-50 px-5 py-5">
                    <ScoreBar
                      label="Arkitektløsning"
                      score={comparison.architect_solution_score}
                      tone="architect"
                    />
                    <ScoreBar
                      label="Systemløsning"
                      score={comparison.system_solution_score}
                      tone="system"
                    />
                  </div>
                </div>

                <div className="grid min-w-0 gap-4 bg-slate-50/70 px-5 py-5 2xl:grid-cols-3">
                  <FindingPanel
                    title="Sterk kritikk"
                    count={comparison.strong_critique.length}
                    icon={AlertTriangle}
                    items={comparison.strong_critique}
                    tone="risk"
                  />
                  <FindingPanel
                    title="Pragmatisk refleksjon"
                    count={comparison.pragmatic_reflections.length}
                    icon={Gauge}
                    items={comparison.pragmatic_reflections}
                    tone="gap"
                  />
                  <FindingPanel
                    title="Strategiråd"
                    count={comparison.strategy_improvement_advice.length}
                    icon={Lightbulb}
                    items={comparison.strategy_improvement_advice}
                    tone="improve"
                  />
                </div>
              </section>
            );
          })()}

          <section className="grid min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.62fr)]">
            <div className="min-w-0 px-5 py-5 md:px-6">
              <p className="text-[0.7rem] font-black uppercase tracking-[0.18em] text-slate-500">
                Ledelsesoppsummering
              </p>
              <MarkdownViewer
                content={solutionEvaluation.executive_summary}
                className="analysis-prose mt-3 text-[1rem] leading-7 text-slate-900"
              />
              <div className="mt-5 rounded-lg border-l-4 border-teal-600 bg-teal-50 px-4 py-4">
                <p className="mb-2 text-sm font-black text-teal-950">
                  Fit mot kundebehov
                </p>
                <MarkdownViewer
                  content={solutionEvaluation.fit_to_customer_needs}
                  className="analysis-prose text-sm leading-6 text-teal-950/80"
                />
              </div>
            </div>
            <div className="grid min-w-0 sm:grid-cols-2 xl:grid-cols-1">
              <StatTile
                label="Kvalitet"
                value={solutionEvaluation.likely_score_assessment.quality}
                icon={ClipboardCheck}
                className="bg-sky-50"
              />
              <StatTile
                label="Gjennomføring"
                value={
                  solutionEvaluation.likely_score_assessment.delivery_confidence
                }
                icon={Target}
                className="bg-emerald-50"
              />
              <StatTile
                label="Risiko"
                value={solutionEvaluation.likely_score_assessment.risk}
                icon={FileWarning}
                className="bg-rose-50"
              />
              <StatTile
                label="Konkurransekraft"
                value={solutionEvaluation.likely_score_assessment.competitiveness}
                icon={TrendingUp}
                className="bg-amber-50"
              />
            </div>
          </section>

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

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-sm">
            <div className="border-b border-slate-200 bg-white px-5 py-4">
              <p className="text-[0.7rem] font-black uppercase tracking-[0.18em] text-slate-500">
                Detaljfunn
              </p>
              <h3 className="mt-1 text-base font-black text-slate-950">
                Punktene som bør sjekkes før neste versjon
              </h3>
            </div>
            <Accordion>
              <AccordionItem value="generic-sections" className="border-slate-200">
                <AccordionTrigger className="px-5 py-4 text-sm font-black text-slate-900 hover:bg-amber-50/80">
                  Arkitektløsning: generiske partier (
                  {solutionEvaluation.generic_sections.length})
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-5">
                  <DetailList items={solutionEvaluation.generic_sections} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="missing-elements" className="border-slate-200">
                <AccordionTrigger className="px-5 py-4 text-sm font-black text-slate-900 hover:bg-amber-50/80">
                  Arkitektløsning: manglende elementer (
                  {solutionEvaluation.missing_elements.length})
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-5">
                  <DetailList items={solutionEvaluation.missing_elements} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="risks" className="border-slate-200">
                <AccordionTrigger className="px-5 py-4 text-sm font-black text-slate-900 hover:bg-rose-50/80">
                  Arkitektløsning: risiko for kunden (
                  {solutionEvaluation.risks_to_customer.length})
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-5">
                  <DetailList items={solutionEvaluation.risks_to_customer} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="trust-signals" className="border-slate-200">
                <AccordionTrigger className="px-5 py-4 text-sm font-black text-slate-900 hover:bg-emerald-50/80">
                  Arkitektløsning: tillitssignaler ({solutionEvaluation.trust_signals.length})
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-5">
                  <DetailList items={solutionEvaluation.trust_signals} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="improvements" className="border-slate-200">
                <AccordionTrigger className="px-5 py-4 text-sm font-black text-slate-900 hover:bg-blue-50/80">
                  Arkitektløsning: forbedringsforslag (
                  {solutionEvaluation.improvement_recommendations.length})
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-5">
                  <DetailList
                    items={solutionEvaluation.improvement_recommendations}
                  />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="value-assessment" className="border-slate-200">
                <AccordionTrigger className="px-5 py-4 text-sm font-black text-slate-900 hover:bg-teal-50/80">
                  Arkitektløsning: verdivurdering ({solutionEvaluation.value_assessment.length})
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-5">
                  <div className="space-y-3">
                    {solutionEvaluation.value_assessment.map((item, index) => (
                      <div
                        key={`${item.title}-${index}`}
                        className="rounded-lg border border-slate-200/80 bg-white px-3 py-3 shadow-sm"
                      >
                        <h4 className="text-sm font-black text-foreground">
                          {item.title}
                        </h4>
                        <MarkdownViewer
                          content={item.description}
                          className="text-sm text-muted-foreground"
                        />
                        <div className="mt-1">
                          <ValueTags
                            values={item.value_categories
                              .filter((v) => VALUE_LABELS.includes(v))
                              .slice(0, 1)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="rewrite-suggestions" className="border-slate-200">
                <AccordionTrigger className="px-5 py-4 text-sm font-black text-slate-900 hover:bg-indigo-50/80">
                  Arkitektløsning: omskrivingsforslag (
                  {solutionEvaluation.rewrite_suggestions.length})
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-5">
                  <div className="space-y-3">
                    {solutionEvaluation.rewrite_suggestions.map(
                      (suggestion, index) => (
                        <div
                          key={`${suggestion.target}-${index}`}
                          className="rounded-lg border border-slate-200/80 bg-white px-3 py-3 shadow-sm"
                        >
                          <p className="text-xs font-black uppercase tracking-[0.12em] text-muted-foreground">
                            {suggestion.target}
                          </p>
                          <MarkdownViewer
                            content={suggestion.suggestion}
                            className="text-sm text-foreground"
                          />
                        </div>
                      ),
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>
        </div>
      ) : (
        <AnalysisTabEmptyState>
          {hasSolutionDocument
            ? "Ingen sammenligning ennå. Generer vurderingen for å sammenligne systemstrategien med arkitektløsningen."
            : "Last opp et primært løsningsdokument som arkitektløsning før du kjører sammenligningen."}
        </AnalysisTabEmptyState>
      )}
    </div>
  );
}
