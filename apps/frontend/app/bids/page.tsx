import { BidList } from "@/components/bid-list";
import { getBids } from "@/lib/api";

export default async function BidsPage() {
  const bids = await getBids();

  return (
    <div className="content-stack">
      <header className="page-header">
        <div>
          <p className="kicker">All Bids</p>
          <h1>All Bid Projects</h1>
          <p className="subtle">Open any bid to review overview, documents, conversation, and event history.</p>
        </div>
      </header>

      <section className="panel">
        <BidList bids={bids} />
      </section>
    </div>
  );
}
