import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "ANBUD",
  description: "Bilag 1 og Bilag 2 analysert til kravmatrise og compliance-kontroll",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={`${plexSans.variable} ${plexMono.variable}`} lang="no">
      <body>{children}</body>
    </html>
  );
}
