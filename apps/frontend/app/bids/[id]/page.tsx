import { BidWorkspacePage } from "@/components/bid-workspace-page";
import { getBidForPage } from "@/lib/server/bids-db";

export const dynamic = "force-dynamic";

interface BidPageProps {
  params: Promise<{ id: string }>;
}

export default async function BidPage({ params }: BidPageProps) {
  const { id } = await params;
  const data = await getBidForPage(id);

  return <BidWorkspacePage initialData={data} />;
}
