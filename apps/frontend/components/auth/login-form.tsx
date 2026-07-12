"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  FileCheck2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeRedirectPath } from "@/lib/auth-redirect";

function MicrosoftMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-[18px] shrink-0 grid-cols-2 gap-[2px]"
    >
      <span className="bg-[#f25022]" />
      <span className="bg-[#7fba00]" />
      <span className="bg-[#00a4ef]" />
      <span className="bg-[#ffb900]" />
    </span>
  );
}

type LoginFormProps = {
  initialError?: string;
  microsoftEnabled: boolean;
  nextPath: string;
};

export function LoginForm({
  initialError,
  microsoftEnabled,
  nextPath,
}: LoginFormProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [loading, setLoading] = useState(false);
  const [microsoftLoading, setMicrosoftLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(!microsoftEnabled);
  const normalizedNextPath = safeRedirectPath(nextPath);
  const microsoftHref = `/api/auth/microsoft?next=${encodeURIComponent(normalizedNextPath)}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password,
          next: normalizedNextPath,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        redirectTo?: string;
      };

      if (!response.ok) {
        setError(payload.error || "Kunne ikke logge inn.");
        return;
      }

      window.location.replace(
        safeRedirectPath(payload.redirectTo || normalizedNextPath),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-stage relative min-h-screen overflow-hidden bg-[#071326] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden="true">
        <div className="absolute -left-32 top-[-18rem] size-[38rem] rounded-full bg-blue-500/15 blur-3xl" />
        <div className="absolute bottom-[-20rem] left-[32%] size-[42rem] rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="login-grid absolute inset-0" />
      </div>

      <div className="relative grid min-h-screen lg:grid-cols-[minmax(0,1.14fr)_minmax(27rem,0.86fr)]">
        <section className="login-brand-panel flex min-h-[24rem] flex-col px-6 py-7 sm:px-10 sm:py-9 lg:min-h-screen lg:px-[clamp(3rem,6vw,7.5rem)] lg:py-12">
          <div className="login-enter flex items-center gap-3">
            <Image
              src="/bidsite-logo.png"
              alt=""
              width={28}
              height={38}
              aria-hidden="true"
              priority
              className="h-8 w-auto drop-shadow-[0_5px_16px_rgba(59,130,246,0.45)]"
            />
            <span className="text-[1.35rem] font-semibold tracking-[-0.045em]">
              bidsite
            </span>
            <span className="ml-1 hidden rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 font-mono text-[0.62rem] uppercase tracking-[0.16em] text-slate-300 sm:inline-flex">
              Sikkert arbeidsområde
            </span>
          </div>

          <div className="my-auto max-w-[46rem] py-14 lg:py-20">
            <p className="login-enter login-enter-delay-1 mb-5 flex items-center gap-2 font-mono text-[0.68rem] font-medium uppercase tracking-[0.2em] text-blue-300">
              <span className="h-px w-8 bg-blue-400/70" />
              Tilbudsarbeid, samlet
            </p>
            <h1 className="login-enter login-enter-delay-2 max-w-[12ch] font-serif text-[clamp(2.6rem,5.6vw,5.8rem)] font-medium leading-[0.96] tracking-[-0.045em] text-white">
              Fra kundekrav til et skarpere tilbud.
            </h1>
            <p className="login-enter login-enter-delay-3 mt-7 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
              Ett sikkert arbeidsrom for analyse, kravbesvarelse og samarbeid i
              komplekse anskaffelser.
            </p>

            <div className="login-enter login-enter-delay-3 mt-10 hidden max-w-2xl grid-cols-[1fr_auto_1fr] items-center gap-4 sm:grid">
              <div className="rounded-xl border border-white/10 bg-white/[0.055] p-4 backdrop-blur-sm">
                <div className="mb-4 flex items-center justify-between">
                  <span className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-slate-400">
                    Kundegrunnlag
                  </span>
                  <FileCheck2 className="size-4 text-blue-300" />
                </div>
                <div className="space-y-2">
                  <span className="block h-1.5 w-full rounded-full bg-white/12" />
                  <span className="block h-1.5 w-4/5 rounded-full bg-white/10" />
                  <span className="block h-1.5 w-2/3 rounded-full bg-white/10" />
                </div>
              </div>
              <div className="login-flow-line flex items-center text-blue-300" aria-hidden="true">
                <Sparkles className="size-4" />
                <ArrowRight className="size-5" />
              </div>
              <div className="rounded-xl border border-blue-300/20 bg-blue-400/[0.09] p-4 backdrop-blur-sm">
                <div className="mb-4 flex items-center justify-between">
                  <span className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-blue-200">
                    Tilbudsrom
                  </span>
                  <ShieldCheck className="size-4 text-cyan-300" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <span className="h-8 rounded-md border border-white/10 bg-white/[0.06]" />
                  <span className="h-8 rounded-md border border-blue-300/20 bg-blue-300/10" />
                  <span className="h-8 rounded-md border border-white/10 bg-white/[0.06]" />
                </div>
              </div>
            </div>
          </div>

          <p className="hidden text-xs text-slate-500 lg:block">
            Beskyttet med virksomhetens identitetsplattform
          </p>
        </section>

        <section className="login-auth-panel flex items-center justify-center bg-[#f4f6f8] px-5 py-10 text-slate-950 sm:px-10 lg:min-h-screen lg:px-[clamp(2.5rem,5vw,6.5rem)]">
          <div className="login-card-enter w-full max-w-[27rem]">
            <div className="mb-9 flex size-11 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm">
              <LockKeyhole className="size-5 text-blue-700" />
            </div>
            <p className="mb-3 font-mono text-[0.66rem] font-semibold uppercase tracking-[0.18em] text-blue-700">
              Velkommen tilbake
            </p>
            <h2 className="font-serif text-[2.35rem] font-semibold leading-none tracking-[-0.035em] text-slate-950">
              Logg inn
            </h2>
            <p className="mt-4 max-w-sm text-[0.94rem] leading-6 text-slate-600">
              Bruk Microsoft-kontoen fra virksomheten din for sikker tilgang
              til arbeidsområdet.
            </p>

            {error ? (
              <div
                role="alert"
                className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm leading-5 text-rose-800"
              >
                {error}
              </div>
            ) : null}

            <button
              type="button"
              disabled={microsoftLoading}
              onClick={() => {
                if (!microsoftEnabled) {
                  setError(
                    "Microsoft-innlogging mangler lokal Entra-konfigurasjon. Bruk tilgangspassord inntil miljøvariablene er lagt inn.",
                  );
                  setShowPassword(true);
                  return;
                }

                setError("");
                setMicrosoftLoading(true);
                window.location.assign(microsoftHref);
              }}
              className="mt-7 flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-blue-500/30 disabled:cursor-wait"
            >
              {microsoftLoading ? (
                <LoaderCircle className="size-[18px] animate-spin text-blue-700" />
              ) : (
                <MicrosoftMark />
              )}
              {microsoftLoading
                ? "Kobler til Microsoft …"
                : "Fortsett med Microsoft"}
            </button>

            <div className="my-7 flex items-center gap-4" aria-hidden="true">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="font-mono text-[0.62rem] uppercase tracking-[0.15em] text-slate-400">
                Alternativ tilgang
              </span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <button
              type="button"
              aria-expanded={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
              className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-left text-sm font-semibold text-slate-700 outline-none transition-colors hover:text-slate-950 focus-visible:ring-3 focus-visible:ring-blue-500/25"
            >
              <span className="flex items-center gap-2">
                <KeyRound className="size-4 text-slate-500" />
                Bruk tilgangspassord
              </span>
              <ChevronDown
                className={`size-4 text-slate-400 transition-transform ${showPassword ? "rotate-180" : ""}`}
              />
            </button>

            {showPassword ? (
              <form onSubmit={onSubmit} className="mt-4">
                <div className="space-y-2">
                  <Label htmlFor="access-password" className="text-slate-700">
                    Tilgangspassord
                  </Label>
                  <Input
                    id="access-password"
                    type="password"
                    value={password}
                    autoComplete="current-password"
                    autoFocus={!microsoftEnabled}
                    required
                    onChange={(event) => setPassword(event.target.value)}
                    className="h-11 border-slate-300 bg-white px-3 text-slate-950 shadow-sm placeholder:text-slate-400 focus-visible:border-blue-600 focus-visible:ring-blue-600/20"
                  />
                </div>

                <Button
                  type="submit"
                  className="mt-4 h-11 w-full bg-slate-950 text-white hover:bg-blue-800"
                  disabled={loading}
                >
                  {loading ? (
                    <LoaderCircle data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <LockKeyhole data-icon="inline-start" />
                  )}
                  {loading ? "Logger inn …" : "Logg inn med passord"}
                </Button>
              </form>
            ) : null}

            <p className="mt-10 border-t border-slate-200 pt-5 text-xs leading-5 text-slate-500">
              Ved problemer med tilgang, kontakt administratoren for
              arbeidsområdet.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
