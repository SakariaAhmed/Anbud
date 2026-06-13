import { createReadinessModel, healthJsonResponse } from "@/lib/server/health";

export const dynamic = "force-dynamic";

export async function GET() {
  return healthJsonResponse(await createReadinessModel());
}
