import { NewBidForm } from "@/components/new-bid-form";
import { PrefetchLink } from "@/components/prefetch-link";
import { getRecentBidsForPage } from "@/lib/server/bid-reads";

export default async function HomePage() {
  const recent = await getRecentBidsForPage(5);

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
          <PrefetchLink className="text-link" eager href="/bids">
            View all bids
          </PrefetchLink>
        </div>

        {recent.length ? (
          <ul className="recent-list">
            {recent.map((bid) => (
              <li key={bid.id}>
                <PrefetchLink href={`/bids/${bid.id}`} workspaceBidId={bid.id}>
                  <strong>{bid.customer_name}</strong>
                  <span>{bid.title}</span>
                </PrefetchLink>
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
