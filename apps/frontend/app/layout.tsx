import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

export const metadata: Metadata = {
  title: "ANBUD",
  description:
    "Kundeanalyse og generator for tilbudsteam i komplekse kundeprosjekter.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="no">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TooltipProvider>
          <div className="min-h-screen">
            <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-sm">
              <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 lg:px-0">
                <Link
                  href="/"
                  className="text-sm font-bold uppercase tracking-[0.15em] text-foreground transition-colors hover:text-primary"
                >
                  Anbud
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
