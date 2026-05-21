"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, type ReactNode } from "react";
import { Layers3 } from "lucide-react";

import { AppHeaderLogo } from "@/components/layout/app-header-logo";

function isIsolatedChatPath(pathname: string) {
  return /^\/projects\/[^/]+\/chat\/?$/.test(pathname);
}

function shouldShowAppHeader(pathname: string) {
  return pathname !== "/login" && !isIsolatedChatPath(pathname);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const showHeader = shouldShowAppHeader(pathname);
  const isolatedChatWindow = isIsolatedChatPath(pathname);

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
            <Link
              href="/service-descriptions"
              className="inline-flex h-8 items-center gap-2 rounded-md border border-white/15 bg-white/[0.06] px-3 text-sm font-semibold text-slate-100 transition-colors hover:border-white/30 hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
            >
              <Layers3 className="size-4" />
              <span className="hidden sm:inline">Tjenestebeskrivelser</span>
            </Link>
          </div>
        </header>
      ) : null}
      <main className={showHeader ? "site-reload-enter pt-[var(--app-header-height)]" : undefined}>
        {children}
      </main>
    </div>
  );
}
