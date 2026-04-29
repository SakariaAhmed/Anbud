"use client";

import { FormEvent, RefObject } from "react";
import { ArrowUp, Bot, User2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import type { ChatMessage } from "@/lib/types";

export function ProjectChatTab({
  chatMessages,
  chatInput,
  streamingMessage,
  busy,
  chatContainerRef,
  onChatInputChange,
  onSubmit,
}: {
  chatMessages: ChatMessage[];
  chatInput: string;
  streamingMessage: string;
  busy: boolean;
  chatContainerRef: RefObject<HTMLDivElement | null>;
  onChatInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="mb-1">
        <h2 className="text-lg font-bold text-foreground">
          Sparring med prosjektkontekst
        </h2>
        <p className="mt-1 max-w-xl text-sm text-foreground/60">
          Chatten bruker dokumenter, analyse, løsningsvurdering og tidligere
          meldinger som kontekst.
        </p>
      </div>

      {/* Chat container */}
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div
          ref={chatContainerRef}
          className="flex h-[72vh] min-h-[42rem] flex-col gap-2.5 overflow-y-auto px-5 py-5"
        >
          {chatMessages.map((message) => (
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
              </div>
              {message.role === "user" ? (
                <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm">
                  <User2 className="size-3" />
                </div>
              ) : null}
            </div>
          ))}

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

          {chatMessages.length === 0 && !streamingMessage ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium text-foreground">
                Ingen meldinger ennå
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Start med å spørre hva kunden egentlig prøver å få til, hvor
                løsningen er svak, eller hvordan dere bør posisjonere dere.
              </p>
            </div>
          ) : null}
        </div>

        {/* Input */}
        <div className="border-t bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <form onSubmit={onSubmit}>
            <textarea
              value={chatInput}
              onChange={(e) => onChatInputChange(e.target.value)}
              placeholder="Skriv en melding..."
              className="mb-3 min-h-14 w-full resize-none rounded-xl border bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Svar bygger på hele prosjektkonteksten.
              </p>
              <Button type="submit" disabled={busy} className="h-10 px-4">
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
