import { BidList } from "@/components/bid-list";
import { getBidsForPage } from "@/lib/server/bid-reads";

export default async function BidsPage() {
  const bids = await getBidsForPage();

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
