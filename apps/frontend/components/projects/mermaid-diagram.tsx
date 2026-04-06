"use client";

import { useEffect, useId, useState } from "react";
import { Download, ImageDown, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

type TechnologyKind =
  | "microsoft"
  | "azure"
  | "identity"
  | "integration"
  | "data"
  | "monitoring"
  | "backup"
  | "security"
  | "business"
  | "openai";

type TechnologyMeta = {
  key: string;
  label: string;
  kind: TechnologyKind;
  vendor?: "microsoft";
  match: RegExp;
  fill: string;
  stroke: string;
};

const TECHNOLOGIES: TechnologyMeta[] = [
  {
    key: "azure",
    label: "Microsoft Azure",
    kind: "azure",
    vendor: "microsoft",
    match: /\bazure\b|landing zone|skyplattform/i,
    fill: "#e0f2fe",
    stroke: "#0284c7",
  },
  {
    key: "entra",
    label: "Microsoft Entra ID",
    kind: "identity",
    vendor: "microsoft",
    match: /entra|active directory|microsoft 365/i,
    fill: "#eef2ff",
    stroke: "#6366f1",
  },
  {
    key: "power-bi",
    label: "Power BI",
    kind: "business",
    vendor: "microsoft",
    match: /power bi/i,
    fill: "#fef3c7",
    stroke: "#d97706",
  },
  {
    key: "openai",
    label: "Azure OpenAI",
    kind: "openai",
    vendor: "microsoft",
    match: /openai|chatgpt/i,
    fill: "#f3f4f6",
    stroke: "#111827",
  },
  {
    key: "identity",
    label: "Identitet og tilgang",
    kind: "identity",
    match: /iam|mfa|rbac|tilgang|identitet|rolle/i,
    fill: "#eef2ff",
    stroke: "#4f46e5",
  },
  {
    key: "integration",
    label: "API og integrasjoner",
    kind: "integration",
    match: /api|integrasjon|id-porten|noark/i,
    fill: "#ecfeff",
    stroke: "#0891b2",
  },
  {
    key: "data",
    label: "Data og lagring",
    kind: "data",
    match: /data|lagring|database/i,
    fill: "#f3e8ff",
    stroke: "#9333ea",
  },
  {
    key: "monitoring",
    label: "Overvåking og logging",
    kind: "monitoring",
    match: /monitor|overvåking|logging|sporbar|hendelse|app insights/i,
    fill: "#ecfccb",
    stroke: "#65a30d",
  },
  {
    key: "backup",
    label: "Backup og gjenoppretting",
    kind: "backup",
    match: /backup|gjenoppretting|restore/i,
    fill: "#ffedd5",
    stroke: "#ea580c",
  },
  {
    key: "security",
    label: "Sikkerhet og styring",
    kind: "security",
    match: /policy|governance|sikkerhet|kontroll/i,
    fill: "#fee2e2",
    stroke: "#dc2626",
  },
  {
    key: "business",
    label: "Applikasjoner og brukere",
    kind: "business",
    match: /erp|wms|crm|bruker|ansatte|arbeidslast|applikasjon|dev ?\/ ?test ?\/ ?prod/i,
    fill: "#f8fafc",
    stroke: "#475569",
  },
];

function normalizeLabel(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function getTechnologyMeta(label: string) {
  const normalized = normalizeLabel(label);
  return TECHNOLOGIES.find((item) => item.match.test(normalized)) ?? null;
}

function getNodeLabel(node: Element) {
  const texts = Array.from(node.querySelectorAll("text"))
    .map((element) => normalizeLabel(element.textContent || ""))
    .filter(Boolean);
  return normalizeLabel(texts.join(" "));
}

function createSvgElement<T extends keyof SVGElementTagNameMap>(
  doc: XMLDocument,
  name: T,
  attrs: Record<string, string>,
) {
  const element = doc.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, value);
  }
  return element;
}

function appendBadgeIcon(doc: XMLDocument, root: SVGGElement, meta: TechnologyMeta) {
  if (meta.vendor === "microsoft") {
    const colors = ["#f25022", "#7fba00", "#00a4ef", "#ffb900"];
    const positions = [
      [0, 0],
      [7, 0],
      [0, 7],
      [7, 7],
    ];
    positions.forEach(([x, y], index) => {
      root.appendChild(
        createSvgElement(doc, "rect", {
          x: String(x),
          y: String(y),
          width: "5",
          height: "5",
          rx: "1.1",
          fill: colors[index] || "#64748b",
        }),
      );
    });
    return;
  }

  switch (meta.kind) {
    case "azure":
      root.appendChild(
        createSvgElement(doc, "path", {
          d: "M1 14 L7.8 1 L14 14 L10 14 L8 9.4 L5.6 14 Z",
          fill: "#0ea5e9",
        }),
      );
      break;
    case "identity":
      root.appendChild(
        createSvgElement(doc, "path", {
          d: "M8 1 L13 3.2 V7.6 C13 10.7 10.9 13.3 8 14.4 C5.1 13.3 3 10.7 3 7.6 V3.2 Z",
          fill: "#4f46e5",
        }),
      );
      break;
    case "integration":
      root.appendChild(
        createSvgElement(doc, "circle", {
          cx: "3",
          cy: "8",
          r: "2",
          fill: "#0891b2",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "circle", {
          cx: "13",
          cy: "3",
          r: "2",
          fill: "#0891b2",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "circle", {
          cx: "13",
          cy: "13",
          r: "2",
          fill: "#0891b2",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "path", {
          d: "M5 8 L11 3.8 M5 8 L11 12.2",
          stroke: "#0891b2",
          "stroke-width": "1.5",
          fill: "none",
          "stroke-linecap": "round",
        }),
      );
      break;
    case "data":
      root.appendChild(
        createSvgElement(doc, "ellipse", {
          cx: "8",
          cy: "3.5",
          rx: "4.8",
          ry: "2.1",
          fill: "#a855f7",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "rect", {
          x: "3.2",
          y: "3.5",
          width: "9.6",
          height: "7.3",
          fill: "#a855f7",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "ellipse", {
          cx: "8",
          cy: "10.8",
          rx: "4.8",
          ry: "2.1",
          fill: "#9333ea",
        }),
      );
      break;
    case "monitoring":
      root.appendChild(
        createSvgElement(doc, "path", {
          d: "M1.5 8 H4.5 L6.3 4.8 L8.6 11.2 L10.6 7.2 H14.5",
          stroke: "#65a30d",
          "stroke-width": "1.7",
          fill: "none",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      );
      break;
    case "backup":
      root.appendChild(
        createSvgElement(doc, "path", {
          d: "M8 2 A6 6 0 1 1 3.2 4.5",
          stroke: "#ea580c",
          "stroke-width": "1.6",
          fill: "none",
          "stroke-linecap": "round",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "path", {
          d: "M2.2 1.8 V5.6 H6",
          stroke: "#ea580c",
          "stroke-width": "1.6",
          fill: "none",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      );
      break;
    case "security":
      root.appendChild(
        createSvgElement(doc, "rect", {
          x: "4",
          y: "7",
          width: "8",
          height: "6",
          rx: "1.8",
          fill: "#dc2626",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "path", {
          d: "M5.6 7 V5.8 A2.4 2.4 0 0 1 10.4 5.8 V7",
          stroke: "#dc2626",
          "stroke-width": "1.5",
          fill: "none",
          "stroke-linecap": "round",
        }),
      );
      break;
    case "openai":
      root.appendChild(
        createSvgElement(doc, "circle", {
          cx: "8",
          cy: "8",
          r: "6",
          fill: "#111827",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "text", {
          x: "8",
          y: "11",
          "text-anchor": "middle",
          "font-size": "6",
          "font-weight": "700",
          fill: "#ffffff",
        }),
      ).appendChild(doc.createTextNode("AI"));
      break;
    case "business":
    default:
      root.appendChild(
        createSvgElement(doc, "rect", {
          x: "2.2",
          y: "3",
          width: "11.6",
          height: "8.8",
          rx: "2",
          fill: "#334155",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "rect", {
          x: "4.2",
          y: "5.2",
          width: "3.2",
          height: "3.2",
          rx: "0.8",
          fill: "#ffffff",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "rect", {
          x: "8.2",
          y: "5.2",
          width: "3.2",
          height: "1.3",
          rx: "0.6",
          fill: "#ffffff",
        }),
      );
      root.appendChild(
        createSvgElement(doc, "rect", {
          x: "8.2",
          y: "7.2",
          width: "3.2",
          height: "1.3",
          rx: "0.6",
          fill: "#ffffff",
        }),
      );
      break;
  }
}

function enhanceRenderedSvg(svgMarkup: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
  const root = doc.documentElement;
  const found = new Map<string, TechnologyMeta>();

  Array.from(root.querySelectorAll("g.node")).forEach((node) => {
    const label = getNodeLabel(node);
    const meta = getTechnologyMeta(label);
    if (!meta) return;
    found.set(meta.key, meta);

    const shape = node.querySelector("rect, polygon, path, circle, ellipse");
    if (shape) {
      shape.setAttribute("fill", meta.fill);
      shape.setAttribute("stroke", meta.stroke);
      shape.setAttribute("stroke-width", "1.6");
    }

    const textElements = Array.from(node.querySelectorAll("text"));
    textElements.forEach((textElement) => {
      textElement.setAttribute("fill", "#0f172a");
      textElement.setAttribute("font-weight", "600");
    });

    const rect = node.querySelector("rect");
    if (!rect || node.querySelector("[data-tech-badge='true']")) {
      return;
    }

    const x = Number(rect.getAttribute("x") || "0");
    const y = Number(rect.getAttribute("y") || "0");
    const badge = createSvgElement(doc, "g", {
      transform: `translate(${x + 8} ${y + 8})`,
      "data-tech-badge": "true",
    });
    badge.appendChild(
      createSvgElement(doc, "rect", {
        x: "0",
        y: "0",
        width: "16",
        height: "16",
        rx: "4.5",
        fill: "#ffffff",
        stroke: meta.stroke,
        "stroke-width": "1",
        opacity: "0.96",
      }),
    );
    appendBadgeIcon(doc, badge, meta);
    node.appendChild(badge);
  });

  return {
    svg: new XMLSerializer().serializeToString(root),
    technologies: Array.from(found.values()),
  };
}

function MicrosoftGlyph({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <rect x="1" y="1" width="6" height="6" rx="1" fill="#f25022" />
      <rect x="9" y="1" width="6" height="6" rx="1" fill="#7fba00" />
      <rect x="1" y="9" width="6" height="6" rx="1" fill="#00a4ef" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="#ffb900" />
    </svg>
  );
}

function AzureGlyph({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d="M1.3 15 8 1l6.7 14H10.2L8 10.2 5.5 15Z" fill="#0ea5e9" />
    </svg>
  );
}

function GenericGlyph({
  kind,
  className = "size-4",
}: {
  kind: TechnologyKind;
  className?: string;
}) {
  switch (kind) {
    case "openai":
      return (
        <div
          className={`${className} inline-flex items-center justify-center rounded-full bg-slate-900 text-[9px] font-bold text-white`}
        >
          AI
        </div>
      );
    case "identity":
      return <Sparkles className={className} />;
    case "integration":
      return (
        <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
          <circle cx="3" cy="8" r="2.1" fill="#0891b2" />
          <circle cx="13" cy="3" r="2.1" fill="#0891b2" />
          <circle cx="13" cy="13" r="2.1" fill="#0891b2" />
          <path d="M5.1 8 10.8 4.2M5.1 8l5.7 3.8" stroke="#0891b2" strokeWidth="1.5" />
        </svg>
      );
    case "data":
      return (
        <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
          <ellipse cx="8" cy="3.5" rx="5" ry="2.2" fill="#a855f7" />
          <rect x="3" y="3.5" width="10" height="7.5" fill="#a855f7" />
          <ellipse cx="8" cy="11" rx="5" ry="2.2" fill="#9333ea" />
        </svg>
      );
    case "monitoring":
      return (
        <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
          <path
            d="M1.5 8h3l1.8-3.2 2.3 6.4 2-4h3.7"
            stroke="#65a30d"
            strokeWidth="1.7"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "backup":
      return (
        <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
          <path
            d="M8 2a6 6 0 1 1-4.8 2.5"
            stroke="#ea580c"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M2.2 1.8v3.8H6"
            stroke="#ea580c"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "security":
      return (
        <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
          <path d="M8 1 13 3.2v4.4c0 3.1-2.1 5.7-5 6.8-2.9-1.1-5-3.7-5-6.8V3.2Z" fill="#dc2626" />
        </svg>
      );
    case "business":
    default:
      return (
        <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="2.2" fill="#334155" />
          <rect x="4.2" y="5.1" width="3.2" height="3.2" rx="0.8" fill="#fff" />
          <rect x="8.2" y="5.1" width="3.4" height="1.2" rx="0.6" fill="#fff" />
          <rect x="8.2" y="7.2" width="3.4" height="1.2" rx="0.6" fill="#fff" />
        </svg>
      );
  }
}

function TechnologyChip({ technology }: { technology: TechnologyMeta }) {
  const isMicrosoft = technology.vendor === "microsoft";
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium text-foreground"
      style={{
        borderColor: technology.stroke,
        backgroundColor: `${technology.fill}`,
      }}
    >
      {technology.kind === "azure" ? (
        <AzureGlyph className="size-4" />
      ) : isMicrosoft ? (
        <MicrosoftGlyph className="size-4" />
      ) : (
        <GenericGlyph kind={technology.kind} className="size-4" />
      )}
      <span>{technology.label}</span>
    </span>
  );
}

function sanitizeFileName(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "diagram";
}

function getSvgDimensions(svgMarkup: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
  const svg = doc.documentElement;
  const viewBox = svg.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every((part) => Number.isFinite(part))) {
      return { width: parts[2] || 1200, height: parts[3] || 700 };
    }
  }
  return {
    width: Number(svg.getAttribute("width") || "1200") || 1200,
    height: Number(svg.getAttribute("height") || "700") || 700,
  };
}

export function MermaidDiagram({
  chart,
  title,
  downloadName,
}: {
  chart?: string | null;
  title?: string;
  downloadName?: string;
}) {
  const renderId = useId().replace(/:/g, "-");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [technologies, setTechnologies] = useState<TechnologyMeta[]>([]);
  const [downloading, setDownloading] = useState<"svg" | "png" | null>(null);
  const normalizedChart = (chart ?? "").trim();
  const safeDownloadName = sanitizeFileName(downloadName || "high-level-architecture");

  useEffect(() => {
    let cancelled = false;

    async function render() {
      if (!normalizedChart) {
        setSvg("");
        setError("");
        setTechnologies([]);
        return;
      }

      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          fontFamily: "inherit",
          flowchart: {
            useMaxWidth: true,
            htmlLabels: false,
            curve: "basis",
          },
        });

        const { svg: rendered } = await mermaid.render(
          `mermaid-${renderId}`,
          normalizedChart,
        );
        const enhanced = enhanceRenderedSvg(rendered);
        if (!cancelled) {
          setSvg(enhanced.svg);
          setTechnologies(enhanced.technologies);
          setError("");
        }
      } catch {
        if (!cancelled) {
          setSvg("");
          setTechnologies([]);
          setError("Kunne ikke rendre arkitekturdiagrammet.");
        }
      }
    }

    void render();

    return () => {
      cancelled = true;
    };
  }, [normalizedChart, renderId]);

  async function downloadSvgFile() {
    if (!svg) return;
    setDownloading("svg");
    try {
      const blob = new Blob([svg], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeDownloadName}.svg`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(null);
    }
  }

  async function downloadPngFile() {
    if (!svg) return;
    setDownloading("png");
    try {
      const blob = new Blob([svg], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const image = new Image();
      const { width, height } = getSvgDimensions(svg);

      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Kunne ikke laste diagrammet for eksport."));
        image.src = url;
      });

      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(800, width * scale);
      canvas.height = Math.max(520, height * scale);
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Kunne ikke opprette eksportflate.");
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const pngBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!pngBlob) {
        throw new Error("Kunne ikke lage PNG-eksport.");
      }

      const pngUrl = URL.createObjectURL(pngBlob);
      const link = document.createElement("a");
      link.href = pngUrl;
      link.download = `${safeDownloadName}.png`;
      link.click();
      URL.revokeObjectURL(pngUrl);
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Kunne ikke laste ned diagrammet.",
      );
    } finally {
      setDownloading(null);
    }
  }

  if (!normalizedChart) {
    return (
      <p className="text-sm text-muted-foreground">
        Diagram blir tilgjengelig når kundeanalysen genererer en gyldig
        high-level arkitektur.
      </p>
    );
  }

  if (error) {
    return <p className="text-sm text-muted-foreground">{error}</p>;
  }

  if (!svg) {
    return (
      <p className="text-sm text-muted-foreground">
        Rendrer arkitekturdiagram ...
      </p>
    );
  }

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          {title ? (
            <p className="text-sm font-medium text-foreground/70">{title}</p>
          ) : null}
          {technologies.length ? (
            <div className="flex flex-wrap gap-2">
              {technologies.map((technology) => (
                <TechnologyChip
                  key={technology.key}
                  technology={technology}
                />
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={downloadSvgFile}
            disabled={downloading !== null}
          >
            {downloading === "svg" ? (
              <Sparkles data-icon="inline-start" />
            ) : (
              <Download data-icon="inline-start" />
            )}
            Last ned SVG
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={downloadPngFile}
            disabled={downloading !== null}
          >
            {downloading === "png" ? (
              <Sparkles data-icon="inline-start" />
            ) : (
              <ImageDown data-icon="inline-start" />
            )}
            Last ned PNG
          </Button>
        </div>
      </div>

      <div className="mermaid-diagram rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>
  );
}
