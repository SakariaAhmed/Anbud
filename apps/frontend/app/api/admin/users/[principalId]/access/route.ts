import { NextResponse } from "next/server";

import { isProjectRole } from "@/lib/access-control";
import {
  revokeAdminManagedProjectMember,
  updateAdminManagedProjectMemberRole,
} from "@/lib/server/access-control-repository";
import { recordActivity } from "@/lib/server/activity";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ principalId: string }> },
) {
  try {
    const principal = await requireAdmin();
    const { principalId } = await context.params;
    const body = (await request.json().catch(() => null)) as {
      projectId?: unknown;
      role?: unknown;
    } | null;
    if (
      !body ||
      typeof body.projectId !== "string" ||
      !UUID_PATTERN.test(body.projectId) ||
      !isProjectRole(body.role) ||
      body.role === "owner"
    ) {
      return NextResponse.json({ error: "Ugyldig prosjekttilgang." }, { status: 400 });
    }
    await updateAdminManagedProjectMemberRole({
      principalId,
      projectId: body.projectId,
      role: body.role,
      grantedBy: principal.id,
    });
    await recordActivity({
      principal,
      action: "admin.user.project_access_update",
      projectId: body.projectId,
      entityType: "principal",
      entityId: principalId,
      metadata: { role: body.role },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke endre tilgangen.") },
        { status: 400 },
      )
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ principalId: string }> },
) {
  try {
    const principal = await requireAdmin();
    const { principalId } = await context.params;
    const body = (await request.json().catch(() => null)) as {
      projectId?: unknown;
    } | null;
    if (
      !body ||
      typeof body.projectId !== "string" ||
      !UUID_PATTERN.test(body.projectId)
    ) {
      return NextResponse.json({ error: "Ugyldig prosjekt." }, { status: 400 });
    }
    await revokeAdminManagedProjectMember({
      projectId: body.projectId,
      principalId,
    });
    await recordActivity({
      principal,
      action: "admin.user.project_access_revoke",
      projectId: body.projectId,
      entityType: "principal",
      entityId: principalId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke fjerne tilgangen.") },
        { status: 400 },
      )
    );
  }
}
