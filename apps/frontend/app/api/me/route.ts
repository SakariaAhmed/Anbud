import { NextResponse } from "next/server";

import {
  authorizationErrorResponse,
  requireRequestPrincipal,
} from "@/lib/server/authorization";

export async function GET() {
  try {
    const principal = await requireRequestPrincipal();
    return NextResponse.json(principal, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json({ error: "Kunne ikke hente bruker." }, { status: 500 })
    );
  }
}
