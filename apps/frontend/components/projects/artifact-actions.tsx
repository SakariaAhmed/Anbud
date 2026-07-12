"use client";

import { Download, FileDown, Printer, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { downloadTextFile, sanitizeDownloadFileBase } from "@/lib/client/download";
import { downloadElementAsPdf } from "@/lib/client/pdf-download";
import type { GeneratedArtifact } from "@/lib/types";
import { cn } from "@/lib/utils";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToHtml(markdown: string) {
  return escapeHtml(markdown)
    .split("\n")
    .map((line) => {
      if (line.startsWith("## ")) return `<h2>${line.slice(3)}</h2>`;
      if (line.startsWith("# ")) return `<h1>${line.slice(2)}</h1>`;
      if (line.startsWith("- ")) return `<li>${line.slice(2)}</li>`;
      if (!line.trim()) return "";
      return `<p>${line}</p>`;
    })
    .join("\n")
    .replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>")
    .replace(/<\/ul>\s*<ul>/g, "");
}

function artifactHtml(artifact: GeneratedArtifact) {
  const title = escapeHtml(artifact.title || "Artefakt");
  return `<!doctype html>
<html lang="no">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { color: #111827; font-family: "IBM Plex Serif", Georgia, "Times New Roman", serif; line-height: 1.62; margin: 48px; }
    h1, h2 { font-family: "IBM Plex Sans", Arial, sans-serif; line-height: 1.22; margin: 28px 0 10px; }
    h1 { font-size: 26px; }
    h2 { border-bottom: 1px solid #d1d5db; font-size: 18px; padding-bottom: 6px; }
    p, li { font-size: 11.5pt; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${markdownToHtml(artifact.content_markdown)}
</body>
</html>`;
}

export function ArtifactActions({ artifact }: { artifact: GeneratedArtifact }) {
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const fileBase = sanitizeDownloadFileBase(artifact.title, "artefakt");
  const inputSnapshot =
    artifact.input_snapshot && typeof artifact.input_snapshot === "object"
      ? (artifact.input_snapshot as Record<string, unknown>)
      : {};
  const sourceCount = Array.isArray(inputSnapshot.source_document_ids)
    ? inputSnapshot.source_document_ids.length
    : 0;
  const sourceRoles = Array.isArray(inputSnapshot.source_document_roles)
    ? inputSnapshot.source_document_roles.filter(
        (source): source is Record<string, unknown> =>
          Boolean(source) && typeof source === "object",
      )
    : [];
  const authorityLabel = artifact.is_current
    ? artifact.source_is_current
      ? "Gjeldende"
      : "Grunnlaget er endret – regenerer"
    : "Historikk";

  async function downloadArtifactPdf() {
    if (downloadingPdf) return;

    const source = document.createElement("article");
    source.innerHTML = markdownToHtml(artifact.content_markdown);
    Object.assign(source.style, {
      background: "#ffffff",
      color: "#0f172a",
      fontFamily: 'Arial, "Helvetica Neue", sans-serif',
      fontSize: "15px",
      lineHeight: "1.62",
      padding: "0",
      pointerEvents: "none",
      position: "fixed",
      top: "0",
      left: "0",
      width: "960px",
      zIndex: "-2",
    });
    for (const heading of source.querySelectorAll<HTMLElement>("h1, h2")) {
      Object.assign(heading.style, {
        color: "#0f172a",
        fontFamily: 'Arial, "Helvetica Neue", sans-serif',
        lineHeight: "1.25",
        margin: "26px 0 10px",
      });
    }
    for (const paragraph of source.querySelectorAll<HTMLElement>("p, li")) {
      Object.assign(paragraph.style, {
        margin: "0 0 10px",
      });
    }
    document.body.appendChild(source);

    setDownloadingPdf(true);
    setPdfError("");
    try {
      await downloadElementAsPdf({
        element: source,
        fileName: `${fileBase}.pdf`,
        title: artifact.title || "Artefakt",
      });
    } catch (error) {
      setPdfError(
        error instanceof Error ? error.message : "Kunne ikke lage PDF.",
      );
    } finally {
      source.remove();
      setDownloadingPdf(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex h-9 items-center rounded-lg border px-3 text-xs font-bold",
            artifact.is_current && artifact.source_is_current
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : artifact.is_current
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-slate-200 bg-slate-50 text-slate-600",
          )}
        >
          {authorityLabel}
        </span>
        {artifact.artifact_version ? (
          <span className="inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700">
            Versjon {artifact.artifact_version}
          </span>
        ) : null}
        {sourceCount ? (
          <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-3 text-xs font-medium text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            {sourceCount} kilde{sourceCount === 1 ? "" : "r"}
          </span>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            downloadTextFile(
              `${fileBase}.md`,
              "text/markdown;charset=utf-8",
              artifact.content_markdown,
            )
          }
        >
          <Download data-icon="inline-start" />
          Markdown
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            downloadTextFile(
              `${fileBase}.doc`,
              "application/msword;charset=utf-8",
              artifactHtml(artifact),
            )
          }
        >
          <FileDown data-icon="inline-start" />
          Word
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={downloadingPdf}
          onClick={() => void downloadArtifactPdf()}
        >
          <Printer data-icon="inline-start" />
          {downloadingPdf ? "Lager PDF" : "PDF"}
        </Button>
      </div>
      {pdfError ? (
        <p className="text-xs font-medium text-red-700">{pdfError}</p>
      ) : null}
      {sourceRoles.length ? (
        <details className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">
            Kildesporing
          </summary>
          <div className="mt-2 grid gap-1.5">
            {sourceRoles.map((source, index) => (
              <div key={`${source.id ?? index}`} className="flex flex-wrap gap-2">
                <span className="font-medium text-foreground">
                  {typeof source.title === "string"
                    ? source.title
                    : `Kilde ${index + 1}`}
                </span>
                {typeof source.role === "string" ? <span>{source.role}</span> : null}
                {typeof source.subtype === "string" ? (
                  <span>{source.subtype}</span>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
