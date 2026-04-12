"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  Cloud,
  Compass,
  Cpu,
  Database,
  FilePenLine,
  KeyRound,
  ListChecks,
  RefreshCw,
  Shield,
  Target,
  TrendingUp,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import {
  AnalysisTabEmptyState,
  VALUE_LABELS,
  ValueTags,
} from "@/components/projects/project-workspace-shared";
import type {
  CustomerAnalysisResult,
  CustomerAnalysisSection,
} from "@/lib/types";

function SectionSurface({
  title,
  description,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-white/85 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 px-5 py-4 md:px-6">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
            <Icon className="size-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        {action ? (
          <div className="flex items-center gap-2">{action}</div>
        ) : null}
      </div>
      <div className="px-5 py-5 md:px-6 md:py-6">{children}</div>
    </section>
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

function splitLeadSentence(content: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    return { lead: "", body: "" };
  }

  const normalized = trimmed.replace(/\n+/g, " ").trim();
  const match = normalized.match(/^(.{20,180}?[.!?])(\s+|$)([\s\S]*)$/);

  if (!match) {
    return { lead: normalized, body: "" };
  }

  return {
    lead: (match[1] ?? "").trim(),
    body: (match[3] ?? "").trim(),
  };
}

const SECTION_TABS = [
  { value: "summary", label: "Oppsummering" },
  { value: "strategy", label: "Strategi" },
  { value: "design", label: "Design" },
  { value: "risks", label: "Risiko" },
  { value: "needs", label: "Behov" },
  { value: "keywords", label: "Nøkkelord" },
  { value: "value", label: "Verdi" },
] as const;

function getKeywordIcon(keyword: string): LucideIcon {
  const value = keyword.toLowerCase();

  if (
    value.includes("azure") ||
    value.includes("cloud") ||
    value.includes("sky")
  ) {
    return Cloud;
  }

  if (
    value.includes("entra") ||
    value.includes("id") ||
    value.includes("auth") ||
    value.includes("ident")
  ) {
    return KeyRound;
  }

  if (
    value.includes("data") ||
    value.includes("database") ||
    value.includes("sql")
  ) {
    return Database;
  }

  if (
    value.includes("security") ||
    value.includes("sikker") ||
    value.includes("zero trust") ||
    value.includes("compliance")
  ) {
    return Shield;
  }

  if (
    value.includes("api") ||
    value.includes("integr") ||
    value.includes("workflow") ||
    value.includes("prosess")
  ) {
    return Workflow;
  }

  return Cpu;
}

function getKeywordMentionCount(
  analysis: CustomerAnalysisResult,
  keyword: string,
) {
  const count = analysis.signal_word_counts?.[keyword];
  return typeof count === "number" && Number.isFinite(count)
    ? Math.max(1, Math.round(count))
    : 1;
}

function getTopSignalWords(analysis: CustomerAnalysisResult) {
  return analysis.signal_words
    .map((keyword, index) => ({ keyword, index }))
    .sort((left, right) => {
      const countDiff =
        getKeywordMentionCount(analysis, right.keyword) -
        getKeywordMentionCount(analysis, left.keyword);
      return countDiff || left.index - right.index;
    })
    .slice(0, 5)
    .map((item) => item.keyword);
}

function getRiskGroups(analysis: CustomerAnalysisResult) {
  const risksForUs = analysis.risks_for_us ?? [];
  const risksForCustomer = analysis.risks_for_customer ?? [];

  if (risksForUs.length || risksForCustomer.length) {
    return { risksForUs, risksForCustomer };
  }

  return analysis.risks.reduce(
    (groups, risk) => {
      if (
        /tilbud|leverandør|leveranse|team|ressurs|kompetanse|kapasitet|scope|omfang|pris|margin|kontrakt|avklaring|posisjonering|forplikt|ansvar/i.test(
          risk,
        )
      ) {
        groups.risksForUs.push(risk);
      } else {
        groups.risksForCustomer.push(risk);
      }
      return groups;
    },
    { risksForUs: [] as string[], risksForCustomer: [] as string[] },
  );
}

function RiskAudienceGroup({
  title,
  description,
  items,
  emptyText,
}: {
  title: string;
  description: string;
  items: string[];
  emptyText: string;
}) {
  return (
    <div className="rounded-xl border border-border/65 bg-background/55 px-5 py-5">
      <div className="mb-4">
        <h4 className="text-[1.05rem] font-semibold tracking-[-0.02em] text-foreground">
          {title}
        </h4>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {items.length ? (
        <div className="space-y-4">
          {items.map((item, index) => {
            const riskText = splitLeadSentence(item);

            return (
              <div
                key={`${title}-${index}`}
                className="border-t border-border/60 pt-4 first:border-t-0 first:pt-0"
              >
                <div className="mb-2 flex items-center gap-3">
                  <span className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-primary/70">
                    Risiko {index + 1}
                  </span>
                  <span className="h-px flex-1 bg-border/70" />
                </div>
                <p className="text-[1.08rem] font-semibold tracking-[-0.02em] text-foreground">
                  {riskText.lead}
                </p>
                {riskText.body ? (
                  <MarkdownViewer
                    content={riskText.body}
                    className="analysis-prose mt-2 max-w-none text-[1.01rem] leading-[1.85] text-muted-foreground"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border/70 bg-background/70 px-4 py-4 text-sm text-muted-foreground">
          {emptyText}
        </p>
      )}
    </div>
  );
}

function getRequirementImportanceRank(
  requirement: CustomerAnalysisResult["implicit_requirements"][number],
) {
  if (requirement.importance === "Kritisk") return 0;
  if (requirement.importance === "Viktig") return 1;
  return 2;
}

function getTopImplicitRequirements(
  requirements: CustomerAnalysisResult["implicit_requirements"],
) {
  return requirements
    .map((requirement, index) => ({ requirement, index }))
    .sort((left, right) => {
      const rankDiff =
        getRequirementImportanceRank(left.requirement) -
        getRequirementImportanceRank(right.requirement);
      return rankDiff || left.index - right.index;
    })
    .slice(0, 3)
    .map((item) => item.requirement);
}

function inferNeedAntiPositioning(
  requirement: CustomerAnalysisResult["implicit_requirements"][number],
) {
  const text =
    `${requirement.title} ${requirement.category} ${requirement.description}`.toLowerCase();

  if (/logistikk|drift|avbrudd|nedetid|kritisk|stabil/.test(text)) {
    return "Ikke posisjonér dette som en generell skyreise. Kunden kjøper kontroll, stabilitet og risikoreduksjon like mye som teknologi.";
  }

  if (/sikker|tilgang|identitet|compliance|etterlevelse|styring/.test(text)) {
    return "Ikke posisjonér dette som funksjonalitet alene. Kunden trenger sporbar styring, tydelige kontroller og lav etterlevelsesrisiko.";
  }

  if (/migrer|overgang|fase|implement|gjennomføring/.test(text)) {
    return "Ikke posisjonér dette som rask flytting. Kunden trenger en kontrollert overgang med beslutningspunkter, ansvar og trygg drift underveis.";
  }

  if (/integrasjon|api|data|database|system|erp|wms|crm/.test(text)) {
    return "Ikke posisjonér dette som isolerte systemendringer. Kunden trenger eierskap til avhengigheter, integrasjoner og operasjonell helhet.";
  }

  if (/kost|økonomi|budsjett|finans|lisens|forbruk/.test(text)) {
    return "Ikke posisjonér dette som maksimal modernisering. Kunden trenger styrbar kostnad, tydelige prioriteringer og dokumentert effekt.";
  }

  if (/bruker|adopsjon|opplevelse|arbeidsflyt|prosess/.test(text)) {
    return "Ikke posisjonér dette som plattform for plattformens skyld. Kunden trenger merkbar operasjonell nytte for brukere og prosesser.";
  }

  return "Ikke posisjonér dette som en generisk standardleveranse. Vis konkret hvordan behovet styrer løsning, gjennomføring og tilbudsbudskap.";
}

function getNeedAsk(
  requirement: CustomerAnalysisResult["implicit_requirements"][number],
) {
  const lead = splitLeadSentence(requirement.description).lead;
  return lead || requirement.description || requirement.title;
}

export function ProjectAnalysisTab({
  customerAnalysis,
  busy,
  saveBusy,
  sectionBusy,
  busyMessage,
  onGenerate,
  onRegenerateSection,
  onSaveAnalysis,
}: {
  customerAnalysis: CustomerAnalysisResult | null;
  busy: boolean;
  saveBusy: boolean;
  sectionBusy: CustomerAnalysisSection | null;
  busyMessage: string;
  onGenerate: () => void;
  onRegenerateSection: (section: CustomerAnalysisSection) => void;
  onSaveAnalysis: (value: string) => Promise<void>;
}) {
  const [analysisDraft, setAnalysisDraft] = useState("");
  const [isEditingAnalysis, setIsEditingAnalysis] = useState(false);
  const [activeSection, setActiveSection] =
    useState<(typeof SECTION_TABS)[number]["value"]>("summary");

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
          title: "Kundens mål og retning",
          description:
            "Hva kunden prøver å oppnå, hvilken utviklingsretning virksomheten peker mot, og hvordan dette kan brukes til å forme en mer rettet løsning.",
          icon: Compass,
          content: customerAnalysis.customer_goals_summary || "",
        },
      ].filter((item) => item.content.trim().length > 0)
    : [];
  const profitShares = customerAnalysis
    ? getDisplayProfitShares(customerAnalysis.value_opportunities)
    : [];
  const riskGroups = customerAnalysis ? getRiskGroups(customerAnalysis) : null;
  const topImplicitRequirements = customerAnalysis
    ? getTopImplicitRequirements(customerAnalysis.implicit_requirements)
    : [];
  const topSignalWords = customerAnalysis
    ? getTopSignalWords(customerAnalysis)
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

  function renderRegenerateButton(
    section: CustomerAnalysisSection,
    label = "Regenerer seksjon",
  ) {
    const isSectionBusy = sectionBusy === section;

    return (
      <Button
        onClick={() => onRegenerateSection(section)}
        disabled={busy || saveBusy || Boolean(sectionBusy)}
        variant="outline"
        size="sm"
      >
        {isSectionBusy ? (
          <Spinner className="size-4" />
        ) : (
          <RefreshCw data-icon="inline-start" />
        )}
        {label}
      </Button>
    );
  }

  return (
    <div>
      {sectionBusy && busyMessage ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
          <Spinner className="size-3.5" />
          <span>{busyMessage}</span>
        </div>
      ) : null}

      {customerAnalysis ? (
        <Tabs
          value={activeSection}
          onValueChange={(value) =>
            setActiveSection(value as (typeof SECTION_TABS)[number]["value"])
          }
          defaultValue="summary"
          className="gap-4"
        >
          <div className="sticky top-14 z-20 -mx-5 overflow-y-hidden border-b border-border/70 bg-background/95 px-5 pt-0 pb-0.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:-mx-8 md:px-8">
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0 flex-1 overflow-hidden">
                <div className="no-scrollbar overflow-x-auto overflow-y-hidden touch-pan-x">
                  <TabsList
                    variant="line"
                    className="h-auto min-w-max rounded-none p-0"
                  >
                    {SECTION_TABS.map((tab) => (
                      <TabsTrigger
                        key={tab.value}
                        value={tab.value}
                        className="h-11 flex-none rounded-none px-5 text-base font-medium tracking-[-0.01em] text-foreground/55 after:bottom-[-1px] after:h-[3px] after:rounded-full after:bg-primary data-active:bg-transparent data-active:text-primary"
                      >
                        {tab.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              </div>
              <Button
                onClick={onGenerate}
                disabled={busy || Boolean(sectionBusy)}
                className="mb-2 shrink-0"
              >
                {busy ? (
                  <Spinner className="size-4" />
                ) : (
                  <RefreshCw data-icon="inline-start" />
                )}
                Generer kundeanalyse
              </Button>
            </div>
          </div>

          <TabsContent value="summary" className="mt-0">
            <SectionSurface
              title="Oppsummering av kunden"
              description="En rask lederlesning som deler kundens nåsituasjon og ønsket retning i to tydelige spor."
              icon={Building2}
              action={renderRegenerateButton("summary")}
            >
              {summaryPanels.length > 0 ? (
                <div className="space-y-4">
                  {summaryPanels.map((panel) => {
                    const Icon = panel.icon;
                    return (
                      <div
                        key={panel.key}
                        className="rounded-lg border border-border/70 bg-background/75 px-5 py-5"
                      >
                        <div className="mb-4 flex items-start gap-3">
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
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
                <MarkdownViewer
                  content={customerSummary}
                  className="artifact-markdown text-foreground"
                />
              )}
            </SectionSurface>
          </TabsContent>

          <TabsContent value="strategy" className="mt-0">
            <SectionSurface
              title="Strategi og posisjonering"
              description="Den operative arbeidsteksten og anbefalt posisjonering samlet i én flate for videre finpuss og bruk i løsningsutkastet."
              icon={FilePenLine}
              action={
                <>
                  {renderRegenerateButton("strategy")}
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
                    disabled={
                      saveBusy || (isEditingAnalysis && !analysisDraft.trim())
                    }
                    variant="outline"
                    size="sm"
                  >
                    {saveBusy ? <Spinner className="size-4" /> : null}
                    {isEditingAnalysis ? "Lagre" : "Endre"}
                  </Button>
                </>
              }
            >
              <div className="space-y-6">
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-primary/8 text-primary">
                      <FilePenLine className="size-4" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-foreground">
                        Strategi
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        Arbeidsteksten som brukes videre i tilbudet.
                      </p>
                    </div>
                  </div>
                  {isEditingAnalysis ? (
                    <Textarea
                      value={analysisDraft}
                      onChange={(event) => setAnalysisDraft(event.target.value)}
                      className="min-h-72 resize-y rounded-lg border-border/70 bg-background/60 px-4 py-4 text-[1.02rem] leading-8 text-foreground shadow-none"
                    />
                  ) : (
                    <div className="rounded-lg bg-background/40 px-1">
                      <MarkdownViewer
                        content={analysisDraft}
                        className="artifact-markdown text-foreground"
                      />
                    </div>
                  )}
                </div>

                {customerAnalysis.positioning_recommendations.length ? (
                  <div className="border-t border-border/70 pt-6">
                    <div className="mb-4 flex items-center gap-2">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-primary/8 text-primary">
                        <Target className="size-4" />
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-foreground">
                          Anbefalt posisjonering
                        </h4>
                        <p className="text-sm text-muted-foreground">
                          Konkret retning for hvordan tilbudet bør spisses for å
                          være mer relevant og vinnende.
                        </p>
                      </div>
                    </div>
                    <div className="space-y-4">
                      {customerAnalysis.positioning_recommendations.map(
                        (item, index) => (
                          <div
                            key={`positioning-${index}`}
                            className="rounded-xl border border-border/65 bg-background/55 px-5 py-5"
                          >
                            <div className="mb-3 flex items-center gap-3">
                              <span className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-primary/70">
                                Posisjon {index + 1}
                              </span>
                              <span className="h-px flex-1 bg-border/70" />
                            </div>

                            <MarkdownViewer
                              content={item}
                              className="analysis-prose max-w-none text-[1.06rem] leading-[1.9] text-foreground/88"
                            />
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </SectionSurface>
          </TabsContent>

          <TabsContent value="design" className="mt-0">
            <SectionSurface
              title="High-level design av løsningen"
              description="Vis eller regenerer anbefalt overordnet arkitektur når denne delen er klar."
              icon={Compass}
              action={renderRegenerateButton("design", "Regenerer design")}
            >
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-6 py-12 text-center">
                <p className="text-lg font-semibold text-foreground">
                  Coming soon
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  High-level design-visningen kommer i en senere iterasjon.
                </p>
              </div>
            </SectionSurface>
          </TabsContent>

          <TabsContent value="risks" className="mt-0">
            <SectionSurface
              title={`Risiko og usikkerhet (${riskGroups ? riskGroups.risksForUs.length + riskGroups.risksForCustomer.length : customerAnalysis.risks.length})`}
              description="Risikobildet er delt mellom hva som kan treffe tilbudsteamet og hva som kan treffe kunden."
              icon={AlertTriangle}
              action={renderRegenerateButton("risks")}
            >
              <div className="grid gap-4 xl:grid-cols-2">
                <RiskAudienceGroup
                  title="Risiko for oss"
                  description="Hva som kan påvirke leveranse, tilbud, kommersiell presisjon eller teamets evne til å vinne og gjennomføre."
                  items={riskGroups?.risksForUs ?? []}
                  emptyText="Ingen tydelig leverandør-/tilbudsrisiko er identifisert i eksisterende analyse."
                />
                <RiskAudienceGroup
                  title="Risiko for kunden"
                  description="Hva som kan påvirke kundens drift, sikkerhet, overgang, kostnader, brukeradopsjon eller forvaltning."
                  items={riskGroups?.risksForCustomer ?? []}
                  emptyText="Ingen tydelig kunderisiko er identifisert i eksisterende analyse."
                />
              </div>
            </SectionSurface>
          </TabsContent>

          <TabsContent value="needs" className="mt-0">
            <SectionSurface
              title={`Underliggende behov (${topImplicitRequirements.length} viktigste)`}
              description="De viktigste implisitte signalene, formulert som hva kunden egentlig ber om og hva tilbudet ikke bør selges som."
              icon={ListChecks}
              action={renderRegenerateButton("needs")}
            >
              {topImplicitRequirements.length ? (
                <div className="space-y-4">
                  {topImplicitRequirements.map((req, index) => (
                    <div
                      key={`implicit-${req.title}-${index}`}
                      className="overflow-hidden rounded-xl border border-border/65 bg-background/55"
                    >
                      <div className="border-b border-border/60 px-5 py-4">
                        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span>Behov {index + 1}</span>
                          <span>·</span>
                          <span>{req.category}</span>
                          <span>·</span>
                          <span>{req.importance}</span>
                        </div>
                        <h4 className="text-[1.14rem] font-semibold tracking-[-0.02em] text-foreground">
                          {req.title}
                        </h4>
                      </div>

                      <div className="grid gap-0 md:grid-cols-2">
                        <div className="border-b border-border/60 px-5 py-5 md:border-r md:border-b-0">
                          <p className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-primary/70">
                            Kunden spør egentlig om
                          </p>
                          <MarkdownViewer
                            content={getNeedAsk(req)}
                            className="analysis-prose max-w-none text-[1.03rem] font-medium leading-8 text-foreground"
                          />
                        </div>
                        <div className="bg-muted/20 px-5 py-5">
                          <p className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                            Ikke posisjonér som
                          </p>
                          <MarkdownViewer
                            content={inferNeedAntiPositioning(req)}
                            className="analysis-prose max-w-none text-[1.03rem] leading-8 text-foreground/80"
                          />
                        </div>
                      </div>

                      <details className="group border-t border-border/60 px-5 py-4">
                        <summary className="cursor-pointer list-none text-sm font-medium text-foreground/70 underline underline-offset-4 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                          Les mer om grunnlaget
                        </summary>
                        <div className="mt-3 space-y-3">
                          <MarkdownViewer
                            content={req.description}
                            className="analysis-prose max-w-none text-[1.02rem] text-muted-foreground"
                          />
                          {req.source_reference || req.source_excerpt ? (
                            <p className="text-xs text-muted-foreground/70">
                              {req.source_reference || "Ingen referanse"} ·{" "}
                              {req.source_excerpt || ""}
                            </p>
                          ) : null}
                        </div>
                      </details>
                    </div>
                  ))}
                </div>
              ) : (
                <AnalysisTabEmptyState>
                  Ingen underliggende behov er identifisert ennå.
                </AnalysisTabEmptyState>
              )}
            </SectionSurface>
          </TabsContent>

          <TabsContent value="keywords" className="mt-0">
            <SectionSurface
              title={`Gjenbrukte nøkkelord (${topSignalWords.length} mest brukte)`}
              description="De mest gjentatte signalordene og tekniske føringene som bør gjenspeiles i språk, løsning og arkitektur."
              icon={Cpu}
              action={renderRegenerateButton("keywords")}
            >
              {topSignalWords.length ? (
                <div className="space-y-3">
                  {topSignalWords.map((item, index) => (
                    <div
                      key={`${item}-${index}`}
                      className="flex items-center gap-3 border-b border-border/60 pb-3 text-sm text-foreground last:border-b-0 last:pb-0"
                    >
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
                        {(() => {
                          const Icon = getKeywordIcon(item);
                          return <Icon className="size-4.5" />;
                        })()}
                      </div>
                      <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate text-[0.98rem] font-medium text-foreground">
                          {item}
                        </span>
                        <span className="shrink-0 rounded-full border border-primary/15 bg-primary/6 px-2.5 py-1 text-xs font-semibold text-primary">
                          {getKeywordMentionCount(customerAnalysis, item)}x
                          nevnt
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <AnalysisTabEmptyState>
                  Ingen gjenbrukte nøkkelord er identifisert ennå.
                </AnalysisTabEmptyState>
              )}
            </SectionSurface>
          </TabsContent>

          <TabsContent value="value" className="mt-0">
            <SectionSurface
              title={`Verdimuligheter (${customerAnalysis.value_opportunities.length})`}
              description="Hvor løsningen kan skape tydelig effekt for kunden i form av gevinst, risiko eller opplevelse."
              icon={TrendingUp}
              action={renderRegenerateButton("value")}
            >
              <div className="space-y-4">
                {customerAnalysis.value_opportunities.map((item, index) => (
                  <div
                    key={`${item.title}-${index}`}
                    className="border-b border-border/60 pb-4 last:border-b-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <ValueTags
                          values={item.value_categories
                            .filter((v) => VALUE_LABELS.includes(v))
                            .slice(0, 1)}
                        />
                      </div>
                      <span className="inline-flex rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                        {profitShares[index] ?? 0}% av profitteffekt
                      </span>
                    </div>
                    <details className="mt-3 group">
                      <summary className="cursor-pointer list-none text-sm font-medium text-foreground/70 underline underline-offset-4 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                        Les mer
                      </summary>
                      <div className="mt-3">
                        <MarkdownViewer
                          content={item.description}
                          className="analysis-prose text-[0.98rem] text-muted-foreground"
                        />
                      </div>
                    </details>
                    <div className="sr-only">{item.title}</div>
                  </div>
                ))}
              </div>
            </SectionSurface>
          </TabsContent>
        </Tabs>
      ) : (
        <AnalysisTabEmptyState>
          Ingen analyse ennå. Last opp et primært kundedokument og generer
          analysen.
        </AnalysisTabEmptyState>
      )}
    </div>
  );
}
