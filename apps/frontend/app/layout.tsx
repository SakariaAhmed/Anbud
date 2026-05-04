import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/password-auth";

import "./globals.css";

export const metadata: Metadata = {
  title: "bidsite",
  description:
    "Kundeanalyse og generator for tilbudsteam i komplekse kundeprosjekter.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const authenticated = await verifySessionToken(cookieStore.get(AUTH_COOKIE_NAME)?.value);

  return (
    <html lang="no">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TooltipProvider>
          {authenticated ? (
            <div className="min-h-screen">
              <header
                className="fixed inset-x-0 top-0 z-[60] border-b border-slate-700/50 bg-slate-900 shadow-md"
                data-app-header="true"
              >
                <div className="flex h-[var(--app-header-height)] w-full items-center justify-between px-6 lg:px-10">
                  <div className="flex items-center gap-8">
                    <Link
                      href="/"
                      className="brand-logo text-white"
                      data-brand-anchor="true"
                    >
                      <Image
                        src="/bidsite-logo.png"
                        alt=""
                        width={184}
                        height={249}
                        aria-hidden="true"
                        className="brand-logo__mark"
                        priority
                      />
                      <span className="brand-logo__wordmark">bidsite</span>
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
              <main className="site-reload-enter pt-[var(--app-header-height)]">
                {children}
              </main>
            </div>
          ) : (
            children
          )}
        </TooltipProvider>
      </body>
    </html>
  );
}
