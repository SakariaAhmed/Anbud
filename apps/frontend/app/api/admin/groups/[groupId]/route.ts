import { NextResponse } from "next/server";

import {
  deleteGroup,
  getGroup,
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
    const body = (await request.json()) as {
      principalIds?: unknown;
      projectGrants?: unknown;
    };
    const hasMembers = body.principalIds !== undefined;
    const hasProjects = body.projectGrants !== undefined;
    if (!hasMembers && !hasProjects) {
      return NextResponse.json({ error: "Ingen endringer mottatt." }, { status: 400 });
    }
    if (
      hasMembers &&
      (!Array.isArray(body.principalIds) ||
        !body.principalIds.every((id) => typeof id === "string"))
    ) {
      return NextResponse.json({ error: "Ugyldig medlemsliste." }, { status: 400 });
    }
    if (
      hasProjects &&
      (!Array.isArray(body.projectGrants) ||
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
    if (hasMembers) {
      await setGroupMembers({
        groupId,
        principalIds: body.principalIds as string[],
        addedBy: principal.id,
      });
    }
    if (hasProjects) {
      await replaceGroupProjectAccess({
        groupId,
        grants: body.projectGrants as Array<{
          projectId: string;
          role: "editor" | "viewer" | "restricted_viewer";
        }>,
        grantedBy: principal.id,
      });
    }
    await recordActivity({
      principal,
      action: hasMembers && hasProjects
        ? "admin.group.access_update"
        : hasMembers
          ? "admin.group.members_update"
          : "admin.group.projects_update",
      entityType: "group",
      entityId: groupId,
      metadata: {
        memberCount: Array.isArray(body.principalIds)
          ? body.principalIds.length
          : undefined,
        projectCount: Array.isArray(body.projectGrants)
          ? body.projectGrants.length
          : undefined,
      },
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

export async function DELETE(
  _: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const principal = await requireAdmin();
    const { groupId } = await context.params;
    const group = await deleteGroup(groupId);
    await recordActivity({
      principal,
      action: "admin.group.delete",
      entityType: "group",
      entityId: groupId,
      metadata: { name: group.name },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke slette gruppen.") },
        { status: 400 },
      )
    );
  }
}
