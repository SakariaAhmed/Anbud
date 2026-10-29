import { NextResponse } from "next/server";

import {
  requireRequestPrincipal,
} from "@/lib/server/authorization";
import { routeErrorResponse } from "@/lib/server/api-responses";

export async function GET() {
  try {
    const principal = await requireRequestPrincipal();
    return NextResponse.json(principal, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke hente bruker.");
  }
}
