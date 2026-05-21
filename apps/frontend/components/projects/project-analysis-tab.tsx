"use client";

import dynamic from "next/dynamic";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useState } from "react";
import {
  AlertTriangle,
  Building2,
  Cloud,
  Compass,
  Cpu,
  Database,
  FilePenLine,
  History,
  KeyRound,
  ListChecks,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Target,
  Trash2,
  TrendingUp,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { Input, Label } from "@/components/projects/primitives";
import {
  AnalysisTabEmptyState,
  GenerationProgress,
  VALUE_LABELS,
  ValueTags,
} from "@/components/projects/project-workspace-shared";
import { getCustomerAnalysisSectionSnapshot } from "@/lib/customer-analysis-history";
import { normalizeTechnologySignalWords } from "@/lib/signal-words";
import type {
  CustomerAnalysisHistorySource,
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  CustomerAnalysisSectionHistoryEntry,
  CustomerAnalysisSectionSnapshotMap,
  AnalysisRequirement,
  ProjectDocument,
  RequirementImportance,
  RequirementKind,
  ValueCategory,
  ValueOpportunity,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type EditableCustomerAnalysisSnapshot =
  CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection];

const REQUIREMENT_IMPORTANCE_OPTIONS: RequirementImportance[] = [
  "Kritisk",
  "Viktig",
  "Mindre viktig",
];

const REQUIREMENT_KIND_OPTIONS: RequirementKind[] = [
  "Eksplisitt",
  "Implisitt",
];

function cloneEditableSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cleanStringList(items: string[]) {
  return items.map((item) => item.trim()).filter(Boolean);
}

function emptyAnalysisRequirement(kind: RequirementKind): AnalysisRequirement {
  return {
    title: "",
    description: "",
    category: "",
    importance: "Viktig",
    kind,
    source_reference: "",
    source_excerpt: "",
  };
}

function emptyValueOpportunity(): ValueOpportunity {
  return {
    title: "",
    description: "",
    value_categories: [],
    profit_share_percent: 0,
  };
}

function sanitizeSectionDraft(
  section: CustomerAnalysisSection,
  snapshot: EditableCustomerAnalysisSnapshot,
): EditableCustomerAnalysisSnapshot {
  switch (section) {
    case "summary": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["summary"];
      return {
        customer_profile_summary: value.customer_profile_summary.trim(),
        customer_goals_summary: value.customer_goals_summary.trim(),
      };
    }
    case "strategy": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["strategy"];
      return {
        executive_summary: value.executive_summary.trim(),
        positioning_recommendations: cleanStringList(
          value.positioning_recommendations,
        ),
      };
    }
    case "clarifications": {
      const value =
        snapshot as CustomerAnalysisSectionSnapshotMap["clarifications"];
      return {
        ambiguities: cleanStringList(value.ambiguities),
        expected_solution_direction: cleanStringList(
          value.expected_solution_direction,
        ),
        likely_evaluation_criteria: cleanStringList(
          value.likely_evaluation_criteria,
        ),
      };
    }
    case "design": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["design"];
      return {
        high_level_solution_design: value.high_level_solution_design.trim(),
        high_level_architecture_mermaid:
          value.high_level_architecture_mermaid.trim(),
      };
    }
    case "risks": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["risks"];
      return {
        risks: cleanStringList(value.risks),
        risks_for_us: cleanStringList(value.risks_for_us ?? []),
        risks_for_customer: cleanStringList(value.risks_for_customer ?? []),
      };
    }
    case "needs": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["needs"];
      return {
        implicit_requirements: value.implicit_requirements
          .map((item) => ({
            title: item.title.trim(),
            description: item.description.trim(),
            category: item.category.trim(),
            importance: item.importance,
            kind: item.kind,
            source_reference: item.source_reference.trim(),
            source_excerpt: item.source_excerpt.trim(),
          }))
          .filter((item) => item.title || item.description),
        prioritized_requirements: value.prioritized_requirements
          .map((item) => ({
            requirement: item.requirement.trim(),
            priority: item.priority,
            reason: item.reason.trim(),
          }))
          .filter((item) => item.requirement || item.reason),
      };
    }
    case "keywords": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["keywords"];
      const signalWords = normalizeTechnologySignalWords(value.signal_words);
      const counts = Object.fromEntries(
        Object.entries(value.signal_word_counts ?? {})
          .map(([word, count]) => [word.trim(), Number(count)] as const)
          .filter(
            ([word, count]) =>
              signalWords.includes(word) && Number.isFinite(count),
          ),
      );
      return {
        signal_words: signalWords,
        signal_word_counts: counts,
      };
    }
    case "value": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["value"];
      return {
        value_opportunities: value.value_opportunities
          .map((item) => ({
            title: item.title.trim(),
            description: item.description.trim(),
            value_categories: item.value_categories.filter(
              (category): category is ValueCategory =>
                VALUE_LABELS.includes(category),
            ),
            profit_share_percent: Number.isFinite(item.profit_share_percent)
              ? Math.max(0, Math.min(100, item.profit_share_percent))
              : 0,
          }))
          .filter((item) => item.title || item.description),
      };
    }
  }
}

const MermaidDiagram = dynamic(
  () =>
    import("@/components/projects/mermaid-diagram").then(
      (module) => module.MermaidDiagram,
    ),
  {
    loading: () => (
      <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5 text-sm text-muted-foreground">
        Laster arkitekturdiagram ...
      </div>
    ),
  },
);

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
    <section className="max-w-full overflow-hidden rounded-xl border border-border/70 bg-white/85 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 px-5 py-4 md:px-6">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
            <Icon className="size-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        {action ? (
          <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
            {action}
          </div>
        ) : null}
      </div>
      <div className="px-5 py-5 md:px-6 md:py-6">{children}</div>
    </section>
  );
}

function formatHistoryTimestamp(value: string) {
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function historySourceLabel(source: CustomerAnalysisHistorySource) {
  switch (source) {
    case "full_regeneration":
      return "Full redigering";
    case "section_regeneration":
      return "Seksjon redigert";
    case "manual_edit":
      return "Manuell lagring";
    case "high_level_design_update":
      return "Designoppdatering";
  }
}

function HistoryCopyCard({
  title,
  content,
}: {
  title: string;
  content: string;
}) {
  if (!content.trim()) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border/70 bg-background/80 px-4 py-4">
      <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </p>
      <MarkdownViewer
        content={content}
        className="analysis-prose mt-3 max-w-none text-[0.98rem] text-foreground"
      />
    </div>
  );
}

function HistoryBulletList({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: string[];
  emptyText: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/80 px-4 py-4">
      <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </p>
      {items.length ? (
        <div className="mt-3 space-y-2.5">
          {items.map((item, index) => (
            <div
              key={`${title}-${index}`}
              className="rounded-md border border-border/60 bg-card px-3 py-3"
            >
              <MarkdownViewer
                content={item}
                className="analysis-prose max-w-none text-[0.97rem] text-foreground"
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {emptyText}
        </p>
      )}
    </div>
  );
}

function SectionHistoryContent({
  section,
  snapshot,
}: {
  section: CustomerAnalysisSection;
  snapshot: CustomerAnalysisSectionHistoryEntry["snapshot"];
}) {
  switch (section) {
    case "summary": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["summary"];
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <HistoryCopyCard
            title="Kundesituasjon"
            content={value.customer_profile_summary}
          />
          <HistoryCopyCard
            title="Kundens mål"
            content={value.customer_goals_summary}
          />
        </div>
      );
    }
    case "strategy": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["strategy"];
      return (
        <div className="space-y-4">
          <HistoryCopyCard
            title="Arbeidstekst"
            content={value.executive_summary}
          />
          <HistoryBulletList
            title="Posisjoneringsspor"
            items={value.positioning_recommendations}
            emptyText="Ingen posisjoneringsspor var lagret i denne versjonen."
          />
        </div>
      );
    }
    case "clarifications": {
      const value =
        snapshot as CustomerAnalysisSectionSnapshotMap["clarifications"];
      return (
        <div className="space-y-4">
          <HistoryBulletList
            title="Avklaringer"
            items={value.ambiguities}
            emptyText="Ingen avklaringer var lagret i denne versjonen."
          />
        </div>
      );
    }
    case "design": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["design"];
      return (
        <div className="space-y-4">
          <HistoryCopyCard
            title="High-level design"
            content={value.high_level_solution_design}
          />
          {value.high_level_architecture_mermaid.trim() ? (
            <div className="rounded-lg border border-border/70 bg-background/80 px-4 py-4">
              <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Arkitekturdiagram
              </p>
              <div className="mt-4 rounded-lg border border-border/60 bg-white p-3">
                <MermaidDiagram
                  chart={value.high_level_architecture_mermaid}
                  title="Tidligere arkitekturdiagram"
                  downloadName="tidligere-arkitekturdiagram"
                />
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    case "risks": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["risks"];
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <HistoryBulletList
            title="Risiko for oss"
            items={value.risks_for_us ?? []}
            emptyText="Ingen leverandør-/tilbudsrisiko i denne versjonen."
          />
          <HistoryBulletList
            title="Risiko for kunden"
            items={value.risks_for_customer ?? value.risks}
            emptyText="Ingen kunderisiko i denne versjonen."
          />
        </div>
      );
    }
    case "needs": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["needs"];
      return (
        <div className="space-y-4">
          {value.implicit_requirements.length ? (
            <div className="space-y-3">
              {value.implicit_requirements.map((item, index) => (
                <article
                  key={`${item.title}-${index}`}
                  className="rounded-lg border border-border/70 bg-background/80 px-4 py-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                      {item.importance}
                    </span>
                    <span className="rounded-md bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
                      {item.category}
                    </span>
                  </div>
                  <h4 className="mt-3 text-base font-semibold text-foreground">
                    {item.title}
                  </h4>
                  <MarkdownViewer
                    content={item.description}
                    className="analysis-prose mt-2 max-w-none text-[0.97rem] text-muted-foreground"
                  />
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              Ingen underliggende behov var lagret i denne versjonen.
            </p>
          )}
        </div>
      );
    }
    case "keywords": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["keywords"];
      const signalWords = normalizeTechnologySignalWords(value.signal_words);
      return (
        <div className="flex flex-wrap gap-2">
          {signalWords.length ? (
            signalWords.map((item, index) => (
              <span
                key={`${item}-${index}`}
                className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-2 text-sm font-medium text-foreground"
              >
                <span>{item}</span>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                  {value.signal_word_counts?.[item] ?? 1}x
                </span>
              </span>
            ))
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              Ingen nøkkelord var lagret i denne versjonen.
            </p>
          )}
        </div>
      );
    }
    case "value": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["value"];
      return (
        <div className="space-y-4">
          {value.value_opportunities.length ? (
            value.value_opportunities.map((item, index) => (
              <article
                key={`${item.title}-${index}`}
                className="rounded-lg border border-border/70 bg-background/80 px-4 py-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h4 className="text-base font-semibold text-foreground">
                    {item.title}
                  </h4>
                  <ValueTags values={item.value_categories} />
                </div>
                <MarkdownViewer
                  content={item.description}
                  className="analysis-prose mt-3 max-w-none text-[0.98rem] text-muted-foreground"
                />
              </article>
            ))
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              Ingen verdimuligheter var lagret i denne versjonen.
            </p>
          )}
        </div>
      );
    }
  }
}

function SectionHistoryPanel({
  analysis,
  section,
}: {
  analysis: CustomerAnalysisResult;
  section: CustomerAnalysisSection;
}) {
  const entries = analysis.section_histories?.[section] ?? [];
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (
      selectedHistoryId &&
      !entries.some((entry) => entry.id === selectedHistoryId)
    ) {
      setSelectedHistoryId(null);
    }
  }, [entries, selectedHistoryId]);

  if (!entries.length) {
    return null;
  }

  const selectedEntry =
    entries.find((entry) => entry.id === selectedHistoryId) ?? null;

  return (
    <details className="group mt-6 overflow-hidden rounded-xl border border-border/70 bg-slate-50/80">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:text-slate-950 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <History className="size-4" />
          Tidligere seksjoner
        </span>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-500 shadow-sm">
          {entries.length}
        </span>
      </summary>
      <div className="border-t border-border/70 px-4 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Velg lagret versjon
            </p>
            <Select
              value={selectedHistoryId ?? undefined}
              onValueChange={setSelectedHistoryId}
            >
              <SelectTrigger className="mt-2 h-10 w-full max-w-full bg-white">
                <SelectValue placeholder="Velg en tidligere seksjon" />
              </SelectTrigger>
              <SelectContent align="start" className="max-h-80">
                {entries.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {`${formatHistoryTimestamp(entry.created_at)} · ${historySourceLabel(entry.source)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant={selectedEntry ? "outline" : "secondary"}
            size="sm"
            onClick={() => setSelectedHistoryId(null)}
            disabled={!selectedEntry}
          >
            Nyeste seksjon
          </Button>
        </div>

        {selectedEntry ? (
          <div className="mt-4 rounded-xl border border-border/70 bg-white/90 p-4 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {formatHistoryTimestamp(selectedEntry.created_at)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {historySourceLabel(selectedEntry.source)}
                </p>
              </div>
            </div>
            <SectionHistoryContent
              section={section}
              snapshot={selectedEntry.snapshot}
            />
          </div>
        ) : (
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Nyeste seksjon vises allerede over. Velg en tidligere versjon i
            listen for å se innholdet.
          </p>
        )}
      </div>
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

const PIE_NEUTRAL = "rgb(203, 213, 225)";
const VALUE_CATEGORY_COLORS = {
  "Høyere produktivitet": "rgb(37, 99, 235)",
  "Lavere kostnader": "rgb(5, 150, 105)",
  "Redusert risiko": "rgb(217, 119, 6)",
  "Bedre brukeropplevelse": "rgb(124, 58, 237)",
} satisfies Record<(typeof VALUE_LABELS)[number], string>;

const KEYWORD_COLORS = [
  "rgb(30, 58, 138)",
  "rgb(14, 116, 144)",
  "rgb(5, 150, 105)",
  "rgb(217, 119, 6)",
  "rgb(124, 58, 237)",
] as const;

const POSITIONING_LANES = [
  {
    title: "Budskap",
    eyebrow: "Hva vi skal eie",
    icon: Target,
    className: "border-blue-200/80 bg-blue-50/80 text-blue-950",
    iconClassName: "bg-blue-600 text-white",
    badgeClassName: "bg-blue-600/10 text-blue-800",
  },
  {
    title: "Trygghet",
    eyebrow: "Hva kunden må tro på",
    icon: Shield,
    className: "border-emerald-200/80 bg-emerald-50/75 text-emerald-950",
    iconClassName: "bg-emerald-600 text-white",
    badgeClassName: "bg-emerald-600/10 text-emerald-800",
  },
  {
    title: "Bevis",
    eyebrow: "Hva tilbudet må vise",
    icon: ListChecks,
    className: "border-amber-200/80 bg-amber-50/75 text-amber-950",
    iconClassName: "bg-amber-500 text-white",
    badgeClassName: "bg-amber-500/12 text-amber-800",
  },
  {
    title: "Leveranse",
    eyebrow: "Hvordan det landes",
    icon: Workflow,
    className: "border-cyan-200/80 bg-cyan-50/75 text-cyan-950",
    iconClassName: "bg-cyan-700 text-white",
    badgeClassName: "bg-cyan-700/10 text-cyan-800",
  },
] satisfies Array<{
  title: string;
  eyebrow: string;
  icon: LucideIcon;
  className: string;
  iconClassName: string;
  badgeClassName: string;
}>;

const NEED_CARD_STYLES = [
  {
    railClassName: "from-blue-600 via-blue-500 to-cyan-500",
    iconClassName: "bg-blue-600 text-white",
    shellClassName: "border-blue-200 bg-blue-50/70 text-blue-950",
  },
  {
    railClassName: "from-emerald-600 via-emerald-500 to-teal-500",
    iconClassName: "bg-emerald-600 text-white",
    shellClassName: "border-emerald-200 bg-emerald-50/70 text-emerald-950",
  },
  {
    railClassName: "from-amber-500 via-orange-400 to-rose-400",
    iconClassName: "bg-amber-500 text-white",
    shellClassName: "border-amber-200 bg-amber-50/72 text-amber-950",
  },
] as const;

const RISK_AUDIENCE_STYLES = [
  {
    eyebrow: "Leveranserisiko",
    iconClassName: "bg-red-600 text-white",
    shellClassName:
      "border-red-200/75 bg-[linear-gradient(135deg,rgba(254,242,242,0.82),rgba(255,255,255,0.94)_42%,rgba(248,250,252,0.88))]",
    numberClassName: "bg-red-600/10 text-red-800",
    accentClassName: "bg-red-600",
  },
  {
    eyebrow: "Kunderisiko",
    iconClassName: "bg-orange-500 text-white",
    shellClassName:
      "border-orange-200/75 bg-[linear-gradient(135deg,rgba(255,247,237,0.84),rgba(255,255,255,0.94)_42%,rgba(255,251,235,0.7))]",
    numberClassName: "bg-orange-500/12 text-orange-800",
    accentClassName: "bg-orange-500",
  },
] as const;

const MAX_RISKS_PER_AUDIENCE = 3;

type PieDatum = {
  id: string;
  label: string;
  value: number;
  color: string;
};

function getPrimaryValueCategory(
  item: CustomerAnalysisResult["value_opportunities"][number],
) {
  return (
    item.value_categories.find((value) => VALUE_LABELS.includes(value)) ?? null
  );
}

function normalizePieData(data: PieDatum[]) {
  const sanitized = data.map((item) => ({
    ...item,
    value:
      typeof item.value === "number" && Number.isFinite(item.value)
        ? Math.max(0, item.value)
        : 0,
  }));
  const total = sanitized.reduce((sum, item) => sum + item.value, 0);

  if (total > 0) {
    return { data: sanitized, total };
  }

  const fallback = sanitized.map((item) => ({ ...item, value: 1 }));
  return {
    data: fallback,
    total: fallback.reduce((sum, item) => sum + item.value, 0),
  };
}

type PieLabelDatum = {
  index: number;
  y: number;
};

function distributePieLabelYPositions(
  labels: PieLabelDatum[],
  minY: number,
  maxY: number,
  gap: number,
) {
  if (!labels.length) {
    return new Map<number, number>();
  }

  const placed = [...labels]
    .sort((left, right) => left.y - right.y)
    .map((label) => ({ ...label }));
  let cursor = minY;

  for (const label of placed) {
    label.y = Math.max(label.y, cursor);
    cursor = label.y + gap;
  }

  const overflow = cursor - gap - maxY;

  if (overflow > 0) {
    for (let index = placed.length - 1; index >= 0; index -= 1) {
      const nextY = index === placed.length - 1 ? maxY : placed[index + 1].y - gap;
      placed[index].y = Math.min(placed[index].y - overflow, nextY);
    }

    for (let index = 0; index < placed.length; index += 1) {
      const previousY = index === 0 ? minY : placed[index - 1].y + gap;
      placed[index].y = Math.max(placed[index].y, previousY);
    }
  }

  return new Map(placed.map((label) => [label.index, label.y]));
}

function polarEllipsePoint(
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  angleInDegrees: number,
) {
  const angleInRadians = (angleInDegrees * Math.PI) / 180;

  return {
    x: centerX + radiusX * Math.cos(angleInRadians),
    y: centerY + radiusY * Math.sin(angleInRadians),
  };
}

function describeEllipticalDonutSegment(
  centerX: number,
  centerY: number,
  outerRadiusX: number,
  outerRadiusY: number,
  innerRadiusX: number,
  innerRadiusY: number,
  startAngle: number,
  endAngle: number,
) {
  const safeEndAngle = Math.min(endAngle, startAngle + 359.99);
  const outerStart = polarEllipsePoint(
    centerX,
    centerY,
    outerRadiusX,
    outerRadiusY,
    startAngle,
  );
  const outerEnd = polarEllipsePoint(
    centerX,
    centerY,
    outerRadiusX,
    outerRadiusY,
    safeEndAngle,
  );
  const innerStart = polarEllipsePoint(
    centerX,
    centerY,
    innerRadiusX,
    innerRadiusY,
    startAngle,
  );
  const innerEnd = polarEllipsePoint(
    centerX,
    centerY,
    innerRadiusX,
    innerRadiusY,
    safeEndAngle,
  );
  const largeArcFlag = safeEndAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadiusX} ${outerRadiusY} 0 ${largeArcFlag} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadiusX} ${innerRadiusY} 0 ${largeArcFlag} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function normalizeAngle(angle: number) {
  return ((angle % 360) + 360) % 360;
}

function parseColorChannels(color: string) {
  const rgbMatch = color.match(
    /rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i,
  );

  if (rgbMatch) {
    return rgbMatch.slice(1, 4).map((value) => Number(value)) as [
      number,
      number,
      number,
    ];
  }

  const hex = color.trim().replace("#", "");
  if (hex.length === 3) {
    return hex
      .split("")
      .map((value) => Number.parseInt(`${value}${value}`, 16)) as [
      number,
      number,
      number,
    ];
  }

  if (hex.length === 6) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  return [148, 163, 184];
}

function mixColor(
  color: string,
  target: [number, number, number],
  amount: number,
) {
  const [red, green, blue] = parseColorChannels(color);
  const mix = Math.min(1, Math.max(0, amount));

  const blended = [red, green, blue].map((channel, index) =>
    Math.round(channel + (target[index] - channel) * mix),
  );

  return `rgb(${blended[0]}, ${blended[1]}, ${blended[2]})`;
}

function withAlpha(color: string, alpha: number) {
  const [red, green, blue] = parseColorChannels(color);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function DonutChart({
  data,
  selectedIndex,
  onSelect,
  valueSuffix,
}: {
  data: PieDatum[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  valueSuffix: string;
}) {
  const chartId = useId().replace(/:/g, "");
  const reduceMotion = useReducedMotion();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const { data: normalizedData, total } = normalizePieData(data);
  const centerX = 330;
  const centerY = 190;
  const outerRadius = 130;
  const innerRadius = 76;
  const labelOrbitRadius = outerRadius + 22;
  const calloutRadius = outerRadius + 40;
  const labelLeftX = 112;
  const labelRightX = 668;
  let accumulated = 0;
  const activeIndex = hoveredIndex ?? selectedIndex;
  const segments = normalizedData.map((item) => {
    const share = item.value / total;
    const startAngle = accumulated * 360 - 90;
    const endAngle = (accumulated + share) * 360 - 90;
    accumulated += share;

    return {
      ...item,
      startAngle,
      endAngle,
      midAngle: startAngle + (endAngle - startAngle) / 2,
    };
  });
  const labelPositions = segments.map((item, index) => {
    const labelPoint = polarEllipsePoint(
      centerX,
      centerY,
      labelOrbitRadius,
      labelOrbitRadius,
      item.midAngle,
    );
    const side = Math.cos((normalizeAngle(item.midAngle) * Math.PI) / 180) >= 0
      ? "right"
      : "left";

    return {
      index,
      item,
      side,
      labelPoint,
    };
  });
  const leftLabelMap = distributePieLabelYPositions(
    labelPositions
      .filter((label) => label.side === "left")
      .map((label) => ({ index: label.index, y: label.labelPoint.y })),
    48,
    332,
    34,
  );
  const rightLabelMap = distributePieLabelYPositions(
    labelPositions
      .filter((label) => label.side === "right")
      .map((label) => ({ index: label.index, y: label.labelPoint.y })),
    48,
    332,
    34,
  );
  function handlePointerLeave() {
    setHoveredIndex(null);
  }

  function handleSliceClick(index: number) {
    onSelect(selectedIndex === index ? null : index);
  }

  return (
    <div
      className="value-donut-frame mx-auto flex w-full max-w-[50rem] flex-col items-center"
      onPointerLeave={handlePointerLeave}
    >
      <div className="relative w-full">
        <div className="pointer-events-none absolute inset-0 rounded-[2rem] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.98),rgba(239,246,255,0.56)_45%,rgba(255,255,255,0)_74%)]" />
        <div className="pointer-events-none absolute inset-x-16 top-4 h-12 rounded-full bg-slate-200/35 blur-3xl" />
        <motion.div className="relative">
          <svg
            viewBox="0 0 780 380"
            className="w-full overflow-visible"
            aria-label="Kakediagram"
          >
            <defs>
              <filter
                id={`${chartId}-slice-shadow`}
                x="-30%"
                y="-30%"
                width="180%"
                height="180%"
              >
                <feDropShadow
                  dx="0"
                  dy="10"
                  stdDeviation="10"
                  floodColor="rgba(15, 23, 42, 0.16)"
                />
              </filter>
              <radialGradient id={`${chartId}-backdrop`} cx="50%" cy="50%" r="65%">
                <stop offset="0%" stopColor="rgba(255, 255, 255, 0.98)" />
                <stop offset="68%" stopColor="rgba(241, 245, 249, 0.78)" />
                <stop offset="100%" stopColor="rgba(226, 232, 240, 0.12)" />
              </radialGradient>
              <linearGradient
                id={`${chartId}-track`}
                x1="0%"
                y1="0%"
                x2="100%"
                y2="100%"
              >
                <stop offset="0%" stopColor="rgba(255, 255, 255, 0.95)" />
                <stop offset="100%" stopColor="rgba(226, 232, 240, 0.94)" />
              </linearGradient>
              {segments.map((item, index) => (
                <linearGradient
                  key={`${item.id}-gradient`}
                  id={`${chartId}-top-${index}`}
                  x1="10%"
                  y1="0%"
                  x2="90%"
                  y2="100%"
                >
                  <stop
                    offset="0%"
                    stopColor={mixColor(item.color, [255, 255, 255], 0.22)}
                  />
                  <stop offset="56%" stopColor={item.color} />
                  <stop
                    offset="100%"
                    stopColor={mixColor(item.color, [15, 23, 42], 0.16)}
                  />
                </linearGradient>
              ))}
            </defs>

            <circle
              cx={centerX}
              cy={centerY}
              r={outerRadius + 40}
              fill={`url(#${chartId}-backdrop)`}
            />
            <circle
              cx={centerX}
              cy={centerY}
              r={(outerRadius + innerRadius) / 2}
              fill="none"
              stroke={`url(#${chartId}-track)`}
              strokeWidth={outerRadius - innerRadius}
            />

            <g filter={`url(#${chartId}-slice-shadow)`}>
              {segments.map((item, index) => {
                const isSelected = selectedIndex === index;
                const isHovered = hoveredIndex === index;
                const hasActive = activeIndex !== null;
                const emphasis = isSelected ? 9 : isHovered ? 5 : 0;
                const angleInRadians = (item.midAngle * Math.PI) / 180;
                const translateX = Math.cos(angleInRadians) * emphasis;
                const translateY = Math.sin(angleInRadians) * emphasis;

                return (
                  <motion.g
                    key={item.id}
                    animate={{
                      x: reduceMotion ? 0 : translateX,
                      y: reduceMotion ? 0 : translateY,
                      scale: reduceMotion ? 1 : isSelected ? 1.015 : isHovered ? 1.008 : 1,
                      opacity: !hasActive || isSelected || isHovered ? 1 : 0.48,
                    }}
                    transition={{
                      type: "spring",
                      stiffness: 220,
                      damping: 26,
                      mass: 0.72,
                    }}
                  >
                    <motion.path
                      d={describeEllipticalDonutSegment(
                        centerX,
                        centerY,
                        outerRadius,
                        outerRadius,
                        innerRadius,
                        innerRadius,
                        item.startAngle,
                        item.endAngle,
                      )}
                      fill={`url(#${chartId}-top-${index})`}
                      stroke={mixColor(item.color, [255, 255, 255], 0.68)}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      className="cursor-pointer outline-none"
                      style={{
                        filter:
                          isSelected || isHovered
                            ? `drop-shadow(0 10px 18px ${withAlpha(item.color, 0.2)})`
                            : undefined,
                      }}
                      whileHover={
                        reduceMotion
                          ? undefined
                          : {
                              scale: 1.01,
                              filter: `drop-shadow(0 12px 22px ${withAlpha(item.color, 0.22)})`,
                            }
                      }
                      role="button"
                      tabIndex={0}
                      focusable="true"
                      aria-label={`${item.label}: ${item.value}${valueSuffix}`}
                      onFocus={() => setHoveredIndex(index)}
                      onBlur={() => setHoveredIndex(null)}
                      onHoverStart={() => setHoveredIndex(index)}
                      onHoverEnd={() => setHoveredIndex(null)}
                      onClick={() => handleSliceClick(index)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleSliceClick(index);
                        }
                      }}
                    />
                  </motion.g>
                );
              })}
            </g>
            <circle
              cx={centerX}
              cy={centerY}
              r={innerRadius - 8}
              fill="rgba(255, 255, 255, 0.88)"
              stroke="rgba(255, 255, 255, 0.96)"
              strokeWidth={2}
            />
            <circle
              cx={centerX}
              cy={centerY}
              r={innerRadius - 14}
              fill="rgba(248, 250, 252, 0.88)"
            />
            {labelPositions.map((label) => {
              const outerPoint = polarEllipsePoint(
                centerX,
                centerY,
                outerRadius + 4,
                outerRadius + 4,
                label.item.midAngle,
              );
              const elbowPoint = polarEllipsePoint(
                centerX,
                centerY,
                calloutRadius,
                calloutRadius,
                label.item.midAngle,
              );
              const y =
                label.side === "right"
                  ? rightLabelMap.get(label.index) ?? label.labelPoint.y
                  : leftLabelMap.get(label.index) ?? label.labelPoint.y;
              const labelX = label.side === "right" ? labelRightX : labelLeftX;
              const lineEndX = label.side === "right" ? labelX - 10 : labelX + 10;
              const textAnchor = label.side === "right" ? "start" : "end";
              const isActive = activeIndex === null || activeIndex === label.index;

              return (
                <g
                  key={`${label.item.id}-label`}
                  className="value-donut-callout"
                  opacity={isActive ? 1 : 0.45}
                  aria-hidden="true"
                >
                  <path
                    d={`M ${outerPoint.x} ${outerPoint.y} L ${elbowPoint.x} ${y} L ${lineEndX} ${y}`}
                    fill="none"
                    stroke={withAlpha(label.item.color, isActive ? 0.88 : 0.5)}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  />
                  <circle
                    cx={outerPoint.x}
                    cy={outerPoint.y}
                    r={3.5}
                    fill={label.item.color}
                    stroke="rgba(255,255,255,0.92)"
                    strokeWidth={1.25}
                  />
                  <text
                    x={labelX}
                    y={y - 3}
                    textAnchor={textAnchor}
                    fill="rgb(15 23 42)"
                    fontSize="12"
                    fontWeight="600"
                  >
                    {label.item.label}
                  </text>
                  <text
                    x={labelX}
                    y={y + 12}
                    textAnchor={textAnchor}
                    fill="rgb(100 116 139)"
                    fontSize="10.5"
                    fontWeight="500"
                  >
                    {`${label.item.value}${valueSuffix}`}
                  </text>
                </g>
              );
            })}
          </svg>
        </motion.div>
      </div>
    </div>
  );
}

function PieLegend({
  data,
  selectedIndex,
  onSelect,
  valueSuffix,
}: {
  data: PieDatum[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  valueSuffix: string;
}) {
  return (
    <div className="space-y-2">
      {data.map((item, index) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(selectedIndex === index ? null : index)}
          className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left shadow-[0_10px_24px_rgba(15,23,42,0.03)] transition-all ${
            selectedIndex === index
              ? "border-primary/35 bg-[linear-gradient(135deg,rgba(239,246,255,0.9),rgba(255,255,255,0.98))] shadow-[0_12px_28px_rgba(37,99,235,0.08)]"
              : "border-white/80 bg-white/80 hover:-translate-y-0.5 hover:bg-white"
          }`}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full shadow-sm"
              style={{ backgroundColor: item.color }}
            />
            <span className="min-w-0 truncate text-[0.92rem] font-medium text-foreground">
              {item.label}
            </span>
          </span>
          <span className="shrink-0 text-[0.92rem] font-semibold tabular-nums text-foreground">
            {item.value}
            {valueSuffix}
          </span>
        </button>
      ))}
    </div>
  );
}

function ValuePieModule({
  opportunities,
  profitShares,
  selectedIndex,
  onSelect,
}: {
  opportunities: CustomerAnalysisResult["value_opportunities"];
  profitShares: number[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}) {
  const chartData = opportunities.map((item, index) => {
    const category = getPrimaryValueCategory(item);
    return {
      id: `${item.title}-${index}`,
      label: category ?? item.title,
      value: profitShares[index] ?? 0,
      color: category ? VALUE_CATEGORY_COLORS[category] : PIE_NEUTRAL,
    };
  });
  const selected =
    selectedIndex === null ? null : opportunities[selectedIndex] ?? null;
  const selectedCategory = selected ? getPrimaryValueCategory(selected) : null;
  const selectedShare =
    selectedIndex === null ? 0 : profitShares[selectedIndex] ?? 0;
  const selectedColor =
    selectedIndex === null ? undefined : chartData[selectedIndex]?.color;

  if (!opportunities.length) {
    return null;
  }

  return (
    <div className="mb-5 rounded-xl border border-border/70 bg-background/75 p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Kakefordeling
          </p>
          <h4 className="mt-1 text-[1.02rem] font-semibold tracking-[-0.02em] text-foreground">
            Profitteffekt per verdi
          </h4>
        </div>
        <span className="rounded-md border border-border/70 bg-card px-2.5 py-1 text-[0.72rem] font-semibold text-muted-foreground">
          Klikk på en verdi for detaljer
        </span>
      </div>

      <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1.55fr)_minmax(13.5rem,0.45fr)] 2xl:items-start">
        <div className="min-w-0 rounded-[1.4rem] border border-white/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(239,246,255,0.62)_60%,rgba(248,250,252,0.82))] px-3 py-5 shadow-[0_16px_34px_rgba(15,23,42,0.045)] md:px-5">
          <DonutChart
            data={chartData}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            valueSuffix="%"
          />
        </div>
        <div className="min-w-0 space-y-3">
          <PieLegend
            data={chartData}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            valueSuffix="%"
          />
          {selected ? (
            <div className="rounded-lg border border-border/70 bg-card px-3.5 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Valgt verdi
                  </p>
                  <p
                    className="mt-1 text-lg font-semibold"
                    style={{
                      color: selectedColor,
                    }}
                  >
                    {selectedCategory ?? selected.title}
                  </p>
                </div>
                <span className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-[0.82rem] font-semibold text-primary">
                  {selectedShare}% av profitteffekt
                </span>
              </div>
              <details className="group mt-3">
                <summary className="cursor-pointer list-none text-[0.82rem] font-medium text-foreground/70 underline underline-offset-4 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  Les mer
                </summary>
                <div className="mt-3">
                  <MarkdownViewer
                    content={selected.description}
                    className="analysis-prose text-[0.92rem] text-muted-foreground"
                  />
                </div>
              </details>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/80 bg-card/60 px-3.5 py-3.5 text-[0.9rem] leading-6 text-muted-foreground">
              Velg en verdi i kaken eller listen for å se detaljer.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KeywordPieModule({
  analysis,
  keywords,
  selectedIndex,
  onSelect,
}: {
  analysis: CustomerAnalysisResult;
  keywords: string[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}) {
  const chartData = keywords.map((keyword, index) => ({
    id: `${keyword}-${index}`,
    label: keyword,
    value: getKeywordMentionCount(analysis, keyword),
    color: KEYWORD_COLORS[index % KEYWORD_COLORS.length] ?? PIE_NEUTRAL,
  }));
  const selectedKeyword =
    selectedIndex === null ? null : keywords[selectedIndex] ?? null;
  const selectedCount = selectedKeyword
    ? getKeywordMentionCount(analysis, selectedKeyword)
    : 0;
  const totalMentions = chartData.reduce((sum, item) => sum + item.value, 0);
  const selectedShare =
    totalMentions > 0 ? Math.round((selectedCount / totalMentions) * 100) : 0;

  if (!keywords.length) {
    return null;
  }

  const KeywordIcon = selectedKeyword ? getKeywordIcon(selectedKeyword) : null;

  return (
    <div className="mb-5 rounded-xl border border-border/70 bg-background/75 p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Kakefordeling
          </p>
          <h4 className="mt-1 text-[1.02rem] font-semibold tracking-[-0.02em] text-foreground">
            Nøkkelord etter antall nevnt
          </h4>
        </div>
        <span className="rounded-md border border-border/70 bg-card px-2.5 py-1 text-[0.72rem] font-semibold text-muted-foreground">
          Topp 5 signalord
        </span>
      </div>

      <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1.55fr)_minmax(13.5rem,0.45fr)] 2xl:items-start">
        <div className="min-w-0 rounded-[1.4rem] border border-white/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(240,253,250,0.68)_58%,rgba(248,250,252,0.82))] px-3 py-5 shadow-[0_16px_34px_rgba(15,23,42,0.045)] md:px-5">
          <DonutChart
            data={chartData}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            valueSuffix="x"
          />
        </div>
        <div className="min-w-0 space-y-3">
          <PieLegend
            data={chartData}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            valueSuffix="x"
          />
          {selectedKeyword && KeywordIcon ? (
            <div className="rounded-lg border border-border/70 bg-card px-3.5 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div
                    className="flex size-10 shrink-0 items-center justify-center rounded-lg text-white"
                    style={{
                      backgroundColor:
                        selectedIndex === null
                          ? PIE_NEUTRAL
                          : chartData[selectedIndex]?.color,
                    }}
                  >
                    <KeywordIcon className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Valgt nøkkelord
                    </p>
                    <p className="mt-1 text-lg font-semibold text-foreground">
                      {selectedKeyword}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-[0.82rem] font-semibold text-primary">
                  {selectedCount}x · {selectedShare}% av topp 5
                </span>
              </div>
              <details className="group mt-3">
                <summary className="cursor-pointer list-none text-[0.82rem] font-medium text-foreground/70 underline underline-offset-4 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  Les mer
                </summary>
                <p className="mt-3 text-[0.9rem] leading-6 text-muted-foreground">
                  Nøkkelordet er brukt {selectedCount} ganger i analysert
                  grunnlag. Bruk dette som språk- og arkitektursignal i
                  løsningsbeskrivelsen, spesielt der kunden forventer gjenkjennelig
                  terminologi og tydelig kobling til dokumentgrunnlaget.
                </p>
              </details>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/80 bg-card/60 px-3.5 py-3.5 text-[0.9rem] leading-6 text-muted-foreground">
              Velg et nøkkelord i kaken eller listen for å se detaljer.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PositioningKanban({
  items,
  analysis: _analysis,
}: {
  items: string[];
  analysis: CustomerAnalysisResult;
}) {
  const lanes = POSITIONING_LANES.map((lane, laneIndex) => ({
    ...lane,
    items: items
      .map((content, index) => ({ content, index }))
      .filter(({ index }) => index % POSITIONING_LANES.length === laneIndex),
  })).filter(
    (lane) => lane.items.length > 0 || lane.title === "Leveranse",
  );
  const [activeLaneTitle, setActiveLaneTitle] = useState<string>(
    () => lanes[0]?.title ?? "Leveranse",
  );

  useEffect(() => {
    if (!lanes.some((lane) => lane.title === activeLaneTitle)) {
      setActiveLaneTitle(lanes[0]?.title ?? "Leveranse");
    }
  }, [activeLaneTitle, lanes]);

  const activeLane =
    lanes.find((lane) => lane.title === activeLaneTitle) ?? lanes[0] ?? null;

  if (!activeLane) {
    return null;
  }

  const ActiveLaneIcon = activeLane.icon;

  return (
    <div className="min-w-0 space-y-4">
      <div className="-mx-1 overflow-x-auto pb-1">
        <div className="flex min-w-max gap-2 px-1">
          {lanes.map((lane) => {
            const Icon = lane.icon;
            const isActive = lane.title === activeLane.title;
            const itemCount = lane.items.length;

            return (
              <button
                key={lane.title}
                type="button"
                onClick={() => setActiveLaneTitle(lane.title)}
                className={cn(
                  "group flex min-w-[12.5rem] items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left shadow-sm transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/60",
                  lane.className,
                  isActive
                    ? "ring-2 ring-current/20 shadow-[0_14px_34px_rgba(15,23,42,0.10)]"
                    : "opacity-80 hover:opacity-100",
                )}
                aria-pressed={isActive}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-xl shadow-sm",
                      lane.iconClassName,
                    )}
                  >
                    <Icon className="size-4.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[0.66rem] font-bold uppercase tracking-[0.16em] opacity-65">
                      {lane.eyebrow}
                    </p>
                    <h5 className="mt-1 text-sm font-semibold tracking-[-0.02em] sm:text-[0.98rem]">
                      {lane.title}
                    </h5>
                  </div>
                </div>
                <span
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-semibold",
                    lane.badgeClassName,
                  )}
                >
                  {itemCount}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <section
        className={cn(
          "flex min-h-64 flex-col rounded-2xl border p-4 shadow-sm sm:p-5",
          activeLane.className,
        )}
      >
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-xl shadow-sm",
                activeLane.iconClassName,
              )}
            >
              <ActiveLaneIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.18em] opacity-65">
                {activeLane.eyebrow}
              </p>
              <h5 className="mt-1 text-lg font-semibold tracking-[-0.025em]">
                {activeLane.title}
              </h5>
            </div>
          </div>
          <span className="min-w-0 max-w-xl text-sm leading-6 text-slate-600">
            Ett spor om gangen, slik at teamet kan lese og jobbe med innholdet
            uten å miste oversikten.
          </span>
        </div>

        <div className="flex flex-1 flex-col gap-4">
          {activeLane.items.map(({ content, index }) => (
            <article
              key={`positioning-kanban-${index}`}
              className="rounded-xl border border-white/70 bg-white/88 px-5 py-5 shadow-[0_10px_24px_rgba(15,23,42,0.06)] backdrop-blur-sm"
            >
              <MarkdownViewer
                content={content}
                className="analysis-prose max-w-none text-[1rem] leading-7 text-slate-800"
              />
            </article>
          ))}

          {activeLane.items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/80 bg-white/70 px-5 py-5 text-sm leading-6 text-slate-600">
              Ingen prosjektspesifikke anbefalinger er generert for dette sporet
              ennå. Lag fremdriftsplan i egen fane for en konkret
              gjennomføringsplan basert på prosjektgrunnlaget.
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
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

function extractSummaryHighlights(content: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  const explicitItems = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);

  return explicitItems.length >= 2 ? explicitItems.slice(0, 5) : [];
}

const SECTION_TABS = [
  { value: "summary", label: "Oppsummering" },
  { value: "strategy", label: "Strategi" },
  { value: "clarifications", label: "Avklaringer" },
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
  return normalizeTechnologySignalWords(analysis.signal_words)
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
  tone,
}: {
  title: string;
  description: string;
  items: string[];
  emptyText: string;
  tone: 0 | 1;
}) {
  const style = RISK_AUDIENCE_STYLES[tone];
  const visibleItems = items.slice(0, MAX_RISKS_PER_AUDIENCE);

  return (
    <div
      className={`min-w-0 overflow-hidden rounded-xl border shadow-[0_14px_36px_rgba(15,23,42,0.06)] ${style.shellClassName}`}
    >
      <div className="flex items-start gap-3 border-b border-white/80 px-5 py-5 md:px-6">
        <div
          className={`flex size-11 shrink-0 items-center justify-center rounded-lg shadow-sm ${style.iconClassName}`}
        >
          <AlertTriangle className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-[0.72rem] font-bold uppercase tracking-[0.18em] text-slate-500">
            {style.eyebrow}
          </p>
          <h4 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-slate-950">
            {title}
          </h4>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            {description}
          </p>
        </div>
      </div>
      {visibleItems.length ? (
        <div className="space-y-3 px-5 py-5 md:px-6">
          {visibleItems.map((item, index) => {
            const riskText = splitLeadSentence(item);

            return (
              <article
                key={`${title}-${index}`}
                className="relative overflow-hidden rounded-lg border border-slate-200/80 bg-white/88 px-4 py-4"
              >
                <span
                  className={`absolute inset-y-0 left-0 w-1 ${style.accentClassName}`}
                />
                <div className="mb-3 flex min-w-0 items-center gap-2 pl-2">
                  <span
                    className={`rounded-md px-2.5 py-1 text-[0.74rem] font-bold ${style.numberClassName}`}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                    Risiko
                  </span>
                </div>
                <p className="pl-2 text-[1.08rem] font-semibold leading-7 tracking-[-0.02em] text-slate-950">
                  {riskText.lead}
                </p>
                {riskText.body ? (
                  <MarkdownViewer
                    content={riskText.body}
                    className="analysis-prose mt-2 max-w-none pl-2 text-[1.01rem] leading-[1.85] text-slate-600"
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="mx-5 my-5 rounded-lg border border-dashed border-slate-300 bg-white/70 px-4 py-4 text-sm text-slate-500 md:mx-6">
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

function getNeedAsk(
  requirement: CustomerAnalysisResult["implicit_requirements"][number],
) {
  const lead = splitLeadSentence(requirement.description).lead;
  const text = lead || requirement.description || requirement.title;
  return text.length > 220 ? `${text.slice(0, 217).trim()}...` : text;
}

function normalizeReferenceText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeReferenceText(value: string) {
  return normalizeReferenceText(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

function findDocumentForReference(
  documents: ProjectDocument[],
  sourceReference: string,
) {
  const normalizedReference = normalizeReferenceText(sourceReference);
  if (!normalizedReference) {
    return null;
  }

  if (
    normalizedReference.includes("kundedokument") ||
    normalizedReference.includes("customer document")
  ) {
    return documents[0] ?? null;
  }

  if (
    normalizedReference.includes("losningsdokument") ||
    normalizedReference.includes("solution document")
  ) {
    return documents[0] ?? null;
  }

  const referenceTokens = tokenizeReferenceText(sourceReference);
  let bestMatch: { document: ProjectDocument; score: number } | null = null;

  for (const document of documents) {
    const candidates = [
      document.title,
      document.file_name,
    ];
    const normalizedCandidates = candidates
      .map((candidate) => normalizeReferenceText(candidate))
      .filter(Boolean);

    let score = 0;

    for (const candidate of normalizedCandidates) {
      if (candidate === normalizedReference) {
        score = Math.max(score, 100);
      } else if (
        candidate.includes(normalizedReference) ||
        normalizedReference.includes(candidate)
      ) {
        score = Math.max(score, 70);
      }

      for (const token of referenceTokens) {
        if (candidate.includes(token)) {
          score += 12;
        }
      }
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { document, score };
    }
  }

  return bestMatch && bestMatch.score >= 24 ? bestMatch.document : null;
}

function NeedSignalCard({
  requirement,
  index,
  projectId,
  documents,
}: {
  requirement: CustomerAnalysisResult["implicit_requirements"][number];
  index: number;
  projectId: string;
  documents: ProjectDocument[];
}) {
  const style = NEED_CARD_STYLES[index % NEED_CARD_STYLES.length];
  const referencedDocument = findDocumentForReference(
    documents,
    requirement.source_reference,
  );
  const documentHref = referencedDocument
    ? `/api/projects/${projectId}/documents/${referencedDocument.id}?disposition=inline`
    : null;

  return (
    <article className="relative flex h-full min-w-0 overflow-hidden rounded-xl border border-slate-200/80 bg-white/88 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
      <div
        className={`absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b ${style.railClassName}`}
      />
      <div className="flex min-w-0 flex-1 px-5 py-5 md:px-6">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-4">
          <div
            className={`flex size-12 shrink-0 items-center justify-center rounded-lg shadow-sm ${style.iconClassName}`}
          >
            <span className="text-base font-black">{index + 1}</span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <h4 className="text-lg font-semibold leading-7 tracking-[-0.025em] text-slate-950">
              {requirement.title}
            </h4>
            <div className={`mt-4 flex-1 rounded-lg border px-4 py-4 ${style.shellClassName}`}>
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <Target className="size-4 shrink-0" />
                <p className="text-[0.72rem] font-bold uppercase tracking-[0.16em] opacity-70">
                  Behovet
                </p>
              </div>
              <MarkdownViewer
                content={getNeedAsk(requirement)}
                className="analysis-prose max-w-none text-[0.96rem] font-medium leading-7"
              />
            </div>
            {requirement.source_reference ? (
              <p className="mt-3 text-sm leading-6 text-slate-500">
                Kilde:{" "}
                {documentHref ? (
                  <a
                    href={documentHref}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
                  >
                    {requirement.source_reference || referencedDocument?.title}
                  </a>
                ) : (
                  requirement.source_reference
                )}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

export function ProjectAnalysisTab({
  projectId,
  documents,
  customerAnalysis,
  busy,
  saveBusy,
  sectionBusy,
  busyMessage,
  busyProgress,
  onGenerate,
  onSaveAnalysis,
}: {
  projectId: string;
  documents: ProjectDocument[];
  customerAnalysis: CustomerAnalysisResult | null;
  busy: boolean;
  saveBusy: boolean;
  sectionBusy: CustomerAnalysisSection | null;
  busyMessage: string;
  busyProgress: number;
  onGenerate: () => void;
  onSaveAnalysis: (
    section: CustomerAnalysisSection,
    snapshot: CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
  ) => Promise<void>;
}) {
  const [editingSection, setEditingSection] =
    useState<CustomerAnalysisSection | null>(null);
  const [sectionDraft, setSectionDraft] =
    useState<EditableCustomerAnalysisSnapshot | null>(null);
  const [sectionDraftError, setSectionDraftError] = useState("");
  const [activeSection, setActiveSection] =
    useState<(typeof SECTION_TABS)[number]["value"]>(
      "summary",
    );
  const [selectedValueIndex, setSelectedValueIndex] = useState<number | null>(
    null,
  );
  const [selectedKeywordIndex, setSelectedKeywordIndex] = useState<
    number | null
  >(null);
  const [showKeywordList, setShowKeywordList] = useState(false);
  const [showValueList, setShowValueList] = useState(false);

  useEffect(() => {
    if (!customerAnalysis) {
      setActiveSection("summary");
      setEditingSection(null);
      setSectionDraft(null);
      setSectionDraftError("");
    }
  }, [customerAnalysis]);

  useEffect(() => {
    if (
      customerAnalysis &&
      selectedValueIndex !== null &&
      selectedValueIndex >= customerAnalysis.value_opportunities.length
    ) {
      setSelectedValueIndex(null);
    }
  }, [customerAnalysis, selectedValueIndex]);

  useEffect(() => {
    if (customerAnalysis) {
      const keywordCount = getTopSignalWords(customerAnalysis).length;
      if (selectedKeywordIndex !== null && selectedKeywordIndex >= keywordCount) {
        setSelectedKeywordIndex(null);
      }
    }
  }, [customerAnalysis, selectedKeywordIndex]);

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
          eyebrow: "Nåsituasjon",
          description:
            "Hva slags virksomhet dette er, hva som preger dagens plattform og hvorfor kompleksiteten betyr noe.",
          icon: Building2,
          content: customerAnalysis.customer_profile_summary || "",
          bullets: extractSummaryHighlights(
            customerAnalysis.customer_profile_summary || "",
          ),
          accentClassName:
            "border-emerald-200/80 bg-[linear-gradient(180deg,rgba(236,253,245,0.94),rgba(255,255,255,0.92))]",
          iconClassName: "bg-emerald-600 text-white",
          chipClassName: "bg-emerald-600/10 text-emerald-800",
          expandedLeadClassName: "font-normal",
        },
        {
          key: "goals",
          title: "Kundens mål og retning",
          eyebrow: "Ønsket retning",
          description:
            "Hva kunden prøver å oppnå, hvilken utviklingsretning virksomheten peker mot, og hvordan dette kan brukes til å forme en mer rettet løsning.",
          icon: Compass,
          content: customerAnalysis.customer_goals_summary || "",
          bullets: extractSummaryHighlights(
            customerAnalysis.customer_goals_summary || "",
          ),
          accentClassName:
            "border-emerald-200/80 bg-[linear-gradient(180deg,rgba(236,253,245,0.94),rgba(255,255,255,0.92))]",
          iconClassName: "bg-emerald-600 text-white",
          chipClassName: "bg-emerald-600/10 text-emerald-800",
          expandedLeadClassName: "font-normal",
        },
      ].filter((item) => item.content.trim().length > 0)
    : [];
  const profitShares = customerAnalysis
    ? getDisplayProfitShares(customerAnalysis.value_opportunities)
    : [];
  const valueDisplayItems = customerAnalysis
    ? customerAnalysis.value_opportunities
        .map((opportunity, index) => ({
          opportunity,
          profitShare: profitShares[index] ?? 0,
          originalIndex: index,
        }))
        .sort(
          (left, right) =>
            right.profitShare - left.profitShare ||
            left.originalIndex - right.originalIndex,
        )
    : [];
  const riskGroups = customerAnalysis ? getRiskGroups(customerAnalysis) : null;
  const visibleRiskCount = riskGroups
    ? Math.min(riskGroups.risksForUs.length, MAX_RISKS_PER_AUDIENCE) +
      Math.min(riskGroups.risksForCustomer.length, MAX_RISKS_PER_AUDIENCE)
    : Math.min(customerAnalysis?.risks.length ?? 0, MAX_RISKS_PER_AUDIENCE * 2);
  const topImplicitRequirements = customerAnalysis
    ? getTopImplicitRequirements(customerAnalysis.implicit_requirements)
    : [];
  const topSignalWords = customerAnalysis
    ? getTopSignalWords(customerAnalysis)
    : [];
  const hasDocuments = documents.length > 0;

  function getSectionLabel(section: CustomerAnalysisSection) {
    return SECTION_TABS.find((tab) => tab.value === section)?.label ?? section;
  }

  function makeSectionDraft(section: CustomerAnalysisSection) {
    if (!customerAnalysis) {
      return null;
    }

    return cloneEditableSnapshot(
      getCustomerAnalysisSectionSnapshot(customerAnalysis, section),
    );
  }

  function onStartSectionEdit(section: CustomerAnalysisSection) {
    setEditingSection(section);
    setSectionDraft(makeSectionDraft(section));
    setSectionDraftError("");
  }

  function onCancelSectionEdit() {
    setEditingSection(null);
    setSectionDraft(null);
    setSectionDraftError("");
  }

  async function onSaveSectionEdit(section: CustomerAnalysisSection) {
    if (!sectionDraft) {
      setSectionDraftError("Ingen endringer å lagre.");
      return;
    }

    try {
      const snapshot = sanitizeSectionDraft(section, sectionDraft);
      await onSaveAnalysis(
        section,
        snapshot as CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
      );
      setEditingSection(null);
      setSectionDraft(null);
      setSectionDraftError("");
    } catch {
      // runAction owns the user-facing error message in the parent.
    }
  }

  function renderEditButton(section: CustomerAnalysisSection) {
    const isEditing = editingSection === section;

    if (isEditing) {
      return (
        <>
          <Button
            onClick={onCancelSectionEdit}
            disabled={saveBusy}
            variant="ghost"
            size="sm"
          >
            <X data-icon="inline-start" />
            Avbryt
          </Button>
          <Button
            onClick={() => void onSaveSectionEdit(section)}
            disabled={saveBusy || !sectionDraft}
            variant="outline"
            size="sm"
          >
            {saveBusy ? (
              <Spinner className="size-4" />
            ) : (
              <Save data-icon="inline-start" />
            )}
            Lagre
          </Button>
        </>
      );
    }

    return (
      <Button
        onClick={() => onStartSectionEdit(section)}
        disabled={
          busy || saveBusy || Boolean(sectionBusy) || Boolean(editingSection)
        }
        variant="outline"
        size="sm"
      >
        <PencilLine data-icon="inline-start" />
        Rediger
      </Button>
    );
  }

  function renderSectionActions(section: CustomerAnalysisSection) {
    return renderEditButton(section);
  }

  function updateDraft(nextDraft: EditableCustomerAnalysisSnapshot) {
    setSectionDraft(nextDraft);
    setSectionDraftError("");
  }

  function renderTextEditField({
    id,
    label,
    value,
    onChange,
    placeholder,
    rows = 5,
  }: {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    rows?: number;
  }) {
    return (
      <div className="space-y-2">
        <Label
          htmlFor={id}
          className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground"
        >
          {label}
        </Label>
        <Textarea
          id={id}
          value={value}
          rows={rows}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-h-28 resize-y rounded-lg border-primary/20 bg-white text-sm leading-6 text-slate-900 shadow-none"
        />
      </div>
    );
  }

  function renderStringListEditor({
    id,
    label,
    items,
    onChange,
    placeholder,
  }: {
    id: string;
    label: string;
    items: string[];
    onChange: (items: string[]) => void;
    placeholder: string;
  }) {
    return (
      <div className="space-y-3 rounded-lg border border-border/70 bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...items, ""])}
          >
            <Plus data-icon="inline-start" />
            Legg til
          </Button>
        </div>
        {items.length ? (
          <div className="space-y-2.5">
            {items.map((item, index) => (
              <div
                key={`${id}-${index}`}
                className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <Textarea
                  value={item}
                  rows={2}
                  onChange={(event) =>
                    onChange(
                      items.map((current, currentIndex) =>
                        currentIndex === index ? event.target.value : current,
                      ),
                    )
                  }
                  placeholder={placeholder}
                  className="min-h-20 resize-y border-slate-200 bg-white text-sm leading-6 shadow-none"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="self-start text-slate-500 hover:text-red-700"
                  onClick={() =>
                    onChange(items.filter((_, currentIndex) => currentIndex !== index))
                  }
                  aria-label={`Fjern punkt ${index + 1}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-sm text-muted-foreground">
            Ingen punkter ennå.
          </p>
        )}
      </div>
    );
  }

  function renderRequirementListEditor({
    label,
    items,
    onChange,
    defaultKind,
  }: {
    label: string;
    items: AnalysisRequirement[];
    onChange: (items: AnalysisRequirement[]) => void;
    defaultKind: RequirementKind;
  }) {
    return (
      <div className="space-y-3 rounded-lg border border-border/70 bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...items, emptyAnalysisRequirement(defaultKind)])}
          >
            <Plus data-icon="inline-start" />
            Legg til
          </Button>
        </div>
        <div className="space-y-3">
          {items.map((item, index) => {
            const updateItem = (nextItem: AnalysisRequirement) =>
              onChange(
                items.map((current, currentIndex) =>
                  currentIndex === index ? nextItem : current,
                ),
              );

            return (
              <div
                key={`${label}-${index}`}
                className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                    Behov {index + 1}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-slate-500 hover:text-red-700"
                    onClick={() =>
                      onChange(
                        items.filter((_, currentIndex) => currentIndex !== index),
                      )
                    }
                    aria-label={`Fjern behov ${index + 1}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    value={item.title}
                    onChange={(event) =>
                      updateItem({ ...item, title: event.target.value })
                    }
                    placeholder="Tittel"
                  />
                  <Input
                    value={item.category}
                    onChange={(event) =>
                      updateItem({ ...item, category: event.target.value })
                    }
                    placeholder="Kategori"
                  />
                  <select
                    value={item.importance}
                    onChange={(event) =>
                      updateItem({
                        ...item,
                        importance: event.target.value as RequirementImportance,
                      })
                    }
                    className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                  >
                    {REQUIREMENT_IMPORTANCE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <select
                    value={item.kind}
                    onChange={(event) =>
                      updateItem({
                        ...item,
                        kind: event.target.value as RequirementKind,
                      })
                    }
                    className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                  >
                    {REQUIREMENT_KIND_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                {renderTextEditField({
                  id: `${label}-${index}-description`,
                  label: "Beskrivelse",
                  value: item.description,
                  onChange: (value) => updateItem({ ...item, description: value }),
                  placeholder: "Beskriv behovet slik det skal brukes videre.",
                  rows: 3,
                })}
                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    value={item.source_reference}
                    onChange={(event) =>
                      updateItem({
                        ...item,
                        source_reference: event.target.value,
                      })
                    }
                    placeholder="Kildehenvisning"
                  />
                  <Input
                    value={item.source_excerpt}
                    onChange={(event) =>
                      updateItem({ ...item, source_excerpt: event.target.value })
                    }
                    placeholder="Kildeutdrag"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderPrioritizedRequirementsEditor(
    items: CustomerAnalysisSectionSnapshotMap["needs"]["prioritized_requirements"],
    onChange: (
      items: CustomerAnalysisSectionSnapshotMap["needs"]["prioritized_requirements"],
    ) => void,
  ) {
    return (
      <div className="space-y-3 rounded-lg border border-border/70 bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Prioriterte behov
          </Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange([
                ...items,
                { requirement: "", priority: "Viktig", reason: "" },
              ])
            }
          >
            <Plus data-icon="inline-start" />
            Legg til
          </Button>
        </div>
        <div className="space-y-3">
          {items.map((item, index) => {
            const updateItem = (nextItem: (typeof items)[number]) =>
              onChange(
                items.map((current, currentIndex) =>
                  currentIndex === index ? nextItem : current,
                ),
              );

            return (
              <div
                key={`prioritized-${index}`}
                className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                    Prioritet {index + 1}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-slate-500 hover:text-red-700"
                    onClick={() =>
                      onChange(
                        items.filter((_, currentIndex) => currentIndex !== index),
                      )
                    }
                    aria-label={`Fjern prioritert behov ${index + 1}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <select
                  value={item.priority}
                  onChange={(event) =>
                    updateItem({
                      ...item,
                      priority: event.target.value as RequirementImportance,
                    })
                  }
                  className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                >
                  {REQUIREMENT_IMPORTANCE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                {renderTextEditField({
                  id: `prioritized-${index}-requirement`,
                  label: "Behov",
                  value: item.requirement,
                  onChange: (value) => updateItem({ ...item, requirement: value }),
                  placeholder: "Skriv det prioriterte behovet.",
                  rows: 3,
                })}
                {renderTextEditField({
                  id: `prioritized-${index}-reason`,
                  label: "Begrunnelse",
                  value: item.reason,
                  onChange: (value) => updateItem({ ...item, reason: value }),
                  placeholder: "Hvorfor er dette viktig?",
                  rows: 3,
                })}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderKeywordCountsEditor(
    counts: Record<string, number>,
    onChange: (counts: Record<string, number>) => void,
  ) {
    const entries = Object.entries(counts);
    const updateEntries = (nextEntries: Array<[string, number]>) => {
      onChange(
        Object.fromEntries(
          nextEntries.filter(([word]) => word.trim()).map(([word, count]) => [
            word,
            count,
          ]),
        ),
      );
    };

    return (
      <div className="space-y-3 rounded-lg border border-border/70 bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Frekvens
          </Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              updateEntries([...entries, [`Nytt signalord ${entries.length + 1}`, 1]])
            }
          >
            <Plus data-icon="inline-start" />
            Legg til
          </Button>
        </div>
        <div className="space-y-2">
          {entries.map(([word, count], index) => (
            <div
              key={`${word}-${index}`}
              className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 sm:grid-cols-[minmax(0,1fr)_7rem_auto]"
            >
              <Input
                value={word}
                onChange={(event) => {
                  const nextEntries = [...entries] as Array<[string, number]>;
                  nextEntries[index] = [event.target.value, count];
                  updateEntries(nextEntries);
                }}
                placeholder="Signalord"
              />
              <Input
                type="number"
                min={0}
                value={count}
                onChange={(event) => {
                  const nextEntries = [...entries] as Array<[string, number]>;
                  nextEntries[index] = [word, Number(event.target.value)];
                  updateEntries(nextEntries);
                }}
                placeholder="Antall"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-slate-500 hover:text-red-700"
                onClick={() =>
                  updateEntries(
                    entries.filter((_, currentIndex) => currentIndex !== index),
                  )
                }
                aria-label={`Fjern signalord ${index + 1}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderValueOpportunitiesEditor(
    items: ValueOpportunity[],
    onChange: (items: ValueOpportunity[]) => void,
  ) {
    return (
      <div className="space-y-3 rounded-lg border border-border/70 bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Verdimuligheter
          </Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...items, emptyValueOpportunity()])}
          >
            <Plus data-icon="inline-start" />
            Legg til
          </Button>
        </div>
        <div className="space-y-3">
          {items.map((item, index) => {
            const updateItem = (nextItem: ValueOpportunity) =>
              onChange(
                items.map((current, currentIndex) =>
                  currentIndex === index ? nextItem : current,
                ),
              );

            return (
              <div
                key={`value-${index}`}
                className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                    Verdi {index + 1}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-slate-500 hover:text-red-700"
                    onClick={() =>
                      onChange(
                        items.filter((_, currentIndex) => currentIndex !== index),
                      )
                    }
                    aria-label={`Fjern verdi ${index + 1}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_9rem]">
                  <Input
                    value={item.title}
                    onChange={(event) =>
                      updateItem({ ...item, title: event.target.value })
                    }
                    placeholder="Tittel"
                  />
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={item.profit_share_percent}
                    onChange={(event) =>
                      updateItem({
                        ...item,
                        profit_share_percent: Number(event.target.value),
                      })
                    }
                    placeholder="Andel %"
                  />
                </div>
                {renderTextEditField({
                  id: `value-${index}-description`,
                  label: "Beskrivelse",
                  value: item.description,
                  onChange: (value) => updateItem({ ...item, description: value }),
                  placeholder: "Beskriv verdien for kunden.",
                  rows: 3,
                })}
                <div className="flex flex-wrap gap-2">
                  {VALUE_LABELS.map((category) => {
                    const checked = item.value_categories.includes(category);
                    return (
                      <label
                        key={category}
                        className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${
                          checked
                            ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            updateItem({
                              ...item,
                              value_categories: event.target.checked
                                ? [...item.value_categories, category]
                                : item.value_categories.filter(
                                    (current) => current !== category,
                                  ),
                            })
                          }
                          className="size-3.5"
                        />
                        {category}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderSectionDraftFields(section: CustomerAnalysisSection) {
    switch (section) {
      case "summary": {
        const draft = sectionDraft as CustomerAnalysisSectionSnapshotMap["summary"];
        return (
          <>
            {renderTextEditField({
              id: "edit-customer-profile-summary",
              label: "Kundesituasjon",
              value: draft.customer_profile_summary,
              onChange: (value) =>
                updateDraft({ ...draft, customer_profile_summary: value }),
              placeholder: "Beskriv kundens nåsituasjon.",
              rows: 7,
            })}
            {renderTextEditField({
              id: "edit-customer-goals-summary",
              label: "Kundens mål",
              value: draft.customer_goals_summary,
              onChange: (value) =>
                updateDraft({ ...draft, customer_goals_summary: value }),
              placeholder: "Beskriv kundens mål og ønskede retning.",
              rows: 7,
            })}
          </>
        );
      }
      case "strategy": {
        const draft = sectionDraft as CustomerAnalysisSectionSnapshotMap["strategy"];
        return (
          <>
            {renderTextEditField({
              id: "edit-executive-summary",
              label: "Arbeidstekst",
              value: draft.executive_summary,
              onChange: (value) => updateDraft({ ...draft, executive_summary: value }),
              placeholder: "Skriv strategisk oppsummering.",
              rows: 8,
            })}
            {renderStringListEditor({
              id: "edit-positioning-recommendations",
              label: "Posisjoneringsspor",
              items: draft.positioning_recommendations,
              onChange: (items) =>
                updateDraft({ ...draft, positioning_recommendations: items }),
              placeholder: "Skriv anbefaling eller posisjonering.",
            })}
          </>
        );
      }
      case "clarifications": {
        const draft =
          sectionDraft as CustomerAnalysisSectionSnapshotMap["clarifications"];
        return (
          <div>
            {renderStringListEditor({
              id: "edit-ambiguities",
              label: "Avklaringer",
              items: draft.ambiguities,
              onChange: (items) => updateDraft({ ...draft, ambiguities: items }),
              placeholder: "Skriv avklaring eller usikkerhet.",
            })}
          </div>
        );
      }
      case "design": {
        const draft = sectionDraft as CustomerAnalysisSectionSnapshotMap["design"];
        return (
          <>
            {renderTextEditField({
              id: "edit-high-level-design",
              label: "Løsningsdesign",
              value: draft.high_level_solution_design,
              onChange: (value) =>
                updateDraft({ ...draft, high_level_solution_design: value }),
              placeholder: "Beskriv overordnet løsning.",
              rows: 8,
            })}
            {renderTextEditField({
              id: "edit-architecture-diagram",
              label: "Arkitekturdiagram",
              value: draft.high_level_architecture_mermaid,
              onChange: (value) =>
                updateDraft({ ...draft, high_level_architecture_mermaid: value }),
              placeholder: "Mermaid-diagram hvis det finnes.",
              rows: 8,
            })}
          </>
        );
      }
      case "risks": {
        const draft = sectionDraft as CustomerAnalysisSectionSnapshotMap["risks"];
        return (
          <>
            {renderStringListEditor({
              id: "edit-risks",
              label: "Risikoer",
              items: draft.risks,
              onChange: (items) => updateDraft({ ...draft, risks: items }),
              placeholder: "Skriv risiko.",
            })}
            {renderStringListEditor({
              id: "edit-risks-for-us",
              label: "Risiko for oss",
              items: draft.risks_for_us ?? [],
              onChange: (items) => updateDraft({ ...draft, risks_for_us: items }),
              placeholder: "Skriv leverandørrisiko.",
            })}
            {renderStringListEditor({
              id: "edit-risks-for-customer",
              label: "Risiko for kunden",
              items: draft.risks_for_customer ?? [],
              onChange: (items) =>
                updateDraft({ ...draft, risks_for_customer: items }),
              placeholder: "Skriv kunderisiko.",
            })}
          </>
        );
      }
      case "needs": {
        const draft = sectionDraft as CustomerAnalysisSectionSnapshotMap["needs"];
        return (
          <>
            {renderRequirementListEditor({
              label: "Implisitte behov",
              items: draft.implicit_requirements,
              onChange: (items) =>
                updateDraft({ ...draft, implicit_requirements: items }),
              defaultKind: "Implisitt",
            })}
            {renderPrioritizedRequirementsEditor(
              draft.prioritized_requirements,
              (items) => updateDraft({ ...draft, prioritized_requirements: items }),
            )}
          </>
        );
      }
      case "keywords": {
        const draft = sectionDraft as CustomerAnalysisSectionSnapshotMap["keywords"];
        return (
          <>
            {renderStringListEditor({
              id: "edit-signal-words",
              label: "Signalord",
              items: draft.signal_words,
              onChange: (items) => updateDraft({ ...draft, signal_words: items }),
              placeholder: "Skriv signalord.",
            })}
            {renderKeywordCountsEditor(
              draft.signal_word_counts ?? {},
              (counts) => updateDraft({ ...draft, signal_word_counts: counts }),
            )}
          </>
        );
      }
      case "value": {
        const draft = sectionDraft as CustomerAnalysisSectionSnapshotMap["value"];
        return renderValueOpportunitiesEditor(
          draft.value_opportunities,
          (items) => updateDraft({ ...draft, value_opportunities: items }),
        );
      }
    }
  }

  function renderSectionEditor(section: CustomerAnalysisSection) {
    if (editingSection !== section || !sectionDraft) {
      return null;
    }

    return (
      <div className="mb-5 rounded-lg border border-primary/25 bg-primary/5 px-4 py-4">
        <div className="mb-3 min-w-0">
          <p className="text-sm font-semibold text-foreground">
            Rediger {getSectionLabel(section).toLowerCase()}
          </p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Rediger teksten i vanlige felt. Endringen lagres i historikken som
            manuell lagring.
          </p>
        </div>
        <div className="space-y-4">
          {renderSectionDraftFields(section)}
        </div>
        {sectionDraftError ? (
          <p className="mt-2 text-sm text-destructive">{sectionDraftError}</p>
        ) : null}
      </div>
    );
  }

  function renderListToggleButton(isVisible: boolean, onToggle: () => void) {
    return (
      <Button
        type="button"
        variant={isVisible ? "secondary" : "outline"}
        size="sm"
        aria-pressed={isVisible}
        onClick={onToggle}
      >
        <ListChecks data-icon="inline-start" />
        {isVisible ? "Skjul liste" : "Vis liste"}
      </Button>
    );
  }

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      {sectionBusy && busyMessage ? (
        <div className="mb-4">
          <GenerationProgress message={busyMessage} progress={busyProgress} />
        </div>
      ) : null}

      <Tabs
        value={activeSection}
        onValueChange={(value) =>
          setActiveSection(value as (typeof SECTION_TABS)[number]["value"])
        }
        defaultValue="summary"
        className="min-w-0 gap-4"
      >
        <div className="-mx-5 mb-4 overflow-y-hidden border-b border-border/70 bg-background px-5 pt-0 pb-0.5 md:-mx-8 md:px-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
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
            {!customerAnalysis ? (
              <Button
                onClick={onGenerate}
                disabled={busy || Boolean(sectionBusy) || !hasDocuments}
                className="mb-2 max-w-full shrink-0"
              >
                {busy ? (
                  <Spinner className="size-4" />
                ) : (
                  <RefreshCw data-icon="inline-start" />
                )}
                Generer kundeanalyse
              </Button>
            ) : null}
          </div>
        </div>

        {customerAnalysis ? (
          <>
          <TabsContent value="summary" className="mt-0">
            <SectionSurface
              title="Oppsummering av kunden"
              description="En lettere lederlesning som deler kundens nåsituasjon og ønsket retning i korte, tydelige spor."
              icon={Building2}
              action={renderSectionActions("summary")}
            >
              {renderSectionEditor("summary")}
              {summaryPanels.length > 0 ? (
                <div className="space-y-5">
                  <div className="grid min-w-0 gap-4 2xl:grid-cols-2">
                    {summaryPanels.map((panel) => {
                      const Icon = panel.icon;
                      const summaryText = splitLeadSentence(panel.content);

                      return (
                        <div
                          key={panel.key}
                          className={`min-w-0 overflow-hidden rounded-2xl border px-5 py-5 shadow-[0_16px_34px_rgba(15,23,42,0.06)] ${panel.accentClassName}`}
                        >
                          <div className="mb-5 flex items-start gap-3">
                            <div
                              className={`flex size-11 shrink-0 items-center justify-center rounded-xl shadow-sm ${panel.iconClassName}`}
                            >
                              <Icon className="size-5" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-[0.7rem] font-bold uppercase tracking-[0.18em] text-slate-500">
                                {panel.eyebrow}
                              </p>
                              <h4 className="text-base font-semibold text-foreground">
                                {panel.title}
                              </h4>
                              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                                {panel.description}
                              </p>
                            </div>
                          </div>

                          <div className="space-y-4">
                            {panel.bullets.length ? (
                              <div className="rounded-2xl border border-white/80 bg-white/72 px-4 py-4">
                                <p className="mb-3 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-500">
                                  Punktoppsummering
                                </p>
                                <div className="grid gap-2">
                                  {panel.bullets.map((bullet, index) => (
                                    <div
                                      key={`${panel.key}-bullet-${index}`}
                                      className="flex items-start gap-3 rounded-xl bg-slate-50/90 px-3 py-3"
                                    >
                                      <span
                                        className={`mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[0.72rem] font-bold ${panel.chipClassName}`}
                                      >
                                        {index + 1}
                                      </span>
                                      <p className="text-sm leading-6 text-slate-700">
                                        {bullet}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <div className="rounded-2xl border border-white/80 bg-white/88 px-4 py-4 shadow-[0_10px_26px_rgba(15,23,42,0.05)]">
                                <p
                                  className={`text-[1.08rem] leading-7 text-slate-950 ${panel.expandedLeadClassName}`}
                                >
                                  {summaryText.lead || panel.content}
                                </p>
                                {summaryText.body ? (
                                  <MarkdownViewer
                                    content={summaryText.body}
                                    className="analysis-prose mt-3 max-w-none text-[0.98rem] leading-7 text-slate-600"
                                  />
                                ) : null}
                              </div>
                            )}

                            {panel.bullets.length ? (
                              <details className="group rounded-2xl border border-white/80 bg-white/88 px-4 py-4 shadow-[0_10px_26px_rgba(15,23,42,0.05)]">
                                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-left [&::-webkit-details-marker]:hidden">
                                  <div>
                                    <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-500">
                                      Full oppsummering
                                    </p>
                                    <p className="mt-1 text-sm font-semibold text-slate-900">
                                      Vis hovedteksten bak punktene
                                    </p>
                                  </div>
                                  <span className="text-sm font-semibold text-slate-500 transition-transform group-open:rotate-180">
                                    ↓
                                  </span>
                                </summary>

                                <div className="mt-4 border-t border-slate-200/80 pt-4">
                                  <p
                                    className={`text-[1.08rem] leading-7 text-slate-950 ${panel.expandedLeadClassName}`}
                                  >
                                    {summaryText.lead || panel.content}
                                  </p>
                                  {summaryText.body ? (
                                    <MarkdownViewer
                                      content={summaryText.body}
                                      className="analysis-prose mt-3 max-w-none text-[0.98rem] leading-7 text-slate-600"
                                    />
                                  ) : null}
                                </div>
                              </details>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <MarkdownViewer
                  content={customerSummary}
                  className="artifact-markdown text-foreground"
                />
              )}
              <SectionHistoryPanel analysis={customerAnalysis} section="summary" />
            </SectionSurface>
          </TabsContent>

          <TabsContent value="strategy" className="mt-0">
            <SectionSurface
              title="Strategi og posisjonering"
              description="Fra innsikt til vinnende tilbudsfortelling. Én samlet arbeidsflate for tilbudsfortellingen, fra strategisk innledning til konkrete posisjoneringsspor."
              icon={FilePenLine}
              action={renderSectionActions("strategy")}
            >
              {renderSectionEditor("strategy")}
              <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-[linear-gradient(135deg,rgba(248,250,252,0.98),rgba(239,246,255,0.88)_54%,rgba(236,254,255,0.72))] shadow-sm">
                <div className="space-y-5 px-5 py-5">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-white/75 bg-white/62 px-4 py-3 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="rounded-md bg-slate-950 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-white">
                        Arbeidstekst og posisjoneringsspor
                      </span>
                      <span className="rounded-md bg-blue-600/10 px-2.5 py-1 text-xs font-semibold text-blue-800">
                        Kundestyrt
                      </span>
                      <span className="rounded-md bg-emerald-600/10 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                        Bevisbar
                      </span>
                      <span className="rounded-md bg-amber-500/12 px-2.5 py-1 text-xs font-semibold text-amber-800">
                        Handlingsnær
                      </span>
                    </div>
                    <span className="min-w-0 text-sm text-slate-500">
                      Bruk teksten som grunnrytme, og konkretiser retningen i
                      sporene under.
                    </span>
                  </div>

                  <div className="rounded-lg border border-white/80 bg-white/72 px-4 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
                    <MarkdownViewer
                      content={customerAnalysis.executive_summary}
                      className="artifact-markdown max-w-none text-slate-900"
                    />
                  </div>

                  <div className="rounded-lg border border-slate-200/80 bg-white/45 p-4">
                    <PositioningKanban
                      items={customerAnalysis.positioning_recommendations}
                      analysis={customerAnalysis}
                    />
                  </div>
                </div>
              </div>
              <SectionHistoryPanel analysis={customerAnalysis} section="strategy" />
            </SectionSurface>
          </TabsContent>

          <TabsContent value="clarifications" className="mt-0">
            <SectionSurface
              title="Avklaringer"
              description="Spørsmål som må avklares med kunden før strategien gjøres om til endelig løsningsdesign."
              icon={Compass}
              action={renderSectionActions("clarifications")}
            >
              {renderSectionEditor("clarifications")}
              <div className="space-y-5">
                <div className="rounded-[1.35rem] border border-amber-300/80 bg-[#fffdf3] px-5 py-6 shadow-[0_18px_45px_rgba(15,23,42,0.08)] md:px-7">
                  <div className="mb-6 flex items-start gap-4">
                    <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-white shadow-[0_12px_24px_rgba(245,158,11,0.25)]">
                      <ListChecks className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[0.78rem] font-bold uppercase tracking-[0.28em] text-amber-800/75">
                        Kundespørsmål
                      </p>
                      <h4 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
                        Åpne avklaringer
                      </h4>
                    </div>
                  </div>
                  {customerAnalysis.ambiguities.length ? (
                    <div className="grid gap-4 lg:grid-cols-2">
                      {customerAnalysis.ambiguities.map((item, index) => (
                        <div
                          key={`ambiguity-${index}`}
                          className="rounded-xl border border-white/85 bg-white px-5 py-5 shadow-[0_10px_24px_rgba(15,23,42,0.04)]"
                        >
                          <p className="mb-3 text-sm font-bold uppercase tracking-[0.22em] text-amber-700">
                            Avklaring {index + 1}
                          </p>
                          <MarkdownViewer
                            content={item}
                            className="analysis-prose max-w-none text-[1.02rem] leading-8 text-slate-700"
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-amber-300 bg-white/55 px-4 py-4 text-sm leading-6 text-amber-900/70">
                      Ingen åpne avklaringer er identifisert ennå.
                    </p>
                  )}
                </div>
              </div>
            </SectionSurface>
          </TabsContent>

          <TabsContent value="design" className="mt-0">
            <SectionSurface
              title="High-level design av løsningen"
              description="Vis og rediger anbefalt overordnet arkitektur når denne delen er klar."
              icon={Compass}
              action={renderSectionActions("design")}
            >
              {renderSectionEditor("design")}
              {customerAnalysis.high_level_solution_design.trim() ||
              customerAnalysis.high_level_architecture_mermaid.trim() ? (
                <div className="space-y-5">
                  {customerAnalysis.high_level_solution_design.trim() ? (
                    <div className="rounded-xl border border-border/70 bg-background/80 px-5 py-5">
                      <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        Arkitekturretning
                      </p>
                      <MarkdownViewer
                        content={customerAnalysis.high_level_solution_design}
                        className="analysis-prose mt-3 max-w-none text-[1rem] text-foreground"
                      />
                    </div>
                  ) : null}
                  {customerAnalysis.high_level_architecture_mermaid.trim() ? (
                    <div className="rounded-xl border border-border/70 bg-white p-4 shadow-sm">
                      <MermaidDiagram
                        chart={customerAnalysis.high_level_architecture_mermaid}
                        title="Overordnet arkitekturdiagram"
                        downloadName="high-level-arkitektur"
                      />
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-6 py-12 text-center">
                  <p className="text-lg font-semibold text-foreground">
                    Ingen design lagret ennå
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Rediger design-delen når du vil legge inn anbefaling og
                    diagram.
                  </p>
                </div>
              )}
              <SectionHistoryPanel analysis={customerAnalysis} section="design" />
            </SectionSurface>
          </TabsContent>

          <TabsContent value="risks" className="mt-0">
            <SectionSurface
              title={`Risiko og usikkerhet (${visibleRiskCount})`}
              description="Risikobildet er delt mellom hva som kan treffe tilbudsteamet og hva som kan treffe kunden."
              icon={AlertTriangle}
              action={renderSectionActions("risks")}
            >
              {renderSectionEditor("risks")}
              <div className="grid min-w-0 gap-4 2xl:grid-cols-2">
                <RiskAudienceGroup
                  title="Risiko for oss"
                  description="Hva som kan påvirke leveranse, tilbud, kommersiell presisjon eller teamets evne til å vinne og gjennomføre."
                  items={riskGroups?.risksForUs ?? []}
                  emptyText="Ingen tydelig leverandør-/tilbudsrisiko er identifisert i eksisterende analyse."
                  tone={0}
                />
                <RiskAudienceGroup
                  title="Risiko for kunden"
                  description="Hva som kan påvirke kundens drift, sikkerhet, overgang, kostnader, brukeradopsjon eller forvaltning."
                  items={riskGroups?.risksForCustomer ?? []}
                  emptyText="Ingen tydelig kunderisiko er identifisert i eksisterende analyse."
                  tone={1}
                />
              </div>
              <SectionHistoryPanel analysis={customerAnalysis} section="risks" />
            </SectionSurface>
          </TabsContent>

          <TabsContent value="needs" className="mt-0">
            <SectionSurface
              title={`Underliggende behov (${topImplicitRequirements.length} viktigste)`}
              description="De skjulte beslutningsdriverne bak kundens krav, oversatt til tydelige signaler for tilbudsarbeidet."
              icon={ListChecks}
              action={renderSectionActions("needs")}
            >
              {renderSectionEditor("needs")}
              {topImplicitRequirements.length ? (
                <div className="grid min-w-0 gap-4 xl:grid-cols-3">
                  {topImplicitRequirements.map((req, index) => (
                    <NeedSignalCard
                      key={`implicit-${req.title}-${index}`}
                      requirement={req}
                      index={index}
                      projectId={projectId}
                      documents={documents}
                    />
                  ))}
                </div>
              ) : (
                <AnalysisTabEmptyState>
                  Ingen underliggende behov er identifisert ennå.
                </AnalysisTabEmptyState>
              )}
              <SectionHistoryPanel analysis={customerAnalysis} section="needs" />
            </SectionSurface>
          </TabsContent>

          <TabsContent value="keywords" className="mt-0">
            <SectionSurface
              title={`Gjenbrukte nøkkelord (${topSignalWords.length} mest brukte)`}
              description="De mest gjentatte signalordene og tekniske føringene som bør gjenspeiles i språk, løsning og arkitektur."
              icon={Cpu}
              action={
                <>
                  {renderListToggleButton(showKeywordList, () =>
                    setShowKeywordList((isVisible) => !isVisible),
                  )}
                  {renderSectionActions("keywords")}
                </>
              }
            >
              {renderSectionEditor("keywords")}
              {topSignalWords.length ? (
                <>
                  <KeywordPieModule
                    analysis={customerAnalysis}
                    keywords={topSignalWords}
                    selectedIndex={selectedKeywordIndex}
                    onSelect={setSelectedKeywordIndex}
                  />
                  {showKeywordList ? (
                    <div className="space-y-3">
                      {topSignalWords.map((item, index) => (
                        <div
                          key={`${item}-${index}`}
                          className="flex min-w-0 items-center gap-3 border-b border-border/60 pb-3 text-sm text-foreground last:border-b-0 last:pb-0"
                        >
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
                            {(() => {
                              const Icon = getKeywordIcon(item);
                              return <Icon className="size-4.5" />;
                            })()}
                          </div>
                          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3">
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
                  ) : null}
                </>
              ) : (
                <AnalysisTabEmptyState>
                  Ingen gjenbrukte nøkkelord er identifisert ennå.
                </AnalysisTabEmptyState>
              )}
              <SectionHistoryPanel analysis={customerAnalysis} section="keywords" />
            </SectionSurface>
          </TabsContent>

          <TabsContent value="value" className="mt-0">
            <SectionSurface
              title={`Verdimuligheter (${customerAnalysis.value_opportunities.length})`}
              description="Hvor løsningen kan skape tydelig effekt for kunden i form av gevinst, risiko eller opplevelse."
              icon={TrendingUp}
              action={
                <>
                  {renderListToggleButton(showValueList, () =>
                    setShowValueList((isVisible) => !isVisible),
                  )}
                  {renderSectionActions("value")}
                </>
              }
            >
              {renderSectionEditor("value")}
              {customerAnalysis.value_opportunities.length ? (
                <>
                  <ValuePieModule
                    opportunities={valueDisplayItems.map(
                      (item) => item.opportunity,
                    )}
                    profitShares={valueDisplayItems.map(
                      (item) => item.profitShare,
                    )}
                    selectedIndex={selectedValueIndex}
                    onSelect={setSelectedValueIndex}
                  />
                  {showValueList ? (
                    <div className="space-y-4">
                      {valueDisplayItems.map(
                        ({ opportunity: item, profitShare, originalIndex }) => (
                          <div
                            key={`${item.title}-${originalIndex}`}
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
                                {profitShare}% av profitteffekt
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
                        ),
                      )}
                    </div>
                  ) : null}
                </>
              ) : (
                <AnalysisTabEmptyState>
                  Ingen verdimuligheter er identifisert ennå.
                </AnalysisTabEmptyState>
              )}
              <SectionHistoryPanel analysis={customerAnalysis} section="value" />
            </SectionSurface>
          </TabsContent>
          </>
        ) : (
          <>
            {SECTION_TABS.map((tab) => (
              <TabsContent key={tab.value} value={tab.value} className="mt-0">
                <AnalysisTabEmptyState>
                  Ingen analyse ennå. Last opp et dokument og generer analysen.
                </AnalysisTabEmptyState>
              </TabsContent>
            ))}
          </>
        )}
      </Tabs>
    </div>
  );
}
