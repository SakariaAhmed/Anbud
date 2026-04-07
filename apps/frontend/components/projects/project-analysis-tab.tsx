"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  AlertTriangle,
  Building2,
  ChevronDown,
  Compass,
  Cpu,
  FilePenLine,
  ListChecks,
  RefreshCw,
  Target,
  TrendingUp,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
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
  description,
  count,
  icon: Icon,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  count?: number;
  icon: ComponentType<{ className?: string }>;
  badge?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="list-none">
        <Item
          variant="outline"
          className="cursor-pointer rounded-[28px] border-border/80 bg-white/80 px-6 py-5 shadow-sm transition-all hover:bg-white"
        >
          <ItemMedia className="flex size-12 items-center justify-center rounded-2xl border border-primary/10 bg-primary/6 text-primary">
            <Icon className="size-5" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full text-[1.05rem] font-semibold text-foreground">
              {title}
              {typeof count === "number" ? ` (${count})` : ""}
            </ItemTitle>
            <ItemDescription className="mt-1 line-clamp-none text-sm leading-6 text-muted-foreground">
              {description}
            </ItemDescription>
          </ItemContent>
          <ItemActions className="ml-auto self-center">
            {badge ? (
              <div className="rounded-full border border-primary/15 bg-primary/6 px-3 py-1 text-xs font-semibold text-primary">
                {badge}
              </div>
            ) : null}
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </ItemActions>
        </Item>
      </summary>
      <div className="px-4 pb-2 pt-3 md:px-6">{children}</div>
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
  const summaryPanels = customerAnalysis
    ? [
        {
          key: "profile",
          title: "Kundesituasjon",
          description:
            "Hva slags virksomhet dette er, hva som preger dagens plattform og hvorfor kompleksiteten betyr noe.",
          icon: Building2,
          content: customerAnalysis.customer_profile_summary || "",
        },
        {
          key: "goals",
          title: "Mål og retning",
          description:
            "Hva kunden prøver å oppnå, og hvilken moderniseringsretning tilbudet bør svare på.",
          icon: Compass,
          content: customerAnalysis.customer_goals_summary || "",
        },
      ].filter((item) => item.content.trim().length > 0)
    : [];
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
        <ItemGroup className="gap-5">
          <DisclosureSection
            title="Oppsummering av kunden"
            description="En rask lederlesning som deler kundens nåsituasjon og ønsket retning i to tydelige spor."
            icon={Building2}
            badge="Executive summary"
            defaultOpen
          >
            <div className="rounded-[28px] border border-border/80 bg-white/80 p-5 shadow-sm md:p-6">
              {summaryPanels.length > 0 ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {summaryPanels.map((panel) => {
                    const Icon = panel.icon;
                    return (
                      <div
                        key={panel.key}
                        className="rounded-2xl border border-border/80 bg-white/80 px-6 py-5 shadow-sm"
                      >
                        <div className="mb-4 flex items-start gap-3">
                          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/8 text-primary">
                            <Icon className="size-5" />
                          </div>
                          <div>
                            <h4 className="text-base font-semibold text-foreground">
                              {panel.title}
                            </h4>
                            <p className="mt-1 text-sm leading-6 text-muted-foreground">
                              {panel.description}
                            </p>
                          </div>
                        </div>
                        <MarkdownViewer
                          content={panel.content}
                          className="analysis-prose max-w-none text-[1rem] text-foreground"
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl border border-border/80 bg-white/80 px-6 py-6 shadow-sm md:px-8 md:py-7">
                  <MarkdownViewer
                    content={customerSummary}
                    className="artifact-markdown text-foreground"
                  />
                </div>
              )}
            </div>
          </DisclosureSection>

          <DisclosureSection
            title="Analyse"
            description="Den operative arbeidsteksten for prosjektet, klar for manuell finpuss og videre bruk i løsningsutkastet."
            icon={FilePenLine}
            badge="Arbeidsgrunnlag"
            defaultOpen
          >
            <div className="rounded-[28px] border border-border/80 bg-white/80 p-5 shadow-sm md:p-6">
              <div className="rounded-2xl border border-border/80 bg-white/80 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-5 py-4 md:px-6">
                  <div className="flex items-start gap-3">
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/8 text-primary">
                      <FilePenLine className="size-5" />
                    </div>
                    <div>
                      <h4 className="text-base font-semibold text-foreground">
                        Analyseutkast
                      </h4>
                      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                        Juster teksten direkte her når du vil spisse budskap,
                        risiko og posisjonering før neste steg.
                      </p>
                    </div>
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
                  <div className="px-4 py-4 md:px-6 md:py-5">
                    <Textarea
                      value={analysisDraft}
                      onChange={(event) => setAnalysisDraft(event.target.value)}
                      className="min-h-60 resize-y border-0 bg-transparent px-0 text-[1.04rem] leading-8 text-foreground shadow-none focus-visible:ring-0"
                    />
                  </div>
                ) : (
                  <div className="px-6 py-6 md:px-8 md:py-7">
                    <MarkdownViewer
                      content={analysisDraft}
                      className="artifact-markdown text-foreground"
                    />
                  </div>
                )}
              </div>
            </div>
          </DisclosureSection>

          <DisclosureSection
            title="High-level design av løsningen"
            description="Åpne seksjonen for å se eller regenerere anbefalt overordnet arkitektur."
            icon={Compass}
            defaultOpen
          >
            <div className="rounded-[28px] border border-border/80 bg-white/80 p-5 shadow-sm md:p-6">
              <div className="mb-4 flex justify-end">
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
            </div>
          </DisclosureSection>

            <DisclosureSection
              title="Risiko og usikkerhet"
              description="De viktigste usikkerhetene, konsekvensene og hvor tilbudet må bygge ekstra trygghet."
              count={customerAnalysis.risks.length}
              icon={AlertTriangle}
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
              description="Konkret retning for hvordan tilbudet bør spisses for å være mer relevant og vinnende."
              count={customerAnalysis.positioning_recommendations.length}
              icon={Target}
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
              description="Skjulte forventninger og krav som ikke alltid er sagt direkte, men som tilbudet må svare på."
              count={customerAnalysis.implicit_requirements.length}
              icon={ListChecks}
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
              description="Signalord og tekniske føringer som bør gjenspeiles i språk, løsning og arkitektur."
              count={customerAnalysis.signal_words.length}
              icon={Cpu}
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
              description="Hvor løsningen kan skape tydelig effekt for kunden i form av gevinst, risiko eller opplevelse."
              count={customerAnalysis.value_opportunities.length}
              icon={TrendingUp}
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
        </ItemGroup>
      ) : (
        <AnalysisTabEmptyState>
          Ingen analyse ennå. Last opp et primært kundedokument og generer
          analysen.
        </AnalysisTabEmptyState>
      )}
    </div>
  );
}
