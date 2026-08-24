import { notFound } from "next/navigation";

import { AdminConsole } from "@/components/admin/admin-console";
import { requireAdmin } from "@/lib/server/authorization";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  try {
    await requireAdmin();
    return <AdminConsole />;
  } catch {
    notFound();
  }
}
