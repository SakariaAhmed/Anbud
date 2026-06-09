import { NextResponse } from "next/server";

import { createReadinessModel, healthStatusCode } from "@/lib/server/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const model = await createReadinessModel();

  return NextResponse.json(model, {
    status: healthStatusCode(model),
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
