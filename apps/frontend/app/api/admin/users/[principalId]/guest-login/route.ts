import { NextResponse } from "next/server";

import {
  guestLoginProjectName,
  rotateGuestCode,
} from "@/lib/server/access-control-repository";
import { recordActivity } from "@/lib/server/activity";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";
import { maskEmail } from "@/lib/server/identity-crypto";
import { checkRateLimit } from "@/lib/server/observability";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;

export async function POST(
  request: Request,
  context: { params: Promise<{ principalId: string }> },
) {
  try {
    const administrator = await requireAdmin();
    const { principalId } = await context.params;
    if (!PRINCIPAL_ID_PATTERN.test(principalId)) {
      return NextResponse.json({ error: "Ugyldig gjestebruker." }, { status: 400 });
    }
    const rateLimit = await checkRateLimit(request, "admin-guest-login-rotate", {
      limit: 12,
      windowMs: 60_000,
      fallbackLimit: 6,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "For mange nye gjestekoder. Prøv igjen om litt." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }

    const result = await rotateGuestCode({
      principalId,
      rotatedBy: administrator.id,
      projectName: await guestLoginProjectName(principalId),
    });
    await recordActivity({
      principal: administrator,
      action: "admin.guest_login.rotate",
      entityType: "principal",
      entityId: principalId,
      metadata: {
        credentialVersion: result.version,
        emailDelivered: result.emailDelivery?.delivered ?? false,
      },
    });
    return NextResponse.json(
      {
        code: result.code,
        version: result.version,
        emailMasked: maskEmail(result.email),
        emailDelivery: result.emailDelivery,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        {
          error: productionSafeErrorMessage(
            error,
            "Kunne ikke opprette ny gjestekode.",
          ),
        },
        { status: 400 },
      )
    );
  }
}
