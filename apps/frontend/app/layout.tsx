import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

export const metadata: Metadata = {
  title: "bidsite",
  description:
    "Kundeanalyse og generator for tilbudsteam i komplekse kundeprosjekter.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="no">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TooltipProvider>
          <div className="min-h-screen">
            <header
              className="sticky top-0 z-[60] border-b border-slate-700/50 bg-slate-900 shadow-md"
              data-app-header="true"
            >
              <div className="flex h-[var(--app-header-height)] w-full items-center justify-between px-6 lg:px-10">
                <div className="flex items-center gap-8">
                  <Link
                    href="/"
                    className="brand-logo text-white"
                    data-brand-anchor="true"
                  >
                    bidsite
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
              </div>
            </header>
            <main className="site-reload-enter">{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
