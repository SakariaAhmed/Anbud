"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  Cloud,
  Cpu,
  Database,
  KeyRound,
  ListChecks,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Trash2,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { customerAnalysisPositioningGroups } from "@/lib/customer-analysis-presentation";
import { getCustomerAnalysisSectionSnapshot } from "@/lib/customer-analysis-history";
import {
  isDocumentReadyForEvaluation,
  isHistoricalSolutionDocument,
} from "@/lib/document-processing";
import { normalizeTechnologySignalWords } from "@/lib/signal-words";
import {
  MAX_CUSTOMER_ANALYSIS_CLARIFICATIONS,
  type CustomerAnalysisResult,
  type CustomerAnalysisSection,
  type CustomerAnalysisSectionSnapshotMap,
  type AnalysisRequirement,
  type ProjectDocument,
  type RecommendedService,
  type RequirementImportance,
  type RequirementKind,
  type ValueCategory,
  type ValueOpportunity,
} from "@/lib/types";

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

function emptyRecommendedService(): RecommendedService {
  return {
    service_id: "",
    service_name: "",
    usefulness_percent: 0,
    customer_need: "",
    recommendation_reason: "",
    evidence: "",
    risk_or_caveat: "",
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
    case "services": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["services"];
      return {
        recommended_services: value.recommended_services
          .map((item) => ({
            service_id: item.service_id?.trim() || null,
            service_name: item.service_name.trim(),
            usefulness_percent: Number.isFinite(item.usefulness_percent)
              ? Math.max(0, Math.min(100, Math.round(item.usefulness_percent)))
              : 0,
            customer_need: item.customer_need.trim(),
            recommendation_reason: item.recommendation_reason.trim(),
            evidence: item.evidence.trim(),
            risk_or_caveat: item.risk_or_caveat.trim(),
          }))
          .filter((item) => item.service_name && item.recommendation_reason),
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

function SectionSurface({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="min-w-0 py-3">
      {action ? (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          {action}
        </div>
      ) : null}
      {children}
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
        <motion.div className="relative">
          <svg
            viewBox="0 0 780 380"
            className="w-full overflow-visible"
            aria-label="Kakediagram"
          >
            <g>
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
                      fill={item.color}
                      stroke={isSelected || isHovered ? "rgb(15 23 42)" : "white"}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      className="cursor-pointer outline-none"
                      role="button"
                      aria-pressed={isSelected}
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
          aria-pressed={selectedIndex === index}
          className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
            selectedIndex === index
              ? "border-primary/35 bg-primary/5"
              : "border-border bg-background hover:bg-muted"
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
    <div className="mb-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            Profitteffekt per verdi
          </h4>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          Klikk på en verdi for detaljer
        </span>
      </div>

      <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1.55fr)_minmax(13.5rem,0.45fr)] 2xl:items-start">
        <div className="min-w-0 py-3">
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
                  <p className="text-xs font-semibold tracking-normal text-muted-foreground">
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
    <div className="mb-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            Nøkkelord etter antall nevnt
          </h4>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          Topp 5 signalord
        </span>
      </div>

      <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1.55fr)_minmax(13.5rem,0.45fr)] 2xl:items-start">
        <div className="min-w-0 py-3">
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
                    <p className="text-xs font-semibold tracking-normal text-muted-foreground">
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

function PositioningOverview({
  items,
  worktext,
}: {
  items: string[];
  worktext: string;
}) {
  const groups = customerAnalysisPositioningGroups(items);
  return (
    <div className="space-y-6">
      <div className="grid min-w-0 gap-6 xl:grid-cols-3">
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title} className="analysis-insight min-w-0">
            <h4 className="mb-3 text-base font-semibold">{group.title}</h4>
            {group.items.length ? (
              <ul className="space-y-3">
                {group.items.map((content, index) => (
                  <li key={`${group.title}-${index}`} className="border-t border-slate-200 pt-3">
                    <MarkdownViewer content={content} className="analysis-prose max-w-none text-sm leading-7 text-slate-700" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Ingen anbefalinger i dette sporet ennå.</p>
            )}
          </section>
        ))}
      </div>
      {worktext.trim() ? (
        <details className="border-t border-slate-200 pt-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-600 focus-visible:outline-2 focus-visible:outline-blue-600">Strategisk bakgrunn</summary>
          <MarkdownViewer content={worktext} className="analysis-prose mt-4 max-w-none text-sm leading-7 text-slate-700" />
        </details>
      ) : null}
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
  { value: "clarifications", label: "Avklaringer" },
  { value: "services", label: "Anbefalt tjeneste" },
  { value: "value", label: "Verdi" },
] as const;

function getRecommendedServices(analysis: CustomerAnalysisResult) {
  return [...(analysis.recommended_services ?? [])]
    .filter((item) => item.service_name.trim() && item.recommendation_reason.trim())
    .sort(
      (left, right) =>
        right.usefulness_percent - left.usefulness_percent ||
        left.service_name.localeCompare(right.service_name, "nb"),
    )
    .slice(0, 5);
}

function serviceFitTone(score: number) {
  if (score >= 85) {
    return {
      badgeClassName: "bg-emerald-600 text-white",
      barClassName: "bg-emerald-600",
    };
  }

  if (score >= 65) {
    return {
      badgeClassName: "bg-blue-600 text-white",
      barClassName: "bg-blue-600",
    };
  }

  return {
    badgeClassName: "bg-amber-500 text-white",
    barClassName: "bg-amber-500",
  };
}

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
  projectId,
  documents,
}: {
  requirement: AnalysisRequirement;
  projectId: string;
  documents: ProjectDocument[];
}) {
  const referencedDocument = findDocumentForReference(documents, requirement.source_reference);
  const documentHref = referencedDocument
    ? `/api/projects/${projectId}/documents/${referencedDocument.id}?disposition=inline`
    : null;
  return (
    <article className="analysis-need min-w-0">
      <h5 className="text-sm font-semibold text-slate-950">{requirement.title}</h5>
      <MarkdownViewer content={getNeedAsk(requirement)} className="analysis-prose mt-2 max-w-none text-sm leading-7 text-slate-700" />
      {requirement.source_reference ? (
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Kilde: {documentHref ? (
            <a href={documentHref} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-4">{requirement.source_reference}</a>
          ) : requirement.source_reference}
        </p>
      ) : null}
    </article>
  );
}

export function ProjectAnalysisTab({
  projectId,
  documents,
  customerAnalysis: latestCustomerAnalysis,
  busy,
  saveBusy,
  sectionBusy,
  busyMessage,
  busyProgress,
  onGenerate,
  onSaveAnalysis,
  readOnly = false,
  sourceChanged = false,
}: {
  projectId: string;
  documents: ProjectDocument[];
  customerAnalysis: CustomerAnalysisResult | null;
  busy: boolean;
  saveBusy: boolean;
  sectionBusy: CustomerAnalysisSection | null;
  busyMessage: string;
  busyProgress: number;
  readOnly?: boolean;
  sourceChanged?: boolean;
  onGenerate?: () => void;
  onSaveAnalysis?: (
    section: CustomerAnalysisSection,
    snapshot: CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
    revision?: string,
  ) => Promise<boolean>;
}) {
  const [editingSection, setEditingSection] =
    useState<CustomerAnalysisSection | null>(null);
  const [sectionDraft, setSectionDraft] =
    useState<EditableCustomerAnalysisSnapshot | null>(null);
  const [editingBasis, setEditingBasis] = useState<CustomerAnalysisResult | null>(null);
  const customerAnalysis = latestCustomerAnalysis ?? (editingSection ? editingBasis : null);
  const [sectionRevision, setSectionRevision] = useState<string | undefined>();
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
    if (!customerAnalysis && !editingSection) {
      setActiveSection("summary");
      setEditingSection(null);
      setSectionDraft(null);
      setSectionDraftError("");
    }
  }, [customerAnalysis, editingSection]);

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

  const summaryPanels = customerAnalysis
    ? [
        { key: "profile", title: "Kundesituasjon", content: customerAnalysis.customer_profile_summary },
        { key: "goals", title: "Kundens mål og retning", content: customerAnalysis.customer_goals_summary },
      ].filter((panel) => panel.content.trim())
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
  const topImplicitRequirements = customerAnalysis
    ? getTopImplicitRequirements(customerAnalysis.implicit_requirements)
    : [];
  const topSignalWords = customerAnalysis
    ? getTopSignalWords(customerAnalysis)
    : [];
  const recommendedServices = customerAnalysis
    ? getRecommendedServices(customerAnalysis)
    : [];
  const analysisDocuments = documents.filter(
    (document) =>
      document.role !== "primary_solution_document" &&
      !isHistoricalSolutionDocument(document),
  );
  const hasDocuments = analysisDocuments.length > 0;
  const documentsReady =
    hasDocuments && analysisDocuments.every(isDocumentReadyForEvaluation);

  function getSectionLabel(section: CustomerAnalysisSection) {
    if (section === "needs") return "Behov";
    if (section === "risks") return "Risiko";
    if (section === "keywords") return "Nøkkelord";
    return SECTION_TABS.find((tab) => tab.value === section)?.label ?? "Analyse";
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
    if (readOnly || !onSaveAnalysis) return;
    setEditingBasis(customerAnalysis);
    setSectionRevision(customerAnalysis?.revision);
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
    if (readOnly || !onSaveAnalysis) return;
    if (!sectionDraft) {
      setSectionDraftError("Ingen endringer å lagre.");
      return;
    }

    try {
      const snapshot = sanitizeSectionDraft(section, sectionDraft);
      const saved = await onSaveAnalysis(
        section,
        snapshot as CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
        sectionRevision,
      );
      if (!saved) return;
      setEditingSection(null);
      setSectionDraft(null);
      setSectionDraftError("");
    } catch {
      // runAction owns the user-facing error message in the parent.
    }
  }

  function renderEditButton(section: CustomerAnalysisSection) {
    if (readOnly || !onSaveAnalysis) return null;
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
        className="text-slate-600"
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
          className="text-xs font-bold tracking-normal text-muted-foreground"
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
    maxItems,
  }: {
    id: string;
    label: string;
    items: string[];
    onChange: (items: string[]) => void;
    placeholder: string;
    maxItems?: number;
  }) {
    return (
      <div className="space-y-3 rounded-lg border border-border/70 bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs font-bold tracking-normal text-muted-foreground">
            {label}
          </Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={typeof maxItems === "number" && items.length >= maxItems}
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
          <Label className="text-xs font-bold tracking-normal text-muted-foreground">
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
                  <p className="text-xs font-bold tracking-normal text-slate-500">
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
                    aria-label={`Viktighet for behov ${index + 1}`}
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
                    aria-label={`Kravtype for behov ${index + 1}`}
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
          <Label className="text-xs font-bold tracking-normal text-muted-foreground">
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
                  <p className="text-xs font-bold tracking-normal text-slate-500">
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
                  aria-label={`Prioritet for behov ${index + 1}`}
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
          <Label className="text-xs font-bold tracking-normal text-muted-foreground">
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
              key={`keyword-count-${index}`}
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

  function renderRecommendedServicesEditor(
    items: RecommendedService[],
    onChange: (items: RecommendedService[]) => void,
  ) {
    return (
      <div className="space-y-3 rounded-lg border border-border/70 bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs font-bold tracking-normal text-muted-foreground">
            Anbefalte tjenester
          </Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...items, emptyRecommendedService()])}
          >
            <Plus data-icon="inline-start" />
            Legg til
          </Button>
        </div>
        <div className="space-y-3">
          {items.map((item, index) => {
            const updateItem = (nextItem: RecommendedService) =>
              onChange(
                items.map((current, currentIndex) =>
                  currentIndex === index ? nextItem : current,
                ),
              );

            return (
              <div
                key={`service-${index}`}
                className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-bold tracking-normal text-slate-500">
                    Tjeneste {index + 1}
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
                    aria-label={`Fjern anbefalt tjeneste ${index + 1}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_9rem]">
                  <Input
                    value={item.service_name}
                    onChange={(event) =>
                      updateItem({ ...item, service_name: event.target.value })
                    }
                    placeholder="Tjenestenavn"
                  />
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={item.usefulness_percent}
                    onChange={(event) =>
                      updateItem({
                        ...item,
                        usefulness_percent: Number(event.target.value),
                      })
                    }
                    placeholder="Nytte %"
                  />
                </div>
                <Input
                  value={item.service_id ?? ""}
                  onChange={(event) =>
                    updateItem({ ...item, service_id: event.target.value })
                  }
                  placeholder="Service ID"
                />
                {renderTextEditField({
                  id: `service-${index}-need`,
                  label: "Kundebehov",
                  value: item.customer_need,
                  onChange: (value) => updateItem({ ...item, customer_need: value }),
                  placeholder: "Beskriv behovet tjenesten treffer.",
                  rows: 2,
                })}
                {renderTextEditField({
                  id: `service-${index}-reason`,
                  label: "Hvorfor",
                  value: item.recommendation_reason,
                  onChange: (value) =>
                    updateItem({ ...item, recommendation_reason: value }),
                  placeholder: "Forklar hvorfor tjenesten er nyttig her.",
                  rows: 3,
                })}
                {renderTextEditField({
                  id: `service-${index}-evidence`,
                  label: "Grunnlag",
                  value: item.evidence,
                  onChange: (value) => updateItem({ ...item, evidence: value }),
                  placeholder: "Skriv dokument- eller analysesignal.",
                  rows: 2,
                })}
                {renderTextEditField({
                  id: `service-${index}-caveat`,
                  label: "Forutsetning",
                  value: item.risk_or_caveat,
                  onChange: (value) => updateItem({ ...item, risk_or_caveat: value }),
                  placeholder: "Skriv viktigste avklaring eller avgrensning.",
                  rows: 2,
                })}
              </div>
            );
          })}
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
          <Label className="text-xs font-bold tracking-normal text-muted-foreground">
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
                  <p className="text-xs font-bold tracking-normal text-slate-500">
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
              maxItems: MAX_CUSTOMER_ANALYSIS_CLARIFICATIONS,
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
      case "services": {
        const draft = sectionDraft as CustomerAnalysisSectionSnapshotMap["services"];
        return renderRecommendedServicesEditor(
          draft.recommended_services,
          (items) => updateDraft({ ...draft, recommended_services: items }),
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
            Rediger teksten og lagre endringene.
          </p>
        </div>
        <div className="space-y-4">
          {customerAnalysis?.revision && sectionRevision !== customerAnalysis.revision && (
            <div className="w-full text-sm text-amber-800">
              <p>Analysen er endret. Utkastet ditt er beholdt. Hvis du fortsetter, erstatter utkastet denne seksjonen i siste analyse.</p>
              <Button variant="outline" size="sm" disabled={saveBusy} onClick={() => setSectionRevision(customerAnalysis.revision)}>Bruk siste analyse som grunnlag</Button>
            </div>
          )}
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
        className="min-w-0 gap-0"
      >
        <div className="analysis-tab-rail overflow-hidden border-b border-slate-200 bg-transparent">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="no-scrollbar overflow-x-auto overflow-y-hidden touch-pan-x">
                <TabsList
                  variant="line"
                  className="analysis-tab-list h-auto min-w-max gap-0 rounded-none p-0"
                >
                  {SECTION_TABS.map((tab) => (
                    <TabsTrigger
                      key={tab.value}
                      value={tab.value}
                      className="analysis-tab flex-none"
                    >
                      <span className="analysis-tab-label">{tab.label}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            </div>
            {customerAnalysis ? (
              <div className="analysis-toolbar-actions flex shrink-0 items-center gap-2 py-1.5">
                {activeSection === "value" ? renderListToggleButton(showValueList, () =>
                  setShowValueList((isVisible) => !isVisible),
                ) : null}
                {renderSectionActions(activeSection)}
              </div>
            ) : null}
            {(!customerAnalysis || sourceChanged) && !readOnly && onGenerate ? (
              <Button
                onClick={onGenerate}
                disabled={busy || Boolean(sectionBusy) || !documentsReady}
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
          {(!customerAnalysis || sourceChanged) && hasDocuments && !documentsReady ? (
            <p className="mt-2 text-sm text-slate-500">
              Dokumentgrunnlaget klargjøres. Kundeanalysen kan startes så snart
              dokumentbehandlingen er ferdig.
            </p>
          ) : null}
        </div>

        {customerAnalysis ? (
          <>
          <TabsContent value="summary" className="mt-0">
            <SectionSurface
              title="Oppsummering av kunden"
            >
              {renderSectionEditor("summary")}
              <div className="analysis-summary-columns grid min-w-0 gap-4 lg:grid-cols-2">
                {summaryPanels.map((panel) => (
                  <section key={panel.key} aria-label={panel.title} className="analysis-summary-column min-w-0">
                    <h4 className="mb-3 text-base font-semibold">{panel.title}</h4>
                    <MarkdownViewer content={panel.content} className="analysis-prose max-w-none text-sm leading-7 text-slate-700" />
                  </section>
                ))}
              </div>
              <section aria-label="Underliggende behov" className="analysis-needs mt-8 border-t border-slate-200 pt-6">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-base font-semibold">Behov</h4>
                  {renderSectionActions("needs")}
                </div>
                {renderSectionEditor("needs")}
                {topImplicitRequirements.length ? (
                  <div className="grid min-w-0 gap-5 xl:grid-cols-3">
                    {topImplicitRequirements.map((requirement, index) => (
                      <NeedSignalCard key={`need-${index}`} requirement={requirement} projectId={projectId} documents={documents} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Ingen underliggende behov er identifisert ennå.</p>
                )}

              </section>

            </SectionSurface>
          </TabsContent>

          <TabsContent value="strategy" className="mt-0">
            <SectionSurface
              title="Strategi og posisjonering"

            >
              {renderSectionEditor("strategy")}
              <div className="min-w-0">
                <PositioningOverview
                  items={customerAnalysis.positioning_recommendations}
                  worktext={customerAnalysis.executive_summary}
                />
              </div>

            </SectionSurface>
          </TabsContent>

          <TabsContent value="clarifications" className="mt-0">
            <SectionSurface
              title="Avklaringer"

            >
              {renderSectionEditor("clarifications")}
              {customerAnalysis.ambiguities.length ? (
                <ol className="grid min-w-0 gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {customerAnalysis.ambiguities.slice(0, MAX_CUSTOMER_ANALYSIS_CLARIFICATIONS).map((item, index) => (
                    <li key={`ambiguity-${index}`} className="analysis-insight min-w-0">
                      <h4 className="mb-3 text-base font-semibold">Avklaring {String(index + 1).padStart(2, "0")}</h4>
                      <MarkdownViewer content={item} className="analysis-prose min-w-0 max-w-none text-sm leading-7 text-slate-700" />
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-slate-500">Ingen åpne avklaringer er identifisert ennå.</p>
              )}
            </SectionSurface>
          </TabsContent>

          <TabsContent value="keywords" className="mt-0">
            <SectionSurface
              title={`Gjenbrukte nøkkelord (${topSignalWords.length} mest brukte)`}

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
                            <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
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

          <TabsContent value="services" className="mt-0">
            <SectionSurface
              title={`Anbefalte tjenester (${recommendedServices.length})`}

            >
              {renderSectionEditor("services")}
              {recommendedServices.length ? (
                <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                  {recommendedServices.map((service, index) => {
                    const score = Math.max(
                      0,
                      Math.min(100, Math.round(service.usefulness_percent)),
                    );
                    const tone = serviceFitTone(score);

                    return (
                      <article
                        key={`${service.service_name}-${index}`}
                        className="analysis-service min-w-0 border-t border-slate-200 py-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="min-w-0">
                              <h4 className="text-base font-semibold text-slate-950">
                                {service.service_name}
                              </h4>
                            </div>
                          </div>
                          <span
                            className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${tone.badgeClassName}`}
                          >
                            {score}% nyttig
                          </span>
                        </div>

                        <div className="mt-3 h-1 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className={`h-full rounded-full ${tone.barClassName}`}
                            style={{ width: `${score}%` }}
                          />
                        </div>

                        {service.customer_need.trim() ? (
                          <div className="mt-3">
                            <p className="text-xs font-bold tracking-normal text-slate-500">
                              Kundebehov
                            </p>
                            <p className="mt-1 text-sm leading-6 text-slate-700">
                              {service.customer_need}
                            </p>
                          </div>
                        ) : null}

                        <div className="mt-3">
                          <p className="text-xs font-bold tracking-normal text-slate-500">
                            Hvorfor
                          </p>
                          <MarkdownViewer
                            content={service.recommendation_reason}
                            className="analysis-prose mt-2 max-w-none text-[0.96rem] leading-6 text-slate-700"
                          />
                        </div>

                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          <div className="min-w-0">
                            <p className="text-xs font-bold tracking-normal text-slate-500">
                              Grunnlag
                            </p>
                            <p className="mt-1 text-sm leading-6 text-slate-700">
                              {service.evidence || "Ikke angitt."}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-bold tracking-normal text-slate-500">
                              Forutsetning
                            </p>
                            <p className="mt-1 text-sm leading-6 text-slate-700">
                              {service.risk_or_caveat || "Ikke angitt."}
                            </p>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <AnalysisTabEmptyState>
                  Ingen anbefalte tjenester er identifisert ennå.
                </AnalysisTabEmptyState>
              )}

            </SectionSurface>
          </TabsContent>

          <TabsContent value="value" className="mt-0">
            <SectionSurface
              title={`Verdimuligheter (${customerAnalysis.value_opportunities.length})`}

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
