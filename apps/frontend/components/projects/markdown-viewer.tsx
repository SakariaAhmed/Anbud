"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
}: {
  content: string;
  className?: string;
  tone?: "default" | "inverse";
}) {
  return (
    <div className={cn("markdown-viewer", tone === "inverse" && "markdown-viewer-inverse", className)}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
