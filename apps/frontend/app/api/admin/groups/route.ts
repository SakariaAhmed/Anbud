import { NextResponse } from "next/server";

import {
  createGroup,
  deleteGroup,
  listGroups,
  replaceGroupProjectAccess,
  setGroupMembers,
} from "@/lib/server/access-control-repository";
import { isProjectRole } from "@/lib/access-control";
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
      principalIds?: unknown;
      projectGrants?: unknown;
    };
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "Gruppenavn mangler." }, { status: 400 });
    }
    if (
      body.principalIds !== undefined &&
      (!Array.isArray(body.principalIds) ||
        body.principalIds.length > 500 ||
        !body.principalIds.every((id) => typeof id === "string"))
    ) {
      return NextResponse.json({ error: "Ugyldig medlemsliste." }, { status: 400 });
    }
    if (
      body.projectGrants !== undefined &&
      (!Array.isArray(body.projectGrants) ||
        body.projectGrants.length > 500 ||
        !body.projectGrants.every((grant) => {
          if (!grant || typeof grant !== "object") return false;
          const row = grant as { projectId?: unknown; role?: unknown };
          return (
            typeof row.projectId === "string" &&
            isProjectRole(row.role) &&
            row.role !== "owner"
          );
        }))
    ) {
      return NextResponse.json({ error: "Ugyldig prosjekttilgang." }, { status: 400 });
    }
    const group = await createGroup({
      name: body.name,
      description:
        typeof body.description === "string" ? body.description : null,
      createdBy: principal.id,
    });
    try {
      if (Array.isArray(body.principalIds)) {
        await setGroupMembers({
          groupId: group.id,
          principalIds: body.principalIds as string[],
          addedBy: principal.id,
        });
      }
      if (Array.isArray(body.projectGrants)) {
        await replaceGroupProjectAccess({
          groupId: group.id,
          grants: body.projectGrants as Array<{
            projectId: string;
            role: "editor" | "viewer" | "restricted_viewer";
          }>,
          grantedBy: principal.id,
        });
      }
    } catch (setupError) {
      await deleteGroup(group.id).catch(() => undefined);
      throw setupError;
    }
    await recordActivity({
      principal,
      action: "admin.group.create",
      entityType: "group",
      entityId: group.id,
      metadata: {
        memberCount: Array.isArray(body.principalIds)
          ? body.principalIds.length
          : 0,
        projectCount: Array.isArray(body.projectGrants)
          ? body.projectGrants.length
          : 0,
      },
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
