"use client";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
    <div>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground">
            Kundeanalyse
          </h2>
          <p className="mt-1 max-w-xl text-sm text-foreground/60">
            Analyse av hvem kunden er, hva kunden prøver å oppnå, hvilke krav
            som er eksplisitte eller implisitte, og hvordan dere bør posisjonere
            dere.
          </p>
        </div>
        <Button onClick={onGenerate} disabled={busy} size="lg">
          {busy ? (
            <Spinner className="size-4" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          Generer kundeanalyse
        </Button>
      </div>

      {customerAnalysis ? (
        <div className="space-y-5">
          {/* Summary first */}
          <section className="rounded-lg border p-5 shadow-sm">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-foreground/50">
              Oppsummering
            </h3>
            <MarkdownViewer
              content={customerAnalysis.executive_summary}
              className="text-sm text-foreground"
            />
          </section>

          {/* Key sections in two columns */}
          <div className="grid gap-5 border-t pt-5 lg:grid-cols-2">
            <SectionList
              title="Kundeprofil"
              items={customerAnalysis.customer_profile}
            />
            <SectionList
              title="Kundens mål"
              items={customerAnalysis.customer_goals}
            />
            <SectionList
              title="Risiko og usikkerhet"
              items={customerAnalysis.risks}
            />
            <SectionList
              title="Anbefalt posisjonering"
              items={customerAnalysis.positioning_recommendations}
            />
          </div>

          {/* Collapsible detailed sections */}
          <div className="rounded-lg border shadow-sm">
            <Accordion>
              <AccordionItem value="explicit-requirements">
                <AccordionTrigger className="px-4">
                  Eksplisitte krav ({customerAnalysis.explicit_requirements.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <div className="space-y-3">
                    {customerAnalysis.explicit_requirements.map((req, index) => (
                      <div
                        key={`${req.title}-${index}`}
                        className="border-l-2 border-border pl-3"
                      >
                        <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                          <span>{req.category}</span>
                          <span>·</span>
                          <span>{req.importance}</span>
                          <span>·</span>
                          <span>{req.kind}</span>
                        </div>
                        <h4 className="text-sm font-medium text-foreground">
                          {req.title}
                        </h4>
                        <MarkdownViewer
                          content={req.description}
                          className="text-sm text-muted-foreground"
                        />
                        {req.source_reference || req.source_excerpt ? (
                          <p className="text-xs text-muted-foreground/70">
                            {req.source_reference || "Ingen referanse"} ·{" "}
                            {req.source_excerpt || ""}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="implicit-requirements">
                <AccordionTrigger className="px-4">
                  Implisitte krav ({customerAnalysis.implicit_requirements.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <div className="space-y-3">
                    {customerAnalysis.implicit_requirements.map((req, index) => (
                      <div
                        key={`${req.title}-${index}`}
                        className="border-l-2 border-border pl-3"
                      >
                        <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                          <span>{req.category}</span>
                          <span>·</span>
                          <span>{req.importance}</span>
                          <span>·</span>
                          <span>{req.kind}</span>
                        </div>
                        <h4 className="text-sm font-medium text-foreground">
                          {req.title}
                        </h4>
                        <MarkdownViewer
                          content={req.description}
                          className="text-sm text-muted-foreground"
                        />
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="evaluation-criteria">
                <AccordionTrigger className="px-4">
                  Evalueringskriterier ({customerAnalysis.likely_evaluation_criteria.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <ul className="space-y-1">
                    {customerAnalysis.likely_evaluation_criteria.map((item, index) => (
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

              <AccordionItem value="signal-words">
                <AccordionTrigger className="px-4">
                  Signalord og preferanser ({customerAnalysis.signal_words.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <ul className="space-y-1">
                    {customerAnalysis.signal_words.map((item, index) => (
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

              <AccordionItem value="value-opportunities">
                <AccordionTrigger className="px-4">
                  Verdimuligheter ({customerAnalysis.value_opportunities.length})
                </AccordionTrigger>
                <AccordionContent className="px-4">
                  <div className="space-y-3">
                    {customerAnalysis.value_opportunities.map((item, index) => (
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
                            values={item.value_categories.filter((v) =>
                              VALUE_LABELS.includes(v),
                            )}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </div>
      ) : (
        <AnalysisTabEmptyState>
          Ingen analyse ennå. Last opp et primært kundedokument og generer
          analysen.
        </AnalysisTabEmptyState>
      )}
    </div>
  );
}
