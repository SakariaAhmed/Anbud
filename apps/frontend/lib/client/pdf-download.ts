"use client";

import { downloadBrowserBlob } from "@/lib/client/download";

type DownloadElementPdfOptions = {
  element: HTMLElement;
  fileName: string;
  title?: string;
  subtitle?: string;
};

const A4_MARGIN_MM = 10;
const EXPORT_WIDTH_PX = 1120;
const MAX_CANVAS_HEIGHT_PX = 30000;
const EXPORT_COLOR_PROPERTIES = [
  "backgroundColor",
  "borderBlockEndColor",
  "borderBlockStartColor",
  "borderBottomColor",
  "borderInlineEndColor",
  "borderInlineStartColor",
  "borderLeftColor",
  "borderRightColor",
  "borderTopColor",
  "caretColor",
  "color",
  "columnRuleColor",
  "outlineColor",
  "textDecorationColor",
] as const;
const exportColorCache = new Map<string, string>();
let exportColorContext: CanvasRenderingContext2D | null | undefined;

function canvasCompatibleColor(value: string) {
  if (!/(?:oklab|oklch|color-mix|\blab\(|\blch\()/i.test(value)) {
    return value;
  }
  const cached = exportColorCache.get(value);
  if (cached) {
    return cached;
  }
  if (exportColorContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    exportColorContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  const context = exportColorContext;
  if (!context) {
    return value;
  }

  context.clearRect(0, 0, 1, 1);
  context.fillStyle = "#000000";
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  const normalized = `rgba(${red}, ${green}, ${blue}, ${Math.round((alpha / 255) * 1000) / 1000})`;
  exportColorCache.set(value, normalized);
  return normalized;
}

function normalizeExportStyles(container: HTMLElement) {
  const elements = [container, ...Array.from(container.querySelectorAll<HTMLElement>("*"))];

  for (const element of elements) {
    const computed = window.getComputedStyle(element);
    for (const property of EXPORT_COLOR_PROPERTIES) {
      const value = computed[property];
      if (value) {
        element.style[property] = canvasCompatibleColor(value);
      }
    }

    if (element instanceof SVGElement) {
      if (computed.fill && computed.fill !== "none") {
        element.style.fill = canvasCompatibleColor(computed.fill);
      }
      if (computed.stroke && computed.stroke !== "none") {
        element.style.stroke = canvasCompatibleColor(computed.stroke);
      }
    }

    if (/oklab|oklch|color-mix/i.test(computed.backgroundImage)) {
      element.style.backgroundImage = "none";
    }
    if (/oklab|oklch|color-mix/i.test(computed.boxShadow)) {
      element.style.boxShadow = "none";
    }
    if (/oklab|oklch|color-mix/i.test(computed.textShadow)) {
      element.style.textShadow = "none";
    }
  }
}

function waitForFonts() {
  if (!("fonts" in document)) {
    return Promise.resolve();
  }

  return document.fonts.ready.then(() => undefined);
}

function createExportContainer({
  element,
  title,
  subtitle,
}: Pick<DownloadElementPdfOptions, "element" | "title" | "subtitle">) {
  const container = document.createElement("div");
  container.className = "pdf-export-surface";
  Object.assign(container.style, {
    background: "#ffffff",
    boxSizing: "border-box",
    color: "#0f172a",
    left: "0",
    padding: "40px",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: `${EXPORT_WIDTH_PX}px`,
    zIndex: "-1",
  });

  if (title || subtitle) {
    const header = document.createElement("header");
    Object.assign(header.style, {
      borderBottom: "1px solid #cbd5e1",
      marginBottom: "28px",
      paddingBottom: "18px",
    });

    if (title) {
      const heading = document.createElement("h1");
      heading.textContent = title;
      Object.assign(heading.style, {
        color: "#0f172a",
        fontSize: "30px",
        fontWeight: "700",
        letterSpacing: "0",
        lineHeight: "1.2",
        margin: "0",
      });
      header.appendChild(heading);
    }

    if (subtitle) {
      const meta = document.createElement("p");
      meta.textContent = subtitle;
      Object.assign(meta.style, {
        color: "#64748b",
        fontSize: "13px",
        fontWeight: "600",
        lineHeight: "1.5",
        margin: title ? "8px 0 0" : "0",
      });
      header.appendChild(meta);
    }

    container.appendChild(header);
  }

  const clone = element.cloneNode(true) as HTMLElement;
  Object.assign(clone.style, {
    background: "#ffffff",
    maxWidth: "none",
    overflow: "visible",
    padding: "0",
    width: "100%",
  });
  container.appendChild(clone);

  document.body.appendChild(container);
  return container;
}

function collectSafePageBreaks(container: HTMLElement, scale: number) {
  const rootTop = container.getBoundingClientRect().top;
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "tr, h1, h2, h3, h4, p, li, [data-pdf-page-break]",
    ),
  )
    .map((element) =>
      Math.round((element.getBoundingClientRect().bottom - rootTop) * scale),
    )
    .filter((offset) => offset > 0)
    .sort((left, right) => left - right);
}

function addCanvasToPdf(
  canvas: HTMLCanvasElement,
  fileName: string,
  safePageBreaks: number[],
) {
  return import("jspdf").then(({ jsPDF }) => {
    const pdf = new jsPDF({
      compress: true,
      format: "a4",
      orientation: "portrait",
      unit: "mm",
    });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const contentWidth = pageWidth - A4_MARGIN_MM * 2;
    const contentHeight = pageHeight - A4_MARGIN_MM * 2;
    const sliceHeight = Math.floor((contentHeight * canvas.width) / contentWidth);
    const pageCanvas = document.createElement("canvas");
    const pageContext = pageCanvas.getContext("2d");

    if (!pageContext) {
      throw new Error("Kunne ikke opprette PDF-grafikk.");
    }

    pageCanvas.width = canvas.width;

    for (let offsetY = 0; offsetY < canvas.height; ) {
      const maximumEnd = Math.min(offsetY + sliceHeight, canvas.height);
      const minimumUsefulBreak = offsetY + Math.floor(sliceHeight * 0.55);
      const safeEnd = safePageBreaks
        .filter((candidate) => candidate >= minimumUsefulBreak && candidate <= maximumEnd)
        .at(-1);
      const pageEnd = safeEnd ?? maximumEnd;
      const currentSliceHeight = Math.max(1, pageEnd - offsetY);
      pageCanvas.height = currentSliceHeight;
      pageContext.fillStyle = "#ffffff";
      pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      pageContext.drawImage(
        canvas,
        0,
        offsetY,
        canvas.width,
        currentSliceHeight,
        0,
        0,
        canvas.width,
        currentSliceHeight,
      );

      if (offsetY > 0) {
        pdf.addPage();
      }

      pdf.addImage(
        pageCanvas.toDataURL("image/png"),
        "PNG",
        A4_MARGIN_MM,
        A4_MARGIN_MM,
        contentWidth,
        (currentSliceHeight * contentWidth) / canvas.width,
        undefined,
        "FAST",
      );
      offsetY = pageEnd;
    }

    downloadBrowserBlob(fileName, pdf.output("blob"), { revokeDelayMs: 1000 });
  });
}

export async function downloadElementAsPdf({
  element,
  fileName,
  title,
  subtitle,
}: DownloadElementPdfOptions) {
  const [{ default: html2canvas }] = await Promise.all([
    import("html2canvas"),
    waitForFonts(),
  ]);
  const exportContainer = createExportContainer({ element, title, subtitle });

  try {
    normalizeExportStyles(exportContainer);
    const exportHeight = Math.ceil(exportContainer.scrollHeight);
    const preferredScale = Math.max(
      1.5,
      Math.min(window.devicePixelRatio || 1.5, 2),
    );
    const scale = Math.min(
      preferredScale,
      MAX_CANVAS_HEIGHT_PX / Math.max(1, exportHeight),
    );
    const safePageBreaks = collectSafePageBreaks(exportContainer, scale);
    const canvas = await html2canvas(exportContainer, {
      backgroundColor: "#ffffff",
      height: exportHeight,
      logging: false,
      scale,
      scrollX: 0,
      scrollY: 0,
      useCORS: true,
      width: EXPORT_WIDTH_PX,
      windowHeight: exportHeight,
      windowWidth: EXPORT_WIDTH_PX,
    });

    await addCanvasToPdf(canvas, fileName, safePageBreaks);
  } finally {
    exportContainer.remove();
  }
}
