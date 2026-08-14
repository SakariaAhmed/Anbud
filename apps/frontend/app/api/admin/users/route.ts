import { NextResponse } from "next/server";

import {
  listPrincipals,
  setAdminStatus,
} from "@/lib/server/access-control-repository";
import { recordActivity } from "@/lib/server/activity";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ users: await listPrincipals() });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json({ error: "Kunne ikke hente brukere." }, { status: 500 })
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const principal = await requireAdmin();
    const body = (await request.json()) as {
      principalId?: unknown;
      isAdmin?: unknown;
    };
    if (
      typeof body.principalId !== "string" ||
      typeof body.isAdmin !== "boolean"
    ) {
      return NextResponse.json({ error: "Ugyldige brukerroller." }, { status: 400 });
    }
    if (
      body.principalId === principal.id &&
      !body.isAdmin
    ) {
      return NextResponse.json(
        { error: "Du kan ikke fjerne din egen administratorrolle." },
        { status: 400 },
      );
    }
    await setAdminStatus({
      principalId: body.principalId,
      isAdmin: body.isAdmin,
      grantedBy: principal.id,
    });
    await recordActivity({
      principal,
      action: "admin.user.roles_update",
      entityType: "principal",
      entityId: body.principalId,
      metadata: { isAdmin: body.isAdmin },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke endre roller.") },
        { status: 400 },
      )
    );
  }
}
