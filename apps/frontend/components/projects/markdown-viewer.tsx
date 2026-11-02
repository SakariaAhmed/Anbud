"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { OutputSourceEvidence } from "@/components/projects/output-source-evidence";

import { cn } from "@/lib/utils";

function safeMarkdownUrl(url: string) {
  const trimmed = url.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol)
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

export const MarkdownViewer = memo(function MarkdownViewer({
  content,
  className,
  tone = "default",
  sourceEvidence, projectId, canDownloadDocuments = false, evidencePath,
}: {
  content: string;
  className?: string;
  tone?: "default" | "inverse";
  sourceEvidence?: unknown;
  projectId?: string;
  canDownloadDocuments?: boolean;
  evidencePath?: string;
}) {
  let offset = 0;
  const sections = sourceEvidence && projectId ? content.split(/(\r?\n[ \t]*\r?\n)/u).flatMap((text, index) => {
    const start = offset; offset += text.length;
    return index % 2 === 0 ? [{ start, end: offset, path: `content_markdown.${index}` }] : [];
  }) : [];
  const evidenceAt = (at: number | undefined) => {
    const path = evidencePath ?? sections.find(section => at !== undefined && at >= section.start && at < section.end)?.path;
    return projectId && sourceEvidence && path ? <OutputSourceEvidence value={sourceEvidence} path={path} projectId={projectId} canDownloadDocuments={canDownloadDocuments} /> : null;
  };
  return (
    <div className={cn("markdown-viewer", tone === "inverse" && "markdown-viewer-inverse", className)}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={sourceEvidence && projectId ? {
          p: ({ node, children, ...props }) => <div className="min-w-0"><p {...props}>{children}</p>{evidenceAt(node?.position?.start.offset)}</div>,
          table: ({ node, children, ...props }) => <div className="min-w-0"><table {...props}>{children}</table>{evidenceAt(node?.position?.start.offset)}</div>,
        } : undefined}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
