"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useState, type ReactNode } from "react";
import {
  BriefcaseBusiness,
  ChevronDown,
  CircleUserRound,
  KeyRound,
  LogOut,
  ShieldCheck,
} from "lucide-react";

import { AppHeaderLogo } from "@/components/layout/app-header-logo";

function isIsolatedChatPath(pathname: string) {
  return /^\/projects\/[^/]+\/chat\/?$/.test(pathname);
}

function shouldShowAppHeader(pathname: string) {
  return pathname !== "/login" && !isIsolatedChatPath(pathname);
}

export function AppShell({
  authenticated,
  children,
  displayName,
  isAdmin = false,
  identityType = "internal",
}: {
  authenticated?: boolean;
  children: ReactNode;
  displayName?: string | null;
  isAdmin?: boolean;
  identityType?: "internal" | "guest";
}) {
  const pathname = usePathname() ?? "";
  const showHeader = shouldShowAppHeader(pathname);
  const isolatedChatWindow = isIsolatedChatPath(pathname);
  const [loggingOut, setLoggingOut] = useState(false);
  const userLabel = displayName?.trim() || "Bruker";
  const visibleRoleLabels = isAdmin ? ["Administrator"] : [];

  async function logOut() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  useLayoutEffect(() => {
    if (pathname === "/") {
      document.body.dataset.route = "home";
    } else {
      delete document.body.dataset.route;
    }
  }, [pathname]);

  if (isolatedChatWindow) {
    return <div className="min-h-screen">{children}</div>;
  }

  return (
    <div className="min-h-screen">
      {showHeader ? (
        <header
          className="fixed inset-x-0 top-0 z-[60] border-b border-slate-700/50 bg-slate-900 shadow-md"
          data-app-header="true"
        >
          <div className="flex h-[var(--app-header-height)] w-full items-center justify-between px-6 lg:px-10">
            <div className="flex items-center gap-8">
              <AppHeaderLogo />
            </div>
            <div className="flex items-center gap-3">
              {isAdmin ? (
                <Link
                  href="/admin"
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-cyan-300/25 bg-cyan-300/[0.08] px-3 text-sm font-semibold text-cyan-50 transition-colors hover:bg-cyan-300/[0.15] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
                >
                  <ShieldCheck className="size-4" />
                  <span className="hidden sm:inline">Styring og innsikt</span>
                </Link>
              ) : null}
              {authenticated ? (
                <details className="group relative border-l border-white/15 pl-3">
                  <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg py-1 pr-1 outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-blue-200 [&::-webkit-details-marker]:hidden" aria-label={`Brukermeny for ${userLabel}`}>
                    <span className="grid size-8 place-items-center rounded-full border border-blue-300/30 bg-blue-400/15 text-xs font-bold uppercase text-blue-100 shadow-inner">
                      {userLabel.charAt(0)}
                    </span>
                    <span className="hidden max-w-48 truncate text-sm font-medium text-slate-200 md:block">{userLabel}</span>
                    <ChevronDown className="hidden size-3.5 text-slate-400 transition-transform group-open:rotate-180 md:block" />
                  </summary>
                  <div className="absolute right-0 top-[calc(100%+0.5rem)] w-60 overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-900 shadow-xl shadow-slate-950/20">
                    <div className="px-3 py-2.5">
                      <p className="truncate text-sm font-semibold text-slate-950">
                        {userLabel}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-500">
                        {identityType === "guest" ? (
                          <KeyRound className="size-3 shrink-0" />
                        ) : (
                          <ShieldCheck className="size-3 shrink-0" />
                        )}
                        <span>
                          {identityType === "guest"
                            ? "Gjestekonto"
                            : "Microsoft-konto"}
                          {visibleRoleLabels.length
                            ? ` · ${visibleRoleLabels.join(" · ")}`
                            : ""}
                        </span>
                      </p>
                    </div>
                    <nav className="border-t border-slate-100 p-1.5" aria-label="Brukernavigasjon">
                      <Link
                        href="/profile"
                        className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <CircleUserRound className="size-4 text-slate-500" />
                        Min profil
                      </Link>
                      <Link
                        href="/"
                        className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <BriefcaseBusiness className="size-4 text-slate-500" />
                        Mine prosjekter
                      </Link>
                      {isAdmin ? (
                        <Link
                          href="/admin"
                          className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                        >
                          <ShieldCheck className="size-4 text-slate-500" />
                          Styring og innsikt
                        </Link>
                      ) : null}
                    </nav>
                    <div className="border-t border-slate-100 p-1.5">
                      <button
                        type="button"
                        onClick={() => void logOut()}
                        disabled={loggingOut}
                        className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-wait disabled:opacity-60"
                      >
                        <LogOut className="size-4 text-slate-500" />
                        {loggingOut ? "Logger ut …" : "Logg ut"}
                      </button>
                    </div>
                  </div>
                </details>
              ) : null}
            </div>
          </div>
        </header>
      ) : null}
      <main className={showHeader ? "site-reload-enter pt-[var(--app-header-height)]" : undefined}>
        {children}
      </main>
    </div>
  );
}
