"use client";

type DownloadElementPdfOptions = {
  element: HTMLElement;
  fileName: string;
  title?: string;
  subtitle?: string;
};

const A4_MARGIN_MM = 10;
const EXPORT_WIDTH_PX = 1040;
const MAX_CANVAS_HEIGHT_PX = 30000;

function waitForFonts() {
  if (!("fonts" in document)) {
    return Promise.resolve();
  }

  return document.fonts.ready.then(() => undefined);
}

function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

function addCanvasToPdf(canvas: HTMLCanvasElement, fileName: string) {
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

    for (let offsetY = 0; offsetY < canvas.height; offsetY += sliceHeight) {
      const currentSliceHeight = Math.min(sliceHeight, canvas.height - offsetY);
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
    }

    downloadBlob(fileName, pdf.output("blob"));
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
    const exportHeight = Math.ceil(exportContainer.scrollHeight);
    const preferredScale = Math.max(
      1.5,
      Math.min(window.devicePixelRatio || 1.5, 2),
    );
    const scale = Math.max(
      1,
      Math.min(preferredScale, MAX_CANVAS_HEIGHT_PX / exportHeight),
    );
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

    await addCanvasToPdf(canvas, fileName);
  } finally {
    exportContainer.remove();
  }
}
