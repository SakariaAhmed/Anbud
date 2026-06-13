import { createLivenessModel, healthJsonResponse } from "@/lib/server/health";

export const dynamic = "force-dynamic";

export function GET() {
  return healthJsonResponse(createLivenessModel());
}
