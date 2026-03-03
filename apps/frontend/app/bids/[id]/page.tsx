import { notFound } from "next/navigation";

import { BidWorkspace } from "@/components/bid-workspace";
import { getBid, getBidDocuments, getBidEvents, getBidNotes } from "@/lib/api";

interface BidPageProps {
  params: Promise<{ id: string }>;
}

export default async function BidPage({ params }: BidPageProps) {
  const { id } = await params;

  try {
    const [bid, documents, events, notes] = await Promise.all([getBid(id), getBidDocuments(id), getBidEvents(id), getBidNotes(id)]);

    return (
      <div className="content-stack">
        <BidWorkspace initialBid={bid} initialDocuments={documents} initialEvents={events} initialNotes={notes} />
      </div>
    );
  } catch {
    notFound();
  }
}
