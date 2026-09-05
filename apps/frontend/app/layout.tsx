import { AppShell } from "@/components/layout/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AUTH_DISPLAY_NAME_HEADER,
  AUTH_IDENTITY_TYPE_HEADER,
  AUTH_IS_ADMIN_HEADER,
  AUTH_VERIFIED_HEADER,
} from "@/lib/password-auth";
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Schibsted_Grotesk } from "next/font/google";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import "./globals.css";

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-sans",
});

const displayFont = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-schibsted-grotesk",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-plex-mono",
});

const documentFontVariables = [
  ibmPlexSans.variable,
  displayFont.variable,
  ibmPlexMono.variable,
].join(" ");

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
  const displayName = requestHeaders.get(AUTH_DISPLAY_NAME_HEADER);
  const authenticated = requestHeaders.get(AUTH_VERIFIED_HEADER) === "1";
  const identityType = requestHeaders.get(AUTH_IDENTITY_TYPE_HEADER);
  const isAdmin = requestHeaders.get(AUTH_IS_ADMIN_HEADER) === "1";

  return (
    <html lang="no" className={documentFontVariables}>
      <body
        className="min-h-screen bg-background text-foreground antialiased"
      >
        <TooltipProvider>
          <AppShell
            authenticated={authenticated}
            displayName={displayName}
            isAdmin={isAdmin}
            identityType={identityType === "guest" ? "guest" : "internal"}
          >
            {children}
          </AppShell>
        </TooltipProvider>
      </body>
    </html>
  );
}
