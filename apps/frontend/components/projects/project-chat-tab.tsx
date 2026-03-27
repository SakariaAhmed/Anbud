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
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-bold text-foreground">
          Sparring med prosjektkontekst
        </h2>
        <p className="mt-1 max-w-xl text-sm text-foreground/60">
          Chatten bruker kundedokument, analyse, løsningsvurdering og
          tidligere meldinger som kontekst.
        </p>
      </div>

      {/* Chat container */}
      <div className="overflow-hidden rounded-lg border shadow-sm">
        <div
          ref={chatContainerRef}
          className="flex max-h-[520px] flex-col gap-3 overflow-y-auto p-4"
        >
          {chatMessages.map((message) => (
            <div
              key={message.id}
              className={`flex w-full items-start gap-2.5 ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              {message.role === "assistant" ? (
                <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                  <Bot className="size-3" />
                </div>
              ) : null}
              <div
                className={`max-w-[min(100%,38rem)] rounded-md border px-3 py-2 ${
                  message.role === "user"
                    ? "border-foreground/20 bg-foreground text-background"
                    : "bg-muted"
                }`}
              >
                <MarkdownViewer
                  content={message.content}
                  tone={message.role === "user" ? "inverse" : "default"}
                  className="text-sm"
                />
              </div>
              {message.role === "user" ? (
                <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-muted-foreground">
                  <User2 className="size-3" />
                </div>
              ) : null}
            </div>
          ))}

          {streamingMessage ? (
            <div className="flex w-full items-start gap-2.5">
              <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                <Bot className="size-3" />
              </div>
              <div className="max-w-[min(100%,38rem)] rounded-md border bg-muted px-3 py-2">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  Tenker ...
                </div>
                <MarkdownViewer content={streamingMessage} className="text-sm" />
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
        <div className="border-t p-3">
          <form onSubmit={onSubmit}>
            <textarea
              value={chatInput}
              onChange={(e) => onChatInputChange(e.target.value)}
              placeholder="Skriv en melding..."
              className="mb-2 min-h-16 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Svar bygger på hele prosjektkonteksten.
              </p>
              <Button type="submit" disabled={busy}>
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
