"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { MermaidDiagram } from "@/components/projects/mermaid-diagram";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import {
  AnalysisTabEmptyState,
  VALUE_LABELS,
  ValueTags,
} from "@/components/projects/project-workspace-shared";
import type { CustomerAnalysisResult } from "@/lib/types";

function DisclosureSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground">
        <span>
          {title}
          {typeof count === "number" ? ` (${count})` : ""}
        </span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}

function getDisplayProfitShares(
  opportunities: CustomerAnalysisResult["value_opportunities"],
) {
  if (!opportunities.length) {
    return [];
  }

  const rawValues = opportunities.map((item) =>
    typeof item.profit_share_percent === "number" &&
    Number.isFinite(item.profit_share_percent)
      ? Math.max(1, Math.round(item.profit_share_percent))
      : 0,
  );

  const total = rawValues.reduce((sum, value) => sum + value, 0);
  const normalized =
    total > 0
      ? rawValues.map((value) => Math.max(1, Math.round((value / total) * 100)))
      : opportunities.map(() => Math.floor(100 / opportunities.length));

  let currentTotal = normalized.reduce((sum, value) => sum + value, 0);
  let index = 0;
  while (currentTotal !== 100 && normalized.length > 0) {
    const direction = currentTotal < 100 ? 1 : -1;
    const targetIndex = index % normalized.length;
    if (direction > 0 || normalized[targetIndex] > 1) {
      normalized[targetIndex] += direction;
      currentTotal += direction;
    }
    index += 1;
  }

  return normalized;
}

export function ProjectAnalysisTab({
  customerAnalysis,
  busy,
  saveBusy,
  highLevelBusy,
  busyMessage,
  onGenerate,
  onGenerateHighLevel,
  onSaveAnalysis,
}: {
  customerAnalysis: CustomerAnalysisResult | null;
  busy: boolean;
  saveBusy: boolean;
  highLevelBusy: boolean;
  busyMessage: string;
  onGenerate: () => void;
  onGenerateHighLevel: () => void;
  onSaveAnalysis: (value: string) => Promise<void>;
}) {
  const [analysisDraft, setAnalysisDraft] = useState("");
  const [isEditingAnalysis, setIsEditingAnalysis] = useState(false);

  useEffect(() => {
    setAnalysisDraft(customerAnalysis?.executive_summary ?? "");
  }, [customerAnalysis?.executive_summary]);

  const customerSummary = customerAnalysis
    ? [
        customerAnalysis.customer_profile_summary || "",
        customerAnalysis.customer_goals_summary || "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const profitShares = customerAnalysis
    ? getDisplayProfitShares(customerAnalysis.value_opportunities)
    : [];

  async function onAnalysisAction() {
    if (!isEditingAnalysis) {
      setIsEditingAnalysis(true);
      return;
    }
    await onSaveAnalysis(analysisDraft);
    setIsEditingAnalysis(false);
  }

  function onCancelAnalysisEdit() {
    setAnalysisDraft(customerAnalysis?.executive_summary ?? "");
    setIsEditingAnalysis(false);
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground">
            Kundeanalyse
          </h2>
          <p className="mt-1 max-w-xl text-sm text-foreground/60">
            Analyse av kunden, implisitte krav, risiko, posisjonering og
            anbefalt overordnet løsningsdesign.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={onGenerateHighLevel}
            disabled={highLevelBusy || !customerAnalysis}
            variant="outline"
            size="lg"
          >
            {highLevelBusy ? (
              <Spinner className="size-4" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            Generer løsningsdesign
          </Button>
          <Button onClick={onGenerate} disabled={busy} size="lg">
            {busy ? (
              <Spinner className="size-4" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            Generer kundeanalyse
          </Button>
        </div>
      </div>

      {highLevelBusy && busyMessage ? (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
          <Spinner className="size-3.5" />
          <span>{busyMessage}</span>
        </div>
      ) : null}

      {customerAnalysis ? (
        <div className="space-y-5">
          <section className="analysis-card p-6 md:p-7">
            <div className="mb-4">
              <h3 className="analysis-card-eyebrow text-xs font-bold uppercase">
                Oppsummering av kunden
              </h3>
              <p className="mt-2 max-w-2xl text-sm text-foreground/60">
                En kondensert leseflate som samler kundens situasjon, mål og
                retning i ett sammenhengende sammendrag.
              </p>
            </div>
            <div className="rounded-2xl border border-border/80 bg-white/80 px-6 py-6 shadow-sm md:px-8 md:py-7">
              <MarkdownViewer
                content={customerSummary}
                className="artifact-markdown text-foreground"
              />
            </div>
          </section>

          <section className="analysis-card p-6 md:p-7">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="analysis-card-eyebrow text-xs font-bold uppercase">
                  Analyse
                </h3>
                <p className="mt-2 max-w-2xl text-sm text-foreground/60">
                  Dette er den operative arbeidsteksten for prosjektet. Den kan
                  justeres manuelt og brukes videre som kunnskapsgrunnlag i
                  løsningsutkastet.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isEditingAnalysis ? (
                  <Button
                    onClick={onCancelAnalysisEdit}
                    disabled={saveBusy}
                    variant="ghost"
                    size="sm"
                  >
                    Avbryt
                  </Button>
                ) : null}
                <Button
                  onClick={onAnalysisAction}
                  disabled={saveBusy || (isEditingAnalysis && !analysisDraft.trim())}
                  variant="outline"
                  size="sm"
                >
                  {saveBusy ? <Spinner className="size-4" /> : null}
                  {isEditingAnalysis ? "Lagre" : "Endre"}
                </Button>
              </div>
            </div>
            {isEditingAnalysis ? (
              <div className="rounded-2xl border border-border/80 bg-white/80 px-4 py-4 shadow-sm md:px-6 md:py-5">
                <Textarea
                  value={analysisDraft}
                  onChange={(event) => setAnalysisDraft(event.target.value)}
                  className="min-h-60 resize-y border-0 bg-transparent px-0 text-[1.04rem] leading-8 text-foreground shadow-none focus-visible:ring-0"
                />
              </div>
            ) : (
              <div className="rounded-2xl border border-border/80 bg-white/80 px-6 py-6 shadow-sm md:px-8 md:py-7">
                <MarkdownViewer
                  content={analysisDraft}
                  className="artifact-markdown text-foreground"
                />
              </div>
            )}
          </section>

          <section className="analysis-card p-6 md:p-7">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <h3 className="analysis-card-eyebrow text-xs font-bold uppercase">
                High-level design av løsningen
              </h3>
              <Button
                onClick={onGenerateHighLevel}
                disabled={highLevelBusy}
                variant="outline"
                size="sm"
              >
                {highLevelBusy ? (
                  <Spinner className="size-4" />
                ) : (
                  <RefreshCw data-icon="inline-start" />
                )}
                Generer løsningsdesign
              </Button>
            </div>
            <MermaidDiagram
              chart={customerAnalysis.high_level_architecture_mermaid}
              title="Diagrammet viser anbefalt overordnet arkitektur basert på kundeanalysen."
              downloadName="high-level-architecture"
            />
          </section>

          <div className="rounded-lg border shadow-sm">
            <DisclosureSection
              title="Risiko og usikkerhet"
              count={customerAnalysis.risks.length}
            >
                  <ul className="space-y-2">
                    {customerAnalysis.risks.map((item, index) => (
                      <li
                        key={`risk-${index}`}
                        className="border-l-2 border-border pl-3 text-foreground"
                      >
                        <MarkdownViewer
                          content={item}
                          className="analysis-prose text-[0.98rem]"
                        />
                      </li>
                    ))}
                  </ul>
            </DisclosureSection>

            <DisclosureSection
              title="Anbefalt posisjonering"
              count={customerAnalysis.positioning_recommendations.length}
            >
                  <ul className="space-y-2">
                    {customerAnalysis.positioning_recommendations.map((item, index) => (
                      <li
                        key={`positioning-${index}`}
                        className="border-l-2 border-border pl-3 text-foreground"
                      >
                        <MarkdownViewer
                          content={item}
                          className="analysis-prose text-[0.98rem]"
                        />
                      </li>
                    ))}
                  </ul>
            </DisclosureSection>

            <DisclosureSection
              title="Implisitte krav"
              count={customerAnalysis.implicit_requirements.length}
            >
                  <div className="space-y-3">
                    {customerAnalysis.implicit_requirements.map((req, index) => (
                      <div
                        key={`implicit-${req.title}-${index}`}
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
                          className="analysis-prose text-[0.98rem] text-muted-foreground"
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
            </DisclosureSection>

            <DisclosureSection
              title="Teknologier, standarder og nøkkelord"
              count={customerAnalysis.signal_words.length}
            >
                  <ul className="space-y-1">
                    {customerAnalysis.signal_words.map((item, index) => (
                      <li
                        key={index}
                        className="border-l-2 border-border pl-3 text-sm text-foreground"
                      >
                        <MarkdownViewer
                          content={item}
                          className="analysis-prose text-[0.98rem]"
                        />
                      </li>
                    ))}
                  </ul>
            </DisclosureSection>

            <DisclosureSection
              title="Verdimuligheter"
              count={customerAnalysis.value_opportunities.length}
            >
                  <div className="space-y-3">
                    {customerAnalysis.value_opportunities.map((item, index) => (
                      <div
                        key={`${item.title}-${index}`}
                        className="border-l-2 border-border pl-3"
                      >
                        <h4 className="flex flex-wrap items-center gap-y-1 text-sm font-medium text-foreground">
                          <span>{item.title}</span>
                          <span className="ml-2 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                            {profitShares[index] ?? 0}% av profitteffekt
                          </span>
                        </h4>
                        <MarkdownViewer
                          content={item.description}
                          className="analysis-prose text-[0.98rem] text-muted-foreground"
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
            </DisclosureSection>
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
