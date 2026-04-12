"use client";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import {
  AnalysisTabEmptyState,
  SectionList,
  VALUE_LABELS,
  ValueTags,
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
    <div>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground">
            Løsningsvurdering
          </h2>
          <p className="mt-1 max-w-xl text-sm text-foreground/60">
            Vurder hvordan løsningsdokumentet faktisk svarer på kundens behov,
            hvor det er sterkt, og hva som må forbedres.
          </p>
        </div>
        <Button onClick={onGenerate} disabled={busy} size="lg">
          {busy ? (
            <Spinner className="size-4" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          Generer løsningsvurdering
        </Button>
      </div>

      {busy && busyMessage ? (
        <div className="mb-4 flex items-center gap-2 text-sm text-primary">
          <Spinner className="size-3.5" />
          <span>{busyMessage}</span>
        </div>
      ) : null}

      {solutionEvaluation ? (
        <div className="space-y-5">
          {/* Executive summary */}
          <section className="rounded-lg border p-5 shadow-sm">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-foreground/50">
              Ledelsesoppsummering
            </h3>
            <MarkdownViewer
              content={solutionEvaluation.executive_summary}
              className="text-sm text-foreground"
            />
          </section>

          {/* Fit assessment */}
          <section className="border-t pt-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              Fit mot kundebehov
            </h3>
            <MarkdownViewer
              content={solutionEvaluation.fit_to_customer_needs}
              className="text-sm text-foreground"
            />
          </section>

          {/* Score grid */}
          <section className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-sm lg:grid-cols-4">
            {[
              {
                label: "Kvalitet",
                value: solutionEvaluation.likely_score_assessment.quality,
              },
              {
                label: "Gjennomføringsevne",
                value:
                  solutionEvaluation.likely_score_assessment
                    .delivery_confidence,
              },
              {
                label: "Risiko",
                value: solutionEvaluation.likely_score_assessment.risk,
              },
              {
                label: "Konkurransekraft",
                value:
                  solutionEvaluation.likely_score_assessment.competitiveness,
              },
            ].map((item, i) => (
              <div key={item.label} className="bg-background px-4 py-3">
                <p className="text-xs font-bold uppercase tracking-wider text-foreground/50">
                  {item.label}
                </p>
                <MarkdownViewer
                  content={item.value}
                  className="mt-0.5 text-sm text-foreground"
                />
              </div>
            ))}
          </section>

          {/* Strengths & weaknesses */}
          <div className="grid gap-5 border-t pt-5 lg:grid-cols-2">
            <SectionList title="Styrker" items={solutionEvaluation.strengths} />
            <SectionList
              title="Svakheter"
              items={solutionEvaluation.weaknesses}
            />
          </div>

          {/* Collapsible detailed sections */}
          <div className="rounded-lg border shadow-sm">
            <Accordion>
              <AccordionItem value="generic-sections">
                <AccordionTrigger className="px-4">
                  Generiske partier (
                  {solutionEvaluation.generic_sections.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <ul className="space-y-1.5">
                    {solutionEvaluation.generic_sections.map((item, index) => (
                      <li
                        key={index}
                        className="border-l-2 border-border pl-3 text-sm text-foreground"
                      >
                        <MarkdownViewer content={item} />
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="missing-elements">
                <AccordionTrigger className="px-4">
                  Manglende elementer (
                  {solutionEvaluation.missing_elements.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <ul className="space-y-1.5">
                    {solutionEvaluation.missing_elements.map((item, index) => (
                      <li
                        key={index}
                        className="border-l-2 border-border pl-3 text-sm text-foreground"
                      >
                        <MarkdownViewer content={item} />
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="risks">
                <AccordionTrigger className="px-4">
                  Risiko for kunden (
                  {solutionEvaluation.risks_to_customer.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <ul className="space-y-1.5">
                    {solutionEvaluation.risks_to_customer.map((item, index) => (
                      <li
                        key={index}
                        className="border-l-2 border-border pl-3 text-sm text-foreground"
                      >
                        <MarkdownViewer content={item} />
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="trust-signals">
                <AccordionTrigger className="px-4">
                  Tillitssignaler ({solutionEvaluation.trust_signals.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <ul className="space-y-1.5">
                    {solutionEvaluation.trust_signals.map((item, index) => (
                      <li
                        key={index}
                        className="border-l-2 border-border pl-3 text-sm text-foreground"
                      >
                        <MarkdownViewer content={item} />
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="improvements">
                <AccordionTrigger className="px-4">
                  Forbedringsforslag (
                  {solutionEvaluation.improvement_recommendations.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <ul className="space-y-1.5">
                    {solutionEvaluation.improvement_recommendations.map(
                      (item, index) => (
                        <li
                          key={index}
                          className="border-l-2 border-border pl-3 text-sm text-foreground"
                        >
                          <MarkdownViewer content={item} />
                        </li>
                      ),
                    )}
                  </ul>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="value-assessment">
                <AccordionTrigger className="px-4">
                  Verdivurdering ({solutionEvaluation.value_assessment.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <div className="space-y-3">
                    {solutionEvaluation.value_assessment.map((item, index) => (
                      <div
                        key={`${item.title}-${index}`}
                        className="border-l-2 border-border pl-3"
                      >
                        <h4 className="text-sm font-medium text-foreground">
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

              <AccordionItem value="rewrite-suggestions">
                <AccordionTrigger className="px-4">
                  Omskrivingsforslag (
                  {solutionEvaluation.rewrite_suggestions.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <div className="space-y-3">
                    {solutionEvaluation.rewrite_suggestions.map(
                      (suggestion, index) => (
                        <div
                          key={`${suggestion.target}-${index}`}
                          className="border-l-2 border-border pl-3"
                        >
                          <p className="text-xs font-medium text-muted-foreground">
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
          </div>
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
