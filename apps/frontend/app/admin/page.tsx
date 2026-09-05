import { notFound, redirect } from "next/navigation";

import { AdminConsole } from "@/components/admin/admin-console";
import { AuthorizationError, requireAdmin } from "@/lib/server/authorization";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      // A saved /admin login destination must not turn a successful member login into a 404.
      if (error.status === 403) redirect("/");
      notFound();
    }
    throw error;
  }
  return <AdminConsole />;
}
