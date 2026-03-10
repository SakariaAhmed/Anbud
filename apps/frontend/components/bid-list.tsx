import { PrefetchLink } from "@/components/prefetch-link";
import { Bid } from "@/lib/types";

export function BidList({ bids }: { bids: Bid[] }) {
  if (!bids.length) {
    return <p className="muted-copy">No bids yet. Create one from the dashboard.</p>;
  }

  return (
    <div className="table-shell">
      <table className="data-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Title</th>
            <th>Deadline</th>
            <th>Owner</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {bids.map((bid) => (
            <tr key={bid.id}>
              <td>
                <PrefetchLink className="table-link" href={`/bids/${bid.id}`} workspaceBidId={bid.id}>
                  {bid.customer_name}
                </PrefetchLink>
              </td>
              <td>{bid.title}</td>
              <td>{bid.deadline}</td>
              <td>{bid.owner}</td>
              <td>{new Date(bid.updated_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
