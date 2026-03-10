import { BidWorkspacePage } from "@/components/bid-workspace-page";

interface BidPageProps {
  params: Promise<{ id: string }>;
}

export default async function BidPage({ params }: BidPageProps) {
  const { id } = await params;
  return <BidWorkspacePage bidId={id} />;
}
