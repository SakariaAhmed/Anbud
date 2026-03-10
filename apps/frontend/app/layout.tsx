import type { Metadata } from "next";
import { IBM_Plex_Sans, Oswald } from "next/font/google";
import type { ReactNode } from "react";

import { SideNav } from "@/components/side-nav";
import { getRecentBidsForPage } from "@/lib/server/bid-reads";

import "./globals.css";

const display = Oswald({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display"
});

const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body"
});

export const metadata: Metadata = {
  title: "ANBUD",
  description: "Simple bid workspace with document-grounded AI chat"
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const recentBids = await getRecentBidsForPage();

  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable}`}>
        <div className="app-shell">
          <SideNav recentBids={recentBids} />
          <main className="page-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
