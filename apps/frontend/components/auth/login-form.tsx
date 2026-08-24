"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  ChevronDown,
  FileSearch,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Rows3,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeRedirectPath } from "@/lib/auth-redirect";

type LoginFormProps = {
  initialError?: string;
  microsoftEnabled: boolean;
  adminPasswordEnabled: boolean;
  nextPath: string;
};

type PendingMethod = "microsoft" | "guest" | "admin" | null;

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

const WORKFLOW = [
  {
    title: "Les kundegrunnlaget",
    description: "Samle krav, føringer og beslutningsgrunnlag.",
    icon: FileSearch,
  },
  {
    title: "Strukturer arbeidet",
    description: "Gjør analyse og kravbesvarelse sporbar.",
    icon: Rows3,
  },
  {
    title: "Lever med kontroll",
    description: "Hold team, kilder og versjoner i samme arbeidsrom.",
    icon: ShieldCheck,
  },
] as const;

export function LoginForm({
  initialError,
  microsoftEnabled,
  adminPasswordEnabled,
  nextPath,
}: LoginFormProps) {
  const [guestCode, setGuestCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [pending, setPending] = useState<PendingMethod>(null);
  const [showAdmin, setShowAdmin] = useState(
    !microsoftEnabled && adminPasswordEnabled,
  );
  const redirectPath = safeRedirectPath(nextPath);

  async function submitCredentials(
    endpoint: "/api/auth/guest" | "/api/auth/login",
    body: Record<string, string>,
    method: Exclude<PendingMethod, null | "microsoft">,
    fallbackError: string,
  ) {
    setError("");
    setPending(method);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, next: redirectPath }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        redirectTo?: string;
      };
      if (!response.ok) {
        setError(payload.error || fallbackError);
        return;
      }
      window.location.replace(
        safeRedirectPath(payload.redirectTo || redirectPath),
      );
    } catch {
      setError("Innloggingstjenesten svarer ikke. Prøv igjen.");
    } finally {
      setPending(null);
    }
  }

  function startMicrosoftLogin() {
    if (!microsoftEnabled) {
      setError(
        "Microsoft-innlogging er ikke konfigurert. Bruk administratorinnlogging dersom du har tilgang.",
      );
      setShowAdmin(adminPasswordEnabled);
      return;
    }
    setError("");
    setPending("microsoft");
    window.location.assign(
      `/api/auth/microsoft?next=${encodeURIComponent(redirectPath)}`,
    );
  }

  function submitGuest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitCredentials(
      "/api/auth/guest",
      { code: guestCode },
      "guest",
      "Kunne ikke logge inn med gjestekoden.",
    );
  }

  function submitAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitCredentials(
      "/api/auth/login",
      { password },
      "admin",
      "Kunne ikke logge inn.",
    );
  }

  return (
    <div className="login-stage relative min-h-screen overflow-hidden bg-[#071326] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden="true">
        <div className="login-orb absolute -left-32 top-[-18rem] size-[38rem] rounded-full bg-blue-500/15 blur-3xl" />
        <div className="login-orb login-orb--slow absolute bottom-[-20rem] left-[32%] size-[42rem] rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="login-grid absolute inset-0" />
      </div>

      <main className="relative grid min-h-screen lg:grid-cols-[minmax(0,1.14fr)_minmax(27rem,0.86fr)]">
        <section className="login-brand-panel flex min-h-[25rem] flex-col px-6 py-7 sm:px-10 sm:py-9 lg:min-h-screen lg:px-[clamp(3rem,6vw,7.5rem)] lg:py-12">
          <div className="login-enter flex items-center gap-3">
            <Image
              src="/bidsite-logo.png"
              alt=""
              width={28}
              height={38}
              aria-hidden="true"
              priority
              className="h-11 w-auto drop-shadow-[0_5px_16px_rgba(59,130,246,0.45)]"
            />
            <span className="text-[1.85rem] font-semibold tracking-[-0.045em]">
              bidsite
            </span>
          </div>

          <div className="my-auto max-w-[50rem] py-14 lg:py-16">
            <p className="login-enter login-enter-delay-1 mb-5 flex items-center gap-2 font-mono text-[0.68rem] font-medium uppercase tracking-[0.2em] text-blue-300">
              <span className="login-eyebrow-line h-px w-8 bg-blue-400/70" />
              Tilbudsarbeid, samlet
            </p>
            <h1 className="login-enter login-enter-delay-2 max-w-[17ch] font-serif text-[clamp(2.5rem,4.65vw,4.75rem)] font-bold leading-[1.02] tracking-[-0.03em] text-white">
              Fra kundekrav til et beslutningsklart tilbud.
            </h1>
            <p className="login-enter login-enter-delay-3 mt-7 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
              Et sikkert arbeidsrom for team som må forstå kunden, svare presist
              og dokumentere hvorfor tilbudet holder.
            </p>

            <div className="login-workflow login-enter login-enter-delay-3 mt-11 max-w-3xl">
              <span className="login-workflow-rail" aria-hidden="true">
                <span className="login-workflow-runner" />
              </span>
              <ol className="relative grid gap-3 sm:grid-cols-3">
                {WORKFLOW.map(({ title, description, icon: Icon }, index) => (
                  <li
                    key={title}
                    className={`login-workflow-card login-workflow-card--${index + 1} rounded-xl border border-white/10 bg-white/[0.055] p-4 backdrop-blur-sm`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`login-workflow-icon login-workflow-icon--${index + 1} grid size-8 place-items-center rounded-lg border border-blue-300/15 bg-blue-400/10 text-cyan-300`}>
                        <Icon className="size-4" />
                      </span>
                      <span className="font-mono text-[0.65rem] text-slate-500">
                        0{index + 1}
                      </span>
                    </div>
                    <p className="mt-4 text-sm font-semibold text-white">{title}</p>
                    <p className="mt-1.5 text-xs leading-5 text-slate-400">{description}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <p className="hidden text-xs text-slate-500 lg:block">
            Beskyttet med virksomhetens identitetsplattform
          </p>
        </section>

        <section className="login-auth-panel flex items-center justify-center bg-[#f4f6f8] px-5 py-10 text-slate-950 sm:px-10 lg:min-h-screen lg:px-[clamp(2.5rem,5vw,6.5rem)]">
          <div className="login-card-enter w-full max-w-[27rem]">
            <div className="login-card-item login-card-item--1 mb-9 flex size-11 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm">
              <LockKeyhole className="size-5 text-blue-700" />
            </div>
            <p className="login-card-item login-card-item--2 mb-3 font-mono text-[0.66rem] font-semibold uppercase tracking-[0.18em] text-blue-700">
              Sikker tilgang
            </p>
            <h2 className="login-card-item login-card-item--2 font-serif text-[2.35rem] font-bold leading-none tracking-[-0.025em] text-slate-950">
              Logg inn
            </h2>
            <p className="login-card-item login-card-item--3 mt-4 max-w-sm text-[0.94rem] leading-6 text-slate-600">
              Bruk Microsoft-kontoen din eller en personlig gjestekode fra
              prosjektansvarlig.
            </p>

            {error ? (
              <div
                role="alert"
                className="login-error-in mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm leading-5 text-rose-800"
              >
                {error}
              </div>
            ) : null}

            <button
              type="button"
              disabled={pending !== null}
              onClick={startMicrosoftLogin}
              className="login-card-item login-card-item--4 login-lift mt-7 flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-blue-500/30 disabled:cursor-wait disabled:opacity-60"
            >
              {pending === "microsoft" ? (
                <LoaderCircle className="size-[18px] animate-spin text-blue-700" />
              ) : (
                <MicrosoftMark />
              )}
              {pending === "microsoft" ? "Kobler til Microsoft …" : "Fortsett med Microsoft"}
            </button>

            <div className="login-card-item login-card-item--5 my-7 flex items-center gap-4" aria-hidden="true">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="font-mono text-[0.62rem] uppercase tracking-[0.15em] text-slate-400">
                Alternativ tilgang
              </span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <form onSubmit={submitGuest} className="login-card-item login-card-item--6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="guest-code" className="text-slate-700">Personlig gjestekode</Label>
                <Input
                  id="guest-code"
                  value={guestCode}
                  autoComplete="one-time-code"
                  spellCheck={false}
                  required
                  placeholder="gst_XXXXX-XXXXX-XXXXX"
                  onChange={(event) => setGuestCode(event.target.value)}
                  className="h-11 border-slate-300 bg-white px-3 font-mono text-sm uppercase tracking-wide text-slate-950 shadow-sm placeholder:text-[0.68rem] placeholder:tracking-normal placeholder:text-slate-400 focus-visible:border-blue-600 focus-visible:ring-blue-600/20"
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                className="login-lift h-11 w-full justify-between border-blue-200 bg-blue-50 px-3.5 text-blue-900 hover:bg-blue-100"
                disabled={pending !== null}
              >
                <span className="flex items-center gap-2">
                  {pending === "guest" ? <LoaderCircle className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                  {pending === "guest" ? "Kontrollerer …" : "Logg inn som gjest"}
                </span>
                <ArrowRight className="size-4" />
              </Button>
            </form>

            {adminPasswordEnabled ? (
              <div className="login-card-item login-card-item--7 mt-6 border-t border-slate-200 pt-5">
                <button
                  type="button"
                  aria-expanded={showAdmin}
                  onClick={() => setShowAdmin((value) => !value)}
                  className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-sm font-semibold text-slate-700 outline-none transition-colors hover:text-slate-950 focus-visible:ring-3 focus-visible:ring-blue-500/25"
                >
                  <span className="flex items-center gap-2"><KeyRound className="size-4 text-slate-500" />Administratorinnlogging</span>
                  <ChevronDown className={`size-4 text-slate-400 transition-transform ${showAdmin ? "rotate-180" : ""}`} />
                </button>
                {showAdmin ? (
                  <form onSubmit={submitAdmin} className="mt-4 space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="access-password" className="text-slate-700">Tilgangspassord</Label>
                      <Input
                        id="access-password"
                        type="password"
                        value={password}
                        autoComplete="current-password"
                        autoFocus={!microsoftEnabled}
                        required
                        onChange={(event) => setPassword(event.target.value)}
                        className="h-11 border-slate-300 bg-white px-3 text-slate-950 shadow-sm focus-visible:border-blue-600 focus-visible:ring-blue-600/20"
                      />
                    </div>
                    <Button type="submit" className="login-lift h-11 w-full bg-slate-950 text-white hover:bg-blue-800" disabled={pending !== null}>
                      {pending === "admin" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <LockKeyhole data-icon="inline-start" />}
                      {pending === "admin" ? "Logger inn …" : "Logg inn"}
                    </Button>
                  </form>
                ) : null}
              </div>
            ) : null}

            <p className="login-card-item login-card-item--7 mt-9 border-t border-slate-200 pt-5 text-xs leading-5 text-slate-500">
              Kontakt administratoren for arbeidsområdet dersom du mangler tilgang.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
