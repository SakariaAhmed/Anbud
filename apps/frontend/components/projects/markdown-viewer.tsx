"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

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
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
