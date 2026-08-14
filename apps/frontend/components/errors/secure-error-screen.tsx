"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  House,
  KeyRound,
  RefreshCw,
  SearchX,
  ServerCrash,
  ShieldCheck,
  ShieldX,
} from "lucide-react";

type SecureErrorCode = "401" | "403" | "404" | "500";

type ErrorDefinition = {
  title: string;
  description: string;
  status: string;
  icon: LucideIcon;
  accent: "blue" | "amber" | "cyan" | "rose";
};

const ERROR_DEFINITIONS: Record<SecureErrorCode, ErrorDefinition> = {
  "401": {
    title: "Identiteten må bekreftes",
    description:
      "Logg inn for å fortsette. Vi viser ikke detaljer om den forespurte ressursen før identiteten din er bekreftet.",
    status: "Sikker økt kreves",
    icon: KeyRound,
    accent: "amber",
  },
  "403": {
    title: "Forespørselen ble stoppet",
    description:
      "Tilgangspolicyen tillater ikke denne handlingen. Gå tilbake, eller kontakt prosjekteier hvis du mener tilgangen bør endres.",
    status: "Tilgangsgrensen er aktiv",
    icon: ShieldX,
    accent: "rose",
  },
  "404": {
    title: "Ingen side å vise her",
    description:
      "Adressen kan være feil, flyttet eller utilgjengelig for kontoen din. Av sikkerhetshensyn bekrefter vi ikke om en beskyttet ressurs finnes.",
    status: "Ingen ressurs eksponert",
    icon: SearchX,
    accent: "cyan",
  },
  "500": {
    title: "Behandlingen ble avbrutt",
    description:
      "Noe gikk galt mens siden ble behandlet. Feilen er isolert, og tekniske detaljer holdes utenfor denne visningen.",
    status: "Sikker feilgrense aktiv",
    icon: ServerCrash,
    accent: "blue",
  },
};

const ACCENT_STYLES: Record<ErrorDefinition["accent"], string> = {
  amber: "border-amber-300/25 bg-amber-300/10 text-amber-100",
  blue: "border-blue-300/25 bg-blue-300/10 text-blue-100",
  cyan: "border-cyan-300/25 bg-cyan-300/10 text-cyan-100",
  rose: "border-rose-300/25 bg-rose-300/10 text-rose-100",
};

export function SecureErrorScreen({
  code,
  onRetry,
}: {
  code: SecureErrorCode;
  onRetry?: () => void;
}) {
  const router = useRouter();
  const definition = ERROR_DEFINITIONS[code];
  const Icon = definition.icon;
  const primaryHref = code === "401" ? "/login" : "/";
  const primaryLabel = code === "401" ? "Gå til innlogging" : "Gå til forsiden";

  return (
    <section className="error-stage" aria-labelledby={`error-title-${code}`}>
      <div className="error-stage__grid" aria-hidden="true" />
      <div className="error-stage__glow" aria-hidden="true" />

      <div className="error-stage__frame">
        <div className="error-stage__rail" aria-hidden="true">
          <span>bidsite</span>
          <span className="error-stage__rail-line" />
          <span>guarded response</span>
        </div>

        <div className="error-stage__content">
          <div className="error-stage__code" aria-hidden="true">
            {code}
          </div>

          <div className="error-stage__copy">
            <div
              className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[0.68rem] font-medium uppercase tracking-[0.16em] ${ACCENT_STYLES[definition.accent]}`}
            >
              <span className="relative flex size-2" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-35 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-current" />
              </span>
              {definition.status}
            </div>

            <div className="mt-6 flex items-start gap-4">
              <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.06] text-slate-100 shadow-inner shadow-white/[0.04]">
                <Icon className="size-5" aria-hidden="true" />
              </div>
              <div>
                <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-slate-500">
                  HTTP / {code}
                </p>
                <h1
                  id={`error-title-${code}`}
                  className="mt-2 max-w-2xl font-serif text-4xl font-medium leading-[1.04] tracking-[-0.035em] text-white sm:text-5xl lg:text-6xl"
                >
                  {definition.title}
                </h1>
              </div>
            </div>

            <p className="mt-6 max-w-xl text-base leading-7 text-slate-300 sm:text-lg sm:leading-8">
              {definition.description}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              {code === "500" && onRetry ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className="error-stage__primary-action"
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Prøv på nytt
                </button>
              ) : (
                <Link href={primaryHref} className="error-stage__primary-action">
                  {code === "401" ? (
                    <KeyRound className="size-4" aria-hidden="true" />
                  ) : (
                    <House className="size-4" aria-hidden="true" />
                  )}
                  {primaryLabel}
                </Link>
              )}

              {code === "500" ? (
                <Link href="/" className="error-stage__secondary-action">
                  <House className="size-4" aria-hidden="true" />
                  Forsiden
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => router.back()}
                  className="error-stage__secondary-action"
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Gå tilbake
                </button>
              )}
            </div>

            <div className="mt-10 flex max-w-xl items-start gap-3 border-t border-white/10 pt-5 text-sm leading-6 text-slate-500">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-300/80" aria-hidden="true" />
              <p>
                Denne feilvisningen inneholder ingen rutedata, ressurs-ID-er eller
                tekniske feildetaljer.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
