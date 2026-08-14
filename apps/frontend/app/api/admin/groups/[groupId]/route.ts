import { NextResponse } from "next/server";

import {
  getGroup,
  setGroupMembers,
} from "@/lib/server/access-control-repository";
import { recordActivity } from "@/lib/server/activity";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

export async function GET(
  _: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    await requireAdmin();
    const { groupId } = await context.params;
    return NextResponse.json(await getGroup(groupId));
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json({ error: "Kunne ikke hente gruppen." }, { status: 500 })
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const principal = await requireAdmin();
    const { groupId } = await context.params;
    const body = (await request.json()) as { principalIds?: unknown };
    if (
      !Array.isArray(body.principalIds) ||
      !body.principalIds.every((id) => typeof id === "string")
    ) {
      return NextResponse.json({ error: "Ugyldig medlemsliste." }, { status: 400 });
    }
    await setGroupMembers({
      groupId,
      principalIds: body.principalIds,
      addedBy: principal.id,
    });
    await recordActivity({
      principal,
      action: "admin.group.members_update",
      entityType: "group",
      entityId: groupId,
      metadata: { memberCount: body.principalIds.length },
    });
    return NextResponse.json(await getGroup(groupId));
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke endre gruppen.") },
        { status: 400 },
      )
    );
  }
}
