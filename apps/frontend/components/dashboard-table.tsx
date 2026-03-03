import Link from "next/link";

import { DashboardRow } from "@/lib/types";
import { PhaseBadge } from "@/components/phase-badge";

interface DashboardTableProps {
  rows: DashboardRow[];
}

export function DashboardTable({ rows }: DashboardTableProps) {
  if (!rows.length) {
    return <p className="empty-state">No tenders found for this tenant.</p>;
  }

  return (
    <div className="table-shell">
      <table className="ops-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Phase</th>
            <th>Deadline</th>
            <th>Blockers</th>
            <th>Next Action</th>
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tender_id} className={row.overdue ? "row-overdue" : row.negotiation_highlight ? "row-negotiation" : ""}>
              <td>
                <Link className="customer-link" href={`/tenders/${row.tender_id}`}>
                  <strong>{row.customer}</strong>
                  <span>{row.title}</span>
                </Link>
              </td>
              <td>
                <PhaseBadge phase={row.phase} />
              </td>
              <td>{row.deadline}</td>
              <td>{row.blockers}</td>
              <td>{row.next_action}</td>
              <td>
                <span className={Number(row.risk_score) >= 7 ? "risk-high" : Number(row.risk_score) >= 4 ? "risk-mid" : "risk-low"}>
                  {row.risk_score}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
