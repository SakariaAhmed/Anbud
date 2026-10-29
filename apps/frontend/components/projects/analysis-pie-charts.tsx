"use client";

// Donut charts for value categories and keywords in the customer analysis.
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { VALUE_LABELS } from "@/components/projects/project-workspace-shared";
import { type CustomerAnalysisResult } from "@/lib/types";
import { motion, useReducedMotion } from "framer-motion";
import {
  Cloud,
  Cpu,
  Database,
  KeyRound,
  type LucideIcon,
  Shield,
  Workflow,
} from "lucide-react";
import { useState } from "react";

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

export function ValuePieModule({
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

export function KeywordPieModule({
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

export function getKeywordIcon(keyword: string): LucideIcon {
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

export function getKeywordMentionCount(
  analysis: CustomerAnalysisResult,
  keyword: string,
) {
  const count = analysis.signal_word_counts?.[keyword];
  return typeof count === "number" && Number.isFinite(count)
    ? Math.max(1, Math.round(count))
    : 1;
}
