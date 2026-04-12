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
            <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-sm">
              <div className="flex h-[var(--app-header-height)] w-full items-center justify-between pr-4 pl-[calc(var(--app-header-sidebar-offset)+1rem)] transition-[padding] duration-300 ease-out lg:pr-8">
                <Link
                  href="/"
                  className="text-sm font-bold uppercase tracking-[0.15em] text-foreground transition-colors hover:text-primary"
                >
                  BIDSITE
                </Link>
                <nav className="flex items-center gap-6">
                  <Link
                    href="/"
                    className="text-sm font-medium text-foreground/70 transition-colors hover:text-foreground"
                  >
                    Prosjekter
                  </Link>
                  <Link
                    href="/projects/new"
                    className="text-sm font-medium text-foreground/70 transition-colors hover:text-foreground"
                  >
                    Ny analyse
                  </Link>
                </nav>
              </div>
            </header>
            <main>{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
