"use client";

import { FormEvent, RefObject } from "react";
import { ArrowUp, Bot, LoaderCircle, Sparkles, User2 } from "lucide-react";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/projects/primitives";
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
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="overflow-hidden border border-slate-200/80 bg-white shadow-none">
        <CardHeader className="border-b border-slate-200/80 bg-[linear-gradient(180deg,_rgba(248,250,252,0.95)_0%,_rgba(255,255,255,0.98)_100%)] pb-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="text-2xl font-semibold text-slate-950">Sparring med prosjektkontekst</CardTitle>
              <CardDescription className="mt-2 max-w-3xl text-base leading-7 text-slate-600">
                Chatten bruker kundedokument, analyse, løsningsvurdering og tidligere meldinger som kontekst.
              </CardDescription>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-sm text-sky-700">
              <Sparkles className="size-4" />
              Prosjektbevisst sparring
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div
            ref={chatContainerRef}
            className="flex max-h-[640px] flex-col gap-6 overflow-y-auto bg-[linear-gradient(180deg,_rgba(248,250,252,0.6)_0%,_rgba(255,255,255,1)_18%,_rgba(255,255,255,1)_100%)] px-5 py-6 md:px-8"
          >
            {chatMessages.map((message) => (
              <div
                key={message.id}
                className={`flex w-full items-start gap-4 ${
                  message.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                {message.role === "assistant" ? (
                  <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
                    <Bot className="size-4" />
                  </div>
                ) : null}
                <div
                  className={`max-w-[min(100%,48rem)] rounded-[24px] px-5 py-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] ${
                    message.role === "user"
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-800"
                  }`}
                >
                  <MarkdownViewer
                    content={message.content}
                    tone={message.role === "user" ? "inverse" : "default"}
                    className="text-[15px]"
                  />
                </div>
                {message.role === "user" ? (
                  <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700">
                    <User2 className="size-4" />
                  </div>
                ) : null}
              </div>
            ))}
            {streamingMessage ? (
              <div className="flex w-full items-start gap-4">
                <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
                  <Bot className="size-4" />
                </div>
                <div className="max-w-[min(100%,48rem)] rounded-[24px] border border-slate-200 bg-white px-5 py-4 text-slate-800 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
                  <div className="mb-3 flex items-center gap-2 text-sm text-slate-500">
                    <LoaderCircle className="size-4 animate-spin" />
                    Tenker ...
                  </div>
                  <MarkdownViewer content={streamingMessage} className="text-[15px]" />
                </div>
              </div>
            ) : null}
            {chatMessages.length === 0 && !streamingMessage ? (
              <div className="rounded-[28px] border border-dashed border-slate-300 bg-white/80 p-8 text-slate-600">
                <p className="text-lg font-semibold text-slate-900">Ingen meldinger ennå</p>
                <p className="mt-3 text-base leading-8">
                  Start med å spørre hva kunden egentlig prøver å få til, hvor løsningen er svak, eller hvordan dere bør
                  posisjonere dere.
                </p>
              </div>
            ) : null}
          </div>

          <div className="border-t border-slate-200/80 bg-white/96 px-5 py-5 backdrop-blur md:px-8">
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="rounded-[28px] border border-slate-200 bg-slate-50/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
                <textarea
                  value={chatInput}
                  onChange={(event) => onChatInputChange(event.target.value)}
                  placeholder="Hva prøver kunden egentlig å få til? Hvor er løsningen svak? Hvordan bør vi posisjonere oss?"
                  className="min-h-28 w-full resize-none bg-transparent px-2 py-2 text-base leading-7 text-slate-900 outline-none placeholder:text-slate-400"
                />
                <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-2 pt-3">
                  <p className="text-sm text-slate-500">Svarene rendres som Markdown og bygger på hele prosjektkonteksten.</p>
                  <Button type="submit" size="lg" disabled={busy} className="min-w-40 rounded-full px-5">
                    {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
                    Send melding
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-slate-200/80 bg-[#0c172b] text-white shadow-none">
        <CardHeader className="border-b border-white/10 pb-4">
          <CardTitle className="text-xl font-semibold">Bruk sparringen til</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-5 text-sm leading-7 text-slate-300">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            Få hjelp til å tolke kunden, skille mellom eksplisitte og implisitte behov og se hva som mest sannsynlig blir
            vektlagt i evalueringen.
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            Stress-test løsningsretningen før dere skriver mer tekst. Spør om risiko, tillit, verdi og hvor
            konkurrenter kan være sterkere.
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            Bruk også chatten som kvalitetssikring av generatorutkast, ikke bare som en tekstmaskin.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
