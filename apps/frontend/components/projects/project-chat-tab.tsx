"use client";

import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  FileText,
  Paperclip,
  RefreshCcw,
  ScrollText,
  User2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { cn } from "@/lib/utils";
import type {
  ChatDomainHint,
  ChatMessage,
  ChatSourceReference,
} from "@/lib/types";

const QUICK_PROMPTS = [
  "Hva er de største tilbudsrisikoene akkurat nå?",
  "Hva prøver kunden egentlig å få til?",
  "Lag fem presise avklaringsspørsmål til kunden.",
  "Hvor er løsningen eller posisjoneringen svakest?",
  "Hva bør vi løfte som tydelig verdiargumentasjon?",
];

export type ChatDocumentUploadState = {
  status: "idle" | "attached" | "sending" | "failed";
  fileName?: string;
  message?: string;
};

type ChatPromptAttachmentMetadata = {
  title: string;
  file_name: string;
  file_format: string;
  file_size_bytes: number;
  text_length?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function messageSourceReferences(message: ChatMessage): ChatSourceReference[] {
  if (message.source_references?.length) {
    return message.source_references;
  }

  const snapshot = message.context_snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return [];
  }

  const value = (snapshot as { source_references?: unknown }).source_references;
  return Array.isArray(value) ? (value as ChatSourceReference[]) : [];
}

function messagePromptAttachments(message: ChatMessage): ChatPromptAttachmentMetadata[] {
  if (!isRecord(message.context_snapshot)) {
    return [];
  }

  const value = message.context_snapshot.prompt_attachments;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => {
      const fileName =
        typeof item.file_name === "string" && item.file_name.trim()
          ? item.file_name.trim()
          : "Dokument";
      const title =
        typeof item.title === "string" && item.title.trim()
          ? item.title.trim()
          : fileName.replace(/\.[^.]+$/, "");
      const fileFormat =
        typeof item.file_format === "string" && item.file_format.trim()
          ? item.file_format.trim().toUpperCase()
          : "DOCUMENT";
      const fileSizeBytes =
        typeof item.file_size_bytes === "number" &&
        Number.isFinite(item.file_size_bytes)
          ? item.file_size_bytes
          : 0;
      const textLength =
        typeof item.text_length === "number" && Number.isFinite(item.text_length)
          ? item.text_length
          : undefined;

      const attachment: ChatPromptAttachmentMetadata = {
        title,
        file_name: fileName,
        file_format: fileFormat,
        file_size_bytes: fileSizeBytes,
      };

      return textLength != null
        ? { ...attachment, text_length: textLength }
        : attachment;
    });
}

function messageDomainHints(message: ChatMessage): ChatDomainHint[] {
  if (message.domain_hints?.length) {
    return message.domain_hints;
  }

  const snapshot = message.context_snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return [];
  }

  const value = (snapshot as { domain_hints?: unknown }).domain_hints;
  return Array.isArray(value) ? (value as ChatDomainHint[]) : [];
}

function sourceLabel(source: ChatSourceReference) {
  const page =
    source.page_start != null
      ? source.page_end && source.page_end !== source.page_start
        ? `side ${source.page_start}-${source.page_end}`
        : `side ${source.page_start}`
      : "";
  const reference = [source.reference, page].filter(Boolean).join(", ");
  return reference ? `${source.document_title} · ${reference}` : source.document_title;
}

function attachmentLabel(attachment: ChatPromptAttachmentMetadata) {
  return attachment.title || attachment.file_name || "Dokument";
}

function attachmentMetaLabel(attachment: ChatPromptAttachmentMetadata) {
  const size = compactAttachmentSize(attachment.file_size_bytes);
  const format =
    attachment.file_format && attachment.file_format !== "DOCUMENT"
      ? attachment.file_format
      : "Dokument";

  return [format, size].filter(Boolean).join(" · ");
}

function uploadStatusClassName(status: ChatDocumentUploadState["status"]) {
  switch (status) {
    case "failed":
      return "border-red-200 bg-red-50 text-red-700";
    case "attached":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "sending":
      return "border-primary/20 bg-primary/5 text-primary";
    case "idle":
      return "";
  }
}

function ChatAttachmentCard({
  attachment,
  isUser,
}: {
  attachment: ChatPromptAttachmentMetadata;
  isUser: boolean;
}) {
  const label = attachmentLabel(attachment);

  return (
    <div
      className={cn(
        "flex w-[min(100%,28rem)] items-center gap-3 rounded-xl border px-3 py-2.5 shadow-sm",
        isUser
          ? "border-foreground/15 bg-background text-foreground"
          : "border-border bg-background/80 text-foreground",
      )}
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
        <FileText className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold" title={label}>
          {label}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {attachmentMetaLabel(attachment)}
        </span>
      </span>
    </div>
  );
}

export function ProjectChatTab({
  chatMessages,
  chatInput,
  streamingMessage,
  busy,
  loading = false,
  error = "",
  variant = "page",
  sessionDomainHints = [],
  chatContainerRef,
  onChatInputChange,
  onSubmit,
  onUploadDocument,
  onClearDocumentUpload,
  documentUploadState = { status: "idle" },
  onRegenerateResponse,
}: {
  chatMessages: ChatMessage[];
  chatInput: string;
  streamingMessage: string;
  busy: boolean;
  loading?: boolean;
  error?: string;
  variant?: "page" | "drawer";
  sessionDomainHints?: ChatDomainHint[];
  chatContainerRef: RefObject<HTMLDivElement | null>;
  onChatInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUploadDocument?: (file: File) => void | Promise<void>;
  onClearDocumentUpload?: () => void;
  documentUploadState?: ChatDocumentUploadState;
  onRegenerateResponse?: (messageId: string) => void;
}) {
  const isDrawer = variant === "drawer";
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const documentUploadBusy = documentUploadState.status === "sending";
  const uploadDisabled = !onUploadDocument || busy || loading || documentUploadBusy;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    const maxHeight = isDrawer ? 128 : 116;
    input.style.height = "auto";
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  }, [chatInput, isDrawer]);

  useEffect(() => {
    if (uploadDisabled) {
      setDragActive(false);
    }
  }, [uploadDisabled]);

  async function copyMessage(message: ChatMessage) {
    await navigator.clipboard.writeText(message.content);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(null), 1400);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();
    if (busy || loading || !chatInput.trim()) {
      return;
    }

    event.currentTarget.form?.requestSubmit();
  }

  function dragHasFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function canAcceptDrag(event: DragEvent<HTMLElement>) {
    return Boolean(onUploadDocument) && !uploadDisabled && dragHasFiles(event);
  }

  function handleChatDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!canAcceptDrag(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  }

  function handleChatDragOver(event: DragEvent<HTMLDivElement>) {
    if (!canAcceptDrag(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleChatDragLeave(event: DragEvent<HTMLDivElement>) {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }

    setDragActive(false);
  }

  function handleChatDrop(event: DragEvent<HTMLDivElement>) {
    if (!onUploadDocument || !dragHasFiles(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);

    if (uploadDisabled) {
      return;
    }

    const nextFile = event.dataTransfer.files?.[0] ?? null;
    if (!nextFile) {
      return;
    }

    void onUploadDocument(nextFile);
  }

  function onFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!nextFile || !onUploadDocument) {
      return;
    }

    void onUploadDocument(nextFile);
  }

  const uploadStatusVisible = documentUploadState.status !== "idle";

  return (
    <div className={cn(isDrawer ? "flex h-full min-h-0 flex-col" : "space-y-4")}>
      {!isDrawer ? (
        <div className="mb-1">
          <h2 className="text-lg font-bold text-foreground">
            Sparring med prosjektkontekst
          </h2>
          <p className="mt-1 max-w-xl text-sm text-foreground/60">
            Chatten bruker dokumenter, analyse, løsningsvurdering og tidligere
            meldinger som kontekst.
          </p>
        </div>
      ) : null}

      {/* Chat container */}
      <div
        className={cn(
          "relative overflow-hidden border bg-card shadow-sm",
          isDrawer ? "flex min-h-0 flex-1 flex-col rounded-lg" : "rounded-xl",
        )}
        onDragEnter={handleChatDragEnter}
        onDragOver={handleChatDragOver}
        onDragLeave={handleChatDragLeave}
        onDrop={handleChatDrop}
      >
        {dragActive ? (
          <div
            className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/70 bg-background/90 text-center shadow-sm backdrop-blur-sm"
            aria-hidden="true"
          >
            <div className="grid justify-items-center gap-2 px-6">
              <span className="flex size-11 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <Paperclip className="size-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Slipp dokumentet her
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  PDF, DOCX, Excel, TXT eller MD legges til chat-kontekst.
                </p>
              </div>
            </div>
          </div>
        ) : null}
        <div
          ref={chatContainerRef}
          className={cn(
            "flex flex-col gap-2.5 overflow-y-auto px-5 py-5",
            isDrawer ? "min-h-0 flex-1" : "h-[72vh] min-h-[42rem]",
          )}
        >
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Laster chat ...
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {chatMessages.map((message) => {
            const sources = messageSourceReferences(message);
            const domains = messageDomainHints(message);
            const isAssistant = message.role === "assistant";
            const isUser = message.role === "user";
            const attachments = isUser ? messagePromptAttachments(message) : [];

            return (
              <div
                key={message.id}
                className={cn(
                  "flex w-full items-start gap-2.5",
                  isUser ? "justify-end" : "justify-start",
                )}
              >
                {isAssistant ? (
                  <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm">
                    <Bot className="size-3" />
                  </div>
                ) : null}
                <div
                  className={cn(
                    "flex max-w-[min(100%,54rem)] flex-col gap-2",
                    isUser ? "items-end" : "items-start",
                  )}
                >
                  {attachments.length ? (
                    <div
                      className={cn(
                        "flex w-full flex-col gap-2",
                        isUser ? "items-end" : "items-start",
                      )}
                    >
                      {attachments.map((attachment, index) => (
                        <ChatAttachmentCard
                          key={`${attachment.file_name}-${index}`}
                          attachment={attachment}
                          isUser={isUser}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div
                    className={cn(
                      "max-w-full rounded-2xl border px-4 py-3",
                      isUser
                        ? "border-foreground/15 bg-foreground text-background shadow-sm"
                        : "bg-muted/60 shadow-sm",
                    )}
                  >
                    <MarkdownViewer
                      content={message.content}
                      tone={isUser ? "inverse" : "default"}
                      className="chat-markdown text-[0.98rem]"
                    />
                    {isAssistant ? (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
                        <button
                          type="button"
                          title="Kopier svar"
                          onClick={() => void copyMessage(message)}
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                        >
                          {copiedMessageId === message.id ? (
                            <Check className="size-3.5" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </button>
                        {onRegenerateResponse ? (
                          <button
                            type="button"
                            title="Svar på nytt"
                            onClick={() => onRegenerateResponse(message.id)}
                            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                          >
                            <RefreshCcw className="size-3.5" />
                          </button>
                        ) : null}
                        {domains.map((domain) => (
                          <span
                            key={domain}
                            className="inline-flex min-h-7 items-center rounded-md bg-background px-2 text-[0.7rem] font-medium text-muted-foreground"
                          >
                            {domain}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {isAssistant && sources.length ? (
                      <details className="mt-2 rounded-md border border-border/70 bg-background/70 px-2.5 py-2 text-xs text-muted-foreground">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-foreground">
                          <ScrollText className="size-3.5" />
                          {sources.length} kilde{sources.length === 1 ? "" : "r"}
                        </summary>
                        <div className="mt-2 grid gap-1.5">
                          {sources.slice(0, 5).map((source, index) => (
                            <div
                              key={`${source.source_id}-${source.reference}-${index}`}
                              className="leading-5"
                            >
                              {sourceLabel(source)}
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                </div>
                {isUser ? (
                  <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm">
                    <User2 className="size-3" />
                  </div>
                ) : null}
              </div>
            );
          })}

          {busy && !streamingMessage ? (
            <div className="flex w-full items-start gap-2.5" aria-live="polite">
              <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm">
                <Bot className="size-3" />
              </div>
              <div className="max-w-[min(100%,24rem)] rounded-2xl border bg-muted/60 px-4 py-3 shadow-sm">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Spinner className="size-3.5" />
                  Leser prosjektkontekst
                </div>
                <div className="flex h-5 items-center gap-1.5">
                  <span className="size-2 animate-bounce rounded-full bg-foreground/35 [animation-delay:-0.24s]" />
                  <span className="size-2 animate-bounce rounded-full bg-foreground/35 [animation-delay:-0.12s]" />
                  <span className="size-2 animate-bounce rounded-full bg-foreground/35" />
                </div>
              </div>
            </div>
          ) : null}

          {streamingMessage ? (
            <div className="flex w-full items-start gap-2.5">
              <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm">
                <Bot className="size-3" />
              </div>
              <div className="max-w-[min(100%,54rem)] rounded-2xl border bg-muted/60 px-4 py-3 shadow-sm">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  Tenker ...
                </div>
                <MarkdownViewer content={streamingMessage} className="chat-markdown text-[0.98rem]" />
              </div>
            </div>
          ) : null}

          {chatMessages.length === 0 && !streamingMessage && !loading ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium text-foreground">
                Ingen meldinger ennå
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Start med å spørre hva kunden egentlig prøver å få til, hvor
                løsningen er svak, eller hvordan dere bør posisjonere dere.
              </p>
              <div className="mx-auto mt-5 grid max-w-2xl gap-2 sm:grid-cols-2">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => onChatInputChange(prompt)}
                    className="min-h-11 rounded-lg border bg-background px-3 py-2 text-left text-xs font-medium text-foreground shadow-sm transition-colors hover:border-foreground/25 hover:bg-muted/40"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* Input */}
        <div className="border-t bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <form onSubmit={onSubmit}>
            {onUploadDocument ? (
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.xlsx,.xls,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/plain,text/markdown"
                className="sr-only"
                disabled={uploadDisabled}
                onChange={onFileInputChange}
              />
            ) : null}
            <textarea
              ref={inputRef}
              value={chatInput}
              onChange={(e) => onChatInputChange(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Skriv en melding..."
              rows={1}
              className={cn(
                "mb-2 block max-h-32 min-h-11 w-full resize-none rounded-lg border bg-transparent px-3.5 py-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
              )}
            />
            {uploadStatusVisible ? (
              <div
                className={cn(
                  "mb-2 flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-xs font-medium",
                  uploadStatusClassName(documentUploadState.status),
                )}
                aria-live="polite"
              >
                {documentUploadState.status === "failed" ? (
                  <AlertCircle className="size-3.5 shrink-0" />
                ) : documentUploadState.status === "attached" ? (
                  <CheckCircle2 className="size-3.5 shrink-0" />
                ) : (
                  <Spinner className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 truncate">
                  {documentUploadState.message ||
                    documentUploadState.fileName ||
                    "Behandler dokument ..."}
                </span>
                {onClearDocumentUpload && documentUploadState.status !== "sending" ? (
                  <button
                    type="button"
                    title="Fjern vedlegg"
                    aria-label="Fjern vedlegg"
                    className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md text-current opacity-70 transition-opacity hover:bg-background/70 hover:opacity-100"
                    onClick={onClearDocumentUpload}
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {onUploadDocument ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-lg"
                    title="Last opp dokument til chat-kontekst"
                    aria-label="Last opp dokument til chat-kontekst"
                    disabled={uploadDisabled}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {documentUploadBusy ? (
                      <Spinner className="size-4" />
                    ) : (
                      <Paperclip className="size-4" />
                    )}
                  </Button>
                ) : null}
                {sessionDomainHints.length ? (
                  sessionDomainHints.slice(0, 3).map((domain) => (
                    <span
                      key={domain}
                      className="inline-flex h-7 items-center rounded-md border bg-muted/40 px-2 font-medium text-muted-foreground"
                    >
                      {domain}
                    </span>
                  ))
                ) : (
                  <span>Svar bygger på hele prosjektkonteksten.</span>
                )}
              </div>
              <Button
                type="submit"
                disabled={busy || loading || !chatInput.trim()}
                className="h-10 px-4"
              >
                {busy ? (
                  <Spinner className="size-4" />
                ) : (
                  <ArrowUp data-icon="inline-start" />
                )}
                Send
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
