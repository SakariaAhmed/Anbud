import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppHeaderSidebarOffset } from "@/components/layout/app-header-sidebar-offset";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

export const metadata: Metadata = {
  title: "BIDSITE",
  description:
    "Kundeanalyse og generator for tilbudsteam i komplekse kundeprosjekter.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="no">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TooltipProvider>
          <AppHeaderSidebarOffset />
          <div className="min-h-screen">
            <header className="sticky top-0 z-40 border-b border-slate-700/50 bg-slate-900 shadow-md">
              <div className="flex h-[var(--app-header-height)] w-full items-center justify-between pr-6 pl-[calc(var(--app-header-sidebar-offset)+1.25rem)] transition-[padding] duration-300 ease-out lg:pr-10">
                <div className="flex items-center gap-8">
                  <Link href="/" className="brand-logo text-white">
                    BIDSITE
                  </Link>
                  <div className="hidden h-5 w-px bg-slate-600 sm:block" />
                  <nav className="hidden items-center gap-6 sm:flex">
                    <Link
                      href="/"
                      className="text-[13px] font-medium text-slate-300 transition-colors hover:text-white"
                    >
                      Prosjekter
                    </Link>
                    <Link
                      href="/projects/new"
                      className="text-[13px] font-medium text-slate-300 transition-colors hover:text-white"
                    >
                      Ny analyse
                    </Link>
                  </nav>
                </div>
                <div className="flex items-center gap-3">
                  <div className="hidden items-center gap-2 rounded-md bg-slate-800 px-3 py-1.5 text-xs text-slate-400 sm:flex">
                    <span>Enterprise</span>
                    <span className="inline-block size-1.5 rounded-full bg-emerald-400" />
                  </div>
                </div>
              </div>
            </header>
            <main className="site-reload-enter">{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
