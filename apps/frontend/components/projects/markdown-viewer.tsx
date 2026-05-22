"use client";

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

export function MarkdownViewer({
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
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
