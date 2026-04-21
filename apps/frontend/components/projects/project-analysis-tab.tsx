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
    askClassName: "border-blue-200 bg-blue-50/78 text-blue-950",
    avoidClassName: "border-slate-200 bg-white/86 text-slate-800",
    badgeClassName: "bg-blue-600/10 text-blue-800",
  },
  {
    railClassName: "from-emerald-600 via-emerald-500 to-teal-500",
    iconClassName: "bg-emerald-600 text-white",
    askClassName: "border-emerald-200 bg-emerald-50/78 text-emerald-950",
    avoidClassName: "border-slate-200 bg-white/86 text-slate-800",
    badgeClassName: "bg-emerald-600/10 text-emerald-800",
  },
  {
    railClassName: "from-amber-500 via-orange-400 to-rose-400",
    iconClassName: "bg-amber-500 text-white",
    askClassName: "border-amber-200 bg-amber-50/80 text-amber-950",
    avoidClassName: "border-slate-200 bg-white/86 text-slate-800",
    badgeClassName: "bg-amber-500/12 text-amber-800",
  },
] as const;

const RISK_AUDIENCE_STYLES = [
  {
    eyebrow: "Leveranserisiko",
    iconClassName: "bg-amber-500 text-white",
    shellClassName:
      "border-amber-200/70 bg-[linear-gradient(135deg,rgba(255,251,235,0.72),rgba(255,255,255,0.92)_42%,rgba(248,250,252,0.88))]",
    numberClassName: "bg-amber-500/12 text-amber-800",
    accentClassName: "bg-amber-500",
  },
  {
    eyebrow: "Kunderisiko",
    iconClassName: "bg-blue-600 text-white",
    shellClassName:
      "border-blue-200/70 bg-[linear-gradient(135deg,rgba(239,246,255,0.78),rgba(255,255,255,0.92)_42%,rgba(240,253,250,0.62))]",
    numberClassName: "bg-blue-600/10 text-blue-800",
    accentClassName: "bg-blue-600",
  },
] as const;

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

function polarPoint(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number,
) {
  const angleInRadians = (angleInDegrees * Math.PI) / 180;

  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeDonutSegment(
  centerX: number,
  centerY: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
) {
  const safeEndAngle = Math.min(endAngle, startAngle + 359.99);
  const outerStart = polarPoint(centerX, centerY, outerRadius, startAngle);
  const outerEnd = polarPoint(centerX, centerY, outerRadius, safeEndAngle);
  const innerStart = polarPoint(centerX, centerY, innerRadius, startAngle);
  const innerEnd = polarPoint(centerX, centerY, innerRadius, safeEndAngle);
  const largeArcFlag = safeEndAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function DonutChart({
  data,
  selectedIndex,
  onSelect,
  valueSuffix,
  emptyLabel,
}: {
  data: PieDatum[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  valueSuffix: string;
  emptyLabel: string;
}) {
  const { data: normalizedData, total } = normalizePieData(data);
  const center = 60;
  const outerRadius = 50;
  const innerRadius = 34;
  let accumulated = 0;
  const selected =
    selectedIndex === null ? null : normalizedData[selectedIndex] ?? null;

  return (
    <div className="relative mx-auto size-64 max-w-full">
      <svg
        viewBox="0 0 120 120"
        className="size-full overflow-visible"
        aria-label="Kakediagram"
      >
        <circle
          cx={center}
          cy={center}
          r={(outerRadius + innerRadius) / 2}
          fill="none"
          stroke="rgb(226, 232, 240)"
          strokeWidth={outerRadius - innerRadius}
        />
        {normalizedData.map((item, index) => {
          const share = item.value / total;
          const startAngle = accumulated * 360 - 90;
          const endAngle = (accumulated + share) * 360 - 90;
          const isSelected = selectedIndex === index;
          const hasSelection = selectedIndex !== null;
          accumulated += share;

          return (
            <path
              key={item.id}
              d={describeDonutSegment(
                center,
                center,
                outerRadius,
                innerRadius,
                startAngle,
                endAngle,
              )}
              fill={item.color}
              className="cursor-pointer transition-all duration-200 outline-none hover:opacity-90 focus-visible:opacity-90"
              opacity={!hasSelection || isSelected ? 1 : 0.72}
              style={{
                filter: isSelected
                  ? "drop-shadow(0 4px 8px rgba(15, 23, 42, 0.16))"
                  : undefined,
              }}
              role="button"
              tabIndex={0}
              focusable="true"
              aria-label={`${item.label}: ${item.value}${valueSuffix}`}
              onClick={() => onSelect(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(index);
                }
              }}
            />
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {selected ? "Valgt" : "Velg"}
        </span>
        <span className="mt-1 max-w-32 text-sm font-semibold leading-5 text-foreground">
          {selected?.label ?? emptyLabel}
        </span>
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
  onSelect: (index: number) => void;
  valueSuffix: string;
}) {
  return (
    <div className="space-y-2">
      {data.map((item, index) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(index)}
          className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
            selectedIndex === index
              ? "border-primary/45 bg-primary/5"
              : "border-border/70 bg-background/60 hover:bg-muted/50"
          }`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="truncate text-sm font-medium text-foreground">
              {item.label}
            </span>
          </span>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
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
  onSelect: (index: number) => void;
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

  if (!opportunities.length) {
    return null;
  }

  return (
    <div className="mb-6 rounded-xl border border-border/70 bg-background/75 p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Kakefordeling
          </p>
          <h4 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-foreground">
            Profitteffekt per verdi
          </h4>
        </div>
        <span className="rounded-md border border-border/70 bg-card px-2.5 py-1 text-xs font-semibold text-muted-foreground">
          Klikk på en verdi for detaljer
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <DonutChart
          data={chartData}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          valueSuffix="%"
          emptyLabel="Klikk en verdi"
        />
        <div className="space-y-4">
          <PieLegend
            data={chartData}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            valueSuffix="%"
          />
          {selected ? (
            <div className="rounded-lg border border-border/70 bg-card px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Valgt verdi
                  </p>
                  <p
                    className="mt-1 text-xl font-semibold tracking-[-0.02em]"
                    style={{
                      color: selectedCategory
                        ? VALUE_CATEGORY_COLORS[selectedCategory]
                        : undefined,
                    }}
                  >
                    {selectedCategory ?? selected.title}
                  </p>
                </div>
                <span className="rounded-md bg-primary/10 px-2.5 py-1 text-sm font-semibold text-primary">
                  {selectedShare}% av profitteffekt
                </span>
              </div>
              <details className="mt-4 group">
                <summary className="cursor-pointer list-none text-sm font-medium text-foreground/70 underline underline-offset-4 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  Les mer
                </summary>
                <div className="mt-3">
                  <MarkdownViewer
                    content={selected.description}
                    className="analysis-prose text-[0.98rem] text-muted-foreground"
                  />
                </div>
              </details>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/80 bg-card/60 px-4 py-4 text-sm leading-6 text-muted-foreground">
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
  onSelect: (index: number) => void;
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
    <div className="mb-6 rounded-xl border border-border/70 bg-background/75 p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Kakefordeling
          </p>
          <h4 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-foreground">
            Nøkkelord etter antall nevnt
          </h4>
        </div>
        <span className="rounded-md border border-border/70 bg-card px-2.5 py-1 text-xs font-semibold text-muted-foreground">
          Topp 5 signalord
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <DonutChart
          data={chartData}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          valueSuffix="x"
          emptyLabel="Klikk et ord"
        />
        <div className="space-y-4">
          <PieLegend
            data={chartData}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            valueSuffix="x"
          />
          {selectedKeyword && KeywordIcon ? (
            <div className="rounded-lg border border-border/70 bg-card px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
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
                  <div>
                    <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Valgt nøkkelord
                    </p>
                    <p className="mt-1 text-xl font-semibold tracking-[-0.02em] text-foreground">
                      {selectedKeyword}
                    </p>
                  </div>
                </div>
                <span className="rounded-md bg-primary/10 px-2.5 py-1 text-sm font-semibold text-primary">
                  {selectedCount}x · {selectedShare}% av topp 5
                </span>
              </div>
              <details className="mt-4 group">
                <summary className="cursor-pointer list-none text-sm font-medium text-foreground/70 underline underline-offset-4 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  Les mer
                </summary>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Nøkkelordet er brukt {selectedCount} ganger i analysert
                  grunnlag. Bruk dette som språk- og arkitektursignal i
                  løsningsbeskrivelsen, spesielt der kunden forventer gjenkjennelig
                  terminologi og tydelig kobling til dokumentgrunnlaget.
                </p>
              </details>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/80 bg-card/60 px-4 py-4 text-sm leading-6 text-muted-foreground">
              Velg et nøkkelord i kaken eller listen for å se detaljer.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PositioningKanban({ items }: { items: string[] }) {
  const lanes = POSITIONING_LANES.map((lane, laneIndex) => ({
    ...lane,
    items: items
      .map((content, index) => ({ content, index }))
      .filter(({ index }) => index % POSITIONING_LANES.length === laneIndex),
  })).filter((lane) => lane.items.length > 0);

  return (
    <div className="overflow-x-auto pb-1">
      <div className="grid min-w-[46rem] gap-4 lg:min-w-0 lg:grid-cols-2 xl:grid-cols-4">
        {lanes.map((lane) => {
          const Icon = lane.icon;
          return (
            <section
              key={lane.title}
              className={`flex min-h-64 flex-col rounded-xl border p-3 shadow-sm ${lane.className}`}
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <div
                    className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${lane.iconClassName}`}
                  >
                    <Icon className="size-4.5" />
                  </div>
                  <div>
                    <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] opacity-65">
                      {lane.eyebrow}
                    </p>
                    <h5 className="mt-0.5 text-base font-semibold tracking-[-0.02em]">
                      {lane.title}
                    </h5>
                  </div>
                </div>
                <span
                  className={`rounded-md px-2 py-1 text-xs font-semibold ${lane.badgeClassName}`}
                >
                  {lane.items.length}
                </span>
              </div>

              <div className="flex flex-1 flex-col gap-3">
                {lane.items.map(({ content, index }) => (
                  <article
                    key={`positioning-kanban-${index}`}
                    className="rounded-lg border border-white/70 bg-white/82 px-4 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.06)] backdrop-blur-sm transition-transform hover:-translate-y-0.5"
                  >
                    <MarkdownViewer
                      content={content}
                      className="analysis-prose max-w-none text-[0.98rem] leading-7 text-slate-800"
                    />
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
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
  tone,
}: {
  title: string;
  description: string;
  items: string[];
  emptyText: string;
  tone: 0 | 1;
}) {
  const style = RISK_AUDIENCE_STYLES[tone];

  return (
    <div
      className={`overflow-hidden rounded-xl border shadow-[0_14px_36px_rgba(15,23,42,0.06)] ${style.shellClassName}`}
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
      {items.length ? (
        <div className="space-y-3 px-5 py-5 md:px-6">
          {items.map((item, index) => {
            const riskText = splitLeadSentence(item);

            return (
              <article
                key={`${title}-${index}`}
                className="relative overflow-hidden rounded-lg border border-slate-200/80 bg-white/88 px-4 py-4"
              >
                <span
                  className={`absolute inset-y-0 left-0 w-1 ${style.accentClassName}`}
                />
                <div className="mb-3 flex items-center gap-2 pl-2">
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

function NeedSignalCard({
  requirement,
  index,
}: {
  requirement: CustomerAnalysisResult["implicit_requirements"][number];
  index: number;
}) {
  const style = NEED_CARD_STYLES[index % NEED_CARD_STYLES.length];

  return (
    <article className="relative overflow-hidden rounded-xl border border-slate-200/80 bg-white/88 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
      <div
        className={`absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b ${style.railClassName}`}
      />
      <div className="px-5 py-5 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={`flex size-11 shrink-0 items-center justify-center rounded-lg shadow-sm ${style.iconClassName}`}
            >
              <ListChecks className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold ${style.badgeClassName}`}
                >
                  Behov {index + 1}
                </span>
                <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                  {requirement.category}
                </span>
                <span className="rounded-md bg-slate-950 px-2.5 py-1 text-xs font-semibold text-white">
                  {requirement.importance}
                </span>
              </div>
              <h4 className="text-xl font-semibold tracking-[-0.03em] text-slate-950">
                {requirement.title}
              </h4>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className={`rounded-lg border px-4 py-4 ${style.askClassName}`}>
            <div className="mb-3 flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-md bg-white/82">
                <Target className="size-4" />
              </div>
              <p className="text-[0.72rem] font-bold uppercase tracking-[0.16em] opacity-70">
                Kunden spør egentlig om
              </p>
            </div>
            <MarkdownViewer
              content={getNeedAsk(requirement)}
              className="analysis-prose max-w-none text-[1.04rem] font-medium leading-8"
            />
          </div>

          <div className={`rounded-lg border px-4 py-4 ${style.avoidClassName}`}>
            <div className="mb-3 flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-md bg-slate-100 text-slate-700">
                <Shield className="size-4" />
              </div>
              <p className="text-[0.72rem] font-bold uppercase tracking-[0.16em] text-slate-500">
                Ikke posisjonér som
              </p>
            </div>
            <MarkdownViewer
              content={inferNeedAntiPositioning(requirement)}
              className="analysis-prose max-w-none text-[1.02rem] leading-8 text-slate-700"
            />
          </div>
        </div>

        <details className="group mt-4 rounded-lg border border-slate-200/80 bg-slate-50/70 px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-slate-600 transition-colors hover:text-slate-950 [&::-webkit-details-marker]:hidden">
            <span>Grunnlag og kilde</span>
            <span className="text-xs text-slate-400 transition-transform group-open:rotate-180">
              ↓
            </span>
          </summary>
          <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
            <MarkdownViewer
              content={requirement.description}
              className="analysis-prose max-w-none text-[1rem] leading-7 text-slate-600"
            />
            {requirement.source_reference || requirement.source_excerpt ? (
              <p className="text-sm leading-6 text-slate-500">
                {requirement.source_reference || "Ingen referanse"} ·{" "}
                {requirement.source_excerpt || ""}
              </p>
            ) : null}
          </div>
        </details>
      </div>
    </article>
  );
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
  const [selectedValueIndex, setSelectedValueIndex] = useState<number | null>(
    null,
  );
  const [selectedKeywordIndex, setSelectedKeywordIndex] = useState<
    number | null
  >(null);
  const [showKeywordList, setShowKeywordList] = useState(false);
  const [showValueList, setShowValueList] = useState(false);

  useEffect(() => {
    setAnalysisDraft(customerAnalysis?.executive_summary ?? "");
  }, [customerAnalysis?.executive_summary]);

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
              description="Én samlet arbeidsflate for tilbudsfortellingen, fra strategisk innledning til konkrete posisjoneringsspor."
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
              <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-[linear-gradient(135deg,rgba(248,250,252,0.98),rgba(239,246,255,0.88)_54%,rgba(236,254,255,0.72))] shadow-sm">
                <div className="border-b border-slate-200/80 px-5 py-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white shadow-sm">
                        <FilePenLine className="size-5" />
                      </div>
                      <div>
                        <p className="text-[0.7rem] font-bold uppercase tracking-[0.18em] text-primary/70">
                          Strategisk retning
                        </p>
                        <h4 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-slate-950">
                          Fra innsikt til vinnende tilbudsfortelling
                        </h4>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
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
                  </div>
                </div>

                <div className="space-y-5 px-5 py-5">
                  <div className="rounded-lg border border-white/80 bg-white/72 px-4 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                      <span className="rounded-md bg-slate-950 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-white">
                        Arbeidstekst
                      </span>
                      <span className="text-sm text-slate-500">
                        Brukes som grunnrytme for løsningsutkastet.
                      </span>
                    </div>
                    {isEditingAnalysis ? (
                      <Textarea
                        value={analysisDraft}
                        onChange={(event) => setAnalysisDraft(event.target.value)}
                        className="min-h-72 resize-y rounded-lg border-slate-200 bg-white/90 px-4 py-4 text-[1.02rem] leading-8 text-slate-900 shadow-none"
                      />
                    ) : (
                      <div>
                        <MarkdownViewer
                          content={analysisDraft}
                          className="artifact-markdown max-w-none text-slate-900"
                        />
                      </div>
                    )}
                  </div>

                  {customerAnalysis.positioning_recommendations.length ? (
                    <div className="rounded-lg border border-slate-200/80 bg-white/45 p-4">
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <span className="rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
                          Posisjoneringsspor
                        </span>
                        <span className="text-sm text-slate-500">
                          Konkretiser retningen som kort teamet kan arbeide fra.
                        </span>
                      </div>
                      <PositioningKanban
                        items={customerAnalysis.positioning_recommendations}
                      />
                    </div>
                  ) : null}
                </div>
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
            </SectionSurface>
          </TabsContent>

          <TabsContent value="needs" className="mt-0">
            <SectionSurface
              title={`Underliggende behov (${topImplicitRequirements.length} viktigste)`}
              description="De skjulte beslutningsdriverne bak kundens krav, oversatt til tydelige signaler for tilbudsarbeidet."
              icon={ListChecks}
              action={renderRegenerateButton("needs")}
            >
              {topImplicitRequirements.length ? (
                <div className="space-y-4">
                  {topImplicitRequirements.map((req, index) => (
                    <NeedSignalCard
                      key={`implicit-${req.title}-${index}`}
                      requirement={req}
                      index={index}
                    />
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
              action={
                <>
                  {renderListToggleButton(showKeywordList, () =>
                    setShowKeywordList((isVisible) => !isVisible),
                  )}
                  {renderRegenerateButton("keywords")}
                </>
              }
            >
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
                  ) : null}
                </>
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
              action={
                <>
                  {renderListToggleButton(showValueList, () =>
                    setShowValueList((isVisible) => !isVisible),
                  )}
                  {renderRegenerateButton("value")}
                </>
              }
            >
              {customerAnalysis.value_opportunities.length ? (
                <>
                  <ValuePieModule
                    opportunities={customerAnalysis.value_opportunities}
                    profitShares={profitShares}
                    selectedIndex={selectedValueIndex}
                    onSelect={setSelectedValueIndex}
                  />
                  {showValueList ? (
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
                  ) : null}
                </>
              ) : (
                <AnalysisTabEmptyState>
                  Ingen verdimuligheter er identifisert ennå.
                </AnalysisTabEmptyState>
              )}
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
