import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { Layers3 } from "lucide-react";
import { AppHeaderLogo } from "@/components/layout/app-header-logo";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AUTH_COOKIE_NAME,
  AUTH_VERIFIED_HEADER,
  verifySessionToken,
} from "@/lib/password-auth";

import "./globals.css";

const CURRENT_PATH_HEADER = "x-current-pathname";

export const metadata: Metadata = {
  title: "bidsite",
  description:
    "Kundeanalyse og generator for tilbudsteam i komplekse kundeprosjekter.",
  icons: {
    icon: "/bidsite-logo.png",
    shortcut: "/bidsite-logo.png",
    apple: "/bidsite-logo.png",
  },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const pathname = requestHeaders.get(CURRENT_PATH_HEADER) ?? "";
  const authenticated =
    requestHeaders.get(AUTH_VERIFIED_HEADER) === "1" ||
    (await verifySessionToken(
      (await cookies()).get(AUTH_COOKIE_NAME)?.value,
    ));
  const isolatedChatWindow = /^\/projects\/[^/]+\/chat\/?$/.test(pathname);
  const isHomeRoute = pathname === "/";

  return (
    <html lang="no">
      <body
        className="min-h-screen bg-background text-foreground antialiased"
        data-route={isHomeRoute ? "home" : undefined}
      >
        <TooltipProvider>
          {authenticated && isolatedChatWindow ? (
            <div className="min-h-screen">{children}</div>
          ) : authenticated ? (
            <div className="min-h-screen">
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
