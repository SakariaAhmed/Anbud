"use client";

import { usePathname } from "next/navigation";

import { PrefetchLink } from "@/components/prefetch-link";
import { Bid } from "@/lib/types";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname.startsWith(href);
}

export function SideNav({ recentBids }: { recentBids: Bid[] }) {
  const pathname = usePathname();

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
              <PrefetchLink className={`side-link ${isActive(pathname, "/") ? "active" : ""}`} eager href="/">
                Dashboard
              </PrefetchLink>
            </li>
            <li>
              <PrefetchLink className={`side-link ${isActive(pathname, "/bids") ? "active" : ""}`} eager href="/bids">
                All Bids
              </PrefetchLink>
            </li>
          </ul>
        </nav>

        <section className="side-recent">
          <h3>Recent Bids</h3>
          {recentBids.length ? (
            <ul>
              {recentBids.map((bid) => (
                <li key={bid.id}>
                  <PrefetchLink
                    className={`recent-link ${pathname === `/bids/${bid.id}` ? "active" : ""}`}
                    eager
                    href={`/bids/${bid.id}`}
                    workspaceBidId={bid.id}
                  >
                    <strong>{bid.customer_name}</strong>
                    <span>{bid.title}</span>
                  </PrefetchLink>
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
