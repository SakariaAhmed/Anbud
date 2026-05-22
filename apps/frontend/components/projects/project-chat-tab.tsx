"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  Bot,
  Check,
  Copy,
  FilePlus2,
  RefreshCcw,
  ScrollText,
  User2,
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
  onRegenerateResponse,
  onUseAsArtifactSeed,
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
  onRegenerateResponse?: (messageId: string) => void;
  onUseAsArtifactSeed?: (message: ChatMessage) => void;
}) {
  const isDrawer = variant === "drawer";
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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
          "overflow-hidden border bg-card shadow-sm",
          isDrawer ? "flex min-h-0 flex-1 flex-col rounded-lg" : "rounded-xl",
        )}
      >
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

            return (
            <div
              key={message.id}
              className={`flex w-full items-start gap-2.5 ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              {message.role === "assistant" ? (
                <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm">
                  <Bot className="size-3" />
                </div>
              ) : null}
              <div
                className={`max-w-[min(100%,54rem)] rounded-2xl border px-4 py-3 ${
                  message.role === "user"
                    ? "border-foreground/15 bg-foreground text-background shadow-sm"
                    : "bg-muted/60 shadow-sm"
                }`}
              >
                <MarkdownViewer
                  content={message.content}
                  tone={message.role === "user" ? "inverse" : "default"}
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
                    {onUseAsArtifactSeed ? (
                      <button
                        type="button"
                        title="Bruk som generatorføring"
                        onClick={() => onUseAsArtifactSeed(message)}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                      >
                        <FilePlus2 className="size-3.5" />
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
              {message.role === "user" ? (
                <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm">
                  <User2 className="size-3" />
                </div>
              ) : null}
            </div>
            );
          })}

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
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
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
