"use client";

import { Download, FileDown, Printer, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { GeneratedArtifact } from "@/lib/types";

function sanitizeFileName(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/æ/g, "ae")
      .replace(/ø/g, "o")
      .replace(/å/g, "a")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "artefakt"
  );
}

function downloadBlob(fileName: string, type: string, content: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

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
    body { color: #111827; font-family: Georgia, "Times New Roman", serif; line-height: 1.55; margin: 48px; }
    h1, h2 { font-family: Arial, sans-serif; line-height: 1.2; margin: 28px 0 10px; }
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
  const fileBase = sanitizeFileName(artifact.title);
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

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
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
            downloadBlob(
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
            downloadBlob(
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
          onClick={() => {
            const printWindow = window.open(
              "",
              "_blank",
              "noopener,noreferrer,width=1024,height=768",
            );
            if (!printWindow) return;
            printWindow.document.write(artifactHtml(artifact));
            printWindow.document.close();
            printWindow.focus();
            printWindow.print();
          }}
        >
          <Printer data-icon="inline-start" />
          PDF
        </Button>
      </div>
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
