import { NextResponse } from "next/server";

import {
  createGroup,
  listGroups,
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
    return NextResponse.json({ groups: await listGroups() });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json({ error: "Kunne ikke hente grupper." }, { status: 500 })
    );
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireAdmin();
    const body = (await request.json()) as {
      name?: unknown;
      description?: unknown;
    };
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "Gruppenavn mangler." }, { status: 400 });
    }
    const group = await createGroup({
      name: body.name,
      description:
        typeof body.description === "string" ? body.description : null,
      createdBy: principal.id,
    });
    await recordActivity({
      principal,
      action: "admin.group.create",
      entityType: "group",
      entityId: group.id,
    });
    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke opprette gruppe.") },
        { status: 400 },
      )
    );
  }
}
