import { NextResponse } from "next/server";

import { createLivenessModel } from "@/lib/server/health";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(createLivenessModel(), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
