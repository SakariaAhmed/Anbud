import Link from "next/link";

import { NewBidForm } from "@/components/new-bid-form";
import { getBids } from "@/lib/api";

export default async function HomePage() {
  const bids = await getBids();
  const recent = bids.slice(0, 5);

  return (
    <div className="content-stack">
      <header className="page-header">
        <div>
          <p className="kicker">Dashboard</p>
          <h1>Bid Control Center</h1>
          <p className="subtle">Create bids quickly, upload documents, and ask practical AI questions grounded in your files.</p>
        </div>
      </header>

      <NewBidForm />

      <section className="panel">
        <div className="panel-head">
          <h2>Recent Bids</h2>
          <Link className="text-link" href="/bids">
            View all bids
          </Link>
        </div>

        {recent.length ? (
          <ul className="recent-list">
            {recent.map((bid) => (
              <li key={bid.id}>
                <Link href={`/bids/${bid.id}`}>
                  <strong>{bid.customer_name}</strong>
                  <span>{bid.title}</span>
                </Link>
                <span>{bid.deadline}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-copy">No bids yet.</p>
        )}
      </section>
    </div>
  );
}
