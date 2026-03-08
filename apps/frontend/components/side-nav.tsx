"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Bid } from "@/lib/types";

const API_BASE = "";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname.startsWith(href);
}

export function SideNav() {
  const pathname = usePathname();
  const [recentBids, setRecentBids] = useState<Bid[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadRecentBids() {
      try {
        const response = await fetch(`${API_BASE}/api/v1/bids?limit=6`, {
          headers: {
            "x-tenant-id": "default"
          }
        });
        if (!response.ok) {
          return;
        }
        const items = (await response.json()) as Bid[];
        if (!cancelled) {
          setRecentBids(items);
        }
      } catch {
        if (!cancelled) {
          setRecentBids([]);
        }
      }
    }

    void loadRecentBids();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside className="side-nav" aria-label="Primary">
      <div className="side-nav-inner">
        <div className="brand-block">
          <p className="brand-kicker">Bid Workspace</p>
          <p className="brand-title">ANBUD</p>
        </div>

        <nav>
          <ul className="side-nav-list">
            <li>
              <Link className={`side-link ${isActive(pathname, "/") ? "active" : ""}`} href="/">
                Dashboard
              </Link>
            </li>
            <li>
              <Link className={`side-link ${isActive(pathname, "/bids") ? "active" : ""}`} href="/bids">
                All Bids
              </Link>
            </li>
          </ul>
        </nav>

        <section className="side-recent">
          <h3>Recent Bids</h3>
          {recentBids.length ? (
            <ul>
              {recentBids.map((bid) => (
                <li key={bid.id}>
                  <Link className={`recent-link ${pathname === `/bids/${bid.id}` ? "active" : ""}`} href={`/bids/${bid.id}`}>
                    <strong>{bid.customer_name}</strong>
                    <span>{bid.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p>No recent bids yet.</p>
          )}
        </section>
      </div>
    </aside>
  );
}
