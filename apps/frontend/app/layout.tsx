import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";

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
  const isHomeRoute = pathname === "/";

  return (
    <html lang="no">
      <body
        className="min-h-screen bg-background text-foreground antialiased"
        data-route={isHomeRoute ? "home" : undefined}
      >
        <TooltipProvider>
          <AppShell>{children}</AppShell>
        </TooltipProvider>
      </body>
    </html>
  );
}
