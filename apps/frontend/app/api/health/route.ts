import { createReadinessModel, healthJsonResponse } from "@/lib/server/health";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";
import { NextResponse } from "next/server";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    return healthJsonResponse(await createReadinessModel());
  } catch (error) {
    return authorizationErrorResponse(error) ?? NextResponse.json(
      { error: productionSafeErrorMessage(error, "Kunne ikke hente systemstatus.") },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
