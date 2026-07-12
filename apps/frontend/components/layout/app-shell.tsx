"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { ChevronDown, Layers3, LogOut } from "lucide-react";

import { AppHeaderLogo } from "@/components/layout/app-header-logo";

function isIsolatedChatPath(pathname: string) {
  return /^\/projects\/[^/]+\/chat\/?$/.test(pathname);
}

function shouldShowAppHeader(pathname: string) {
  return pathname !== "/login" && !isIsolatedChatPath(pathname);
}

export function AppShell({ children, displayName }: { children: ReactNode; displayName?: string | null }) {
  const pathname = usePathname() ?? "";
  const showHeader = shouldShowAppHeader(pathname);
  const isolatedChatWindow = isIsolatedChatPath(pathname);
  const [loggingOut, setLoggingOut] = useState(false);

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
              <Link
                href="/service-descriptions"
                className="inline-flex h-8 items-center gap-2 rounded-md border border-white/15 bg-white/[0.06] px-3 text-sm font-semibold text-slate-100 transition-colors hover:border-white/30 hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
              >
                <Layers3 className="size-4" />
                <span className="hidden sm:inline">Tjenestebeskrivelser</span>
              </Link>
              {displayName ? (
                <details className="group relative border-l border-white/15 pl-3">
                  <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg py-1 pr-1 outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-blue-200 [&::-webkit-details-marker]:hidden" aria-label={`Brukermeny for ${displayName}`}>
                    <span className="grid size-8 place-items-center rounded-full border border-blue-300/30 bg-blue-400/15 text-xs font-bold uppercase text-blue-100 shadow-inner">
                      {displayName.trim().charAt(0)}
                    </span>
                    <span className="hidden max-w-48 truncate text-sm font-medium text-slate-200 md:block">{displayName}</span>
                    <ChevronDown className="hidden size-3.5 text-slate-400 transition-transform group-open:rotate-180 md:block" />
                  </summary>
                  <div className="absolute right-0 top-[calc(100%+0.55rem)] min-w-48 overflow-hidden rounded-lg border border-slate-200 bg-white p-1.5 text-slate-900 shadow-xl shadow-slate-950/20">
                    <div className="border-b border-slate-100 px-2.5 py-2 md:hidden">
                      <p className="max-w-44 truncate text-xs font-semibold">{displayName}</p>
                    </div>
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
