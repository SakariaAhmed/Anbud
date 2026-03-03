import { redirect } from "next/navigation";

interface LegacyTenderPageProps {
  params: Promise<{ id: string }>;
}

export default async function LegacyTenderPage({ params }: LegacyTenderPageProps) {
  const { id } = await params;
  redirect(`/bids/${id}`);
}
