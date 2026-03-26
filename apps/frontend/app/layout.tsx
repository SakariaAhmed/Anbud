import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "ANBUD",
  description: "Kundeanalyse, løsningsvurdering, generator og sparring for tilbudsteam i komplekse kundeprosjekter.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="no">
      <body className="min-h-screen bg-background text-foreground">
        <div className="min-h-screen">
          <header className="border-b border-border/60 bg-background/95">
            <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center px-4 md:px-6">
              <Link
                href="/"
                className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-700 transition hover:text-slate-950"
              >
                Anbud
              </Link>
            </div>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
