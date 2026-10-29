import { createReadinessModel, healthJsonResponse } from "@/lib/server/health";
import {
  requireAdmin,
} from "@/lib/server/authorization";
import { routeErrorResponse } from "@/lib/server/api-responses";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    return healthJsonResponse(await createReadinessModel());
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke hente systemstatus.", { headers: { "Cache-Control": "no-store" } });
  }
}
