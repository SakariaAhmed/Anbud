import { NextResponse } from "next/server";

import { parseProjectAccessCommand } from "@/lib/project-access-command";
import {
  grantGroupProjectAccess,
  grantPrincipalProjectAccess,
  inviteEmailToProject,
  listGroups,
  listProjectAccess,
  revokeProjectGroup,
  revokeProjectMember,
  rotateGuestCode,
  updateProjectGroupRole,
  updateProjectMemberRole,
} from "@/lib/server/access-control-repository";
import { recordActivity } from "@/lib/server/activity";
import {
  authorizationErrorResponse,
  requireProjectPermission,
} from "@/lib/server/authorization";
import { checkRateLimit } from "@/lib/server/observability";
import { createServiceClient } from "@/lib/server/supabase";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

async function projectName(projectId: string) {
  const supabase = createServiceClient();
  const modern = await supabase
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .single<{ name: string | null }>();
  if (!modern.error && modern.data) {
    return modern.data.name?.trim() || "Bidsite-prosjekt";
  }
  const legacy = await supabase
    .from("projects")
    .select("title")
    .eq("id", projectId)
    .single<{ title: string | null }>();
  if (legacy.error || !legacy.data) {
    throw new Error(legacy.error?.message || "Fant ikke prosjektet.");
  }
  return legacy.data.title?.trim() || "Bidsite-prosjekt";
}

async function authorize(projectId: string) {
  return requireProjectPermission(projectId, "project.share");
}

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await authorize(id);
    return NextResponse.json(
      {
        ...(await listProjectAccess(id)),
        availableGroups: await listGroups(),
      },
      {
      headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke hente tilgang.") },
        { status: 400 },
      )
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const authorization = await authorize(id);
    const rateLimit = await checkRateLimit(request, "project-access-change", {
      limit: 20,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "For mange delingsendringer. Prøv igjen om litt." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
    const parsed = parseProjectAccessCommand(
      "POST",
      await request.json().catch(() => null),
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { command } = parsed;
    let result: unknown;
    if (command.action === "invite") {
      const globalInviteLimit = await checkRateLimit(
        request,
        "guest-invite-global",
        {
          limit: 100,
          windowMs: 60_000,
          identityMode: "global",
          fallbackLimit: 30,
        },
      );
      if (!globalInviteLimit.allowed) {
        return NextResponse.json(
          { error: "Invitasjonstjenesten er midlertidig begrenset." },
          {
            status: 429,
            headers: {
              "Retry-After": String(globalInviteLimit.retryAfterSeconds),
            },
          },
        );
      }
      result = await inviteEmailToProject({
        projectId: id,
        projectName: await projectName(id),
        email: command.email,
        displayName: command.displayName,
        guestDescription: command.guestDescription,
        role: command.role,
        expiresAt: command.expiresAt,
        createdBy: authorization.principal.id,
      });
    } else if (command.action === "grant_group") {
      await grantGroupProjectAccess({
        projectId: id,
        groupId: command.groupId,
        role: command.role,
        grantedBy: authorization.principal.id,
        expiresAt: command.expiresAt,
      });
      result = { ok: true };
    } else if (command.action === "grant_member") {
      await grantPrincipalProjectAccess({
        projectId: id,
        principalId: command.principalId,
        role: command.role,
        grantedBy: authorization.principal.id,
      });
      result = { ok: true };
    } else {
      const access = await listProjectAccess(id);
      const member = access.members.find(
        (row) =>
          row.principal_id === command.principalId &&
          row.principal?.identity_type === "guest",
      );
      if (!member) {
        return NextResponse.json({ error: "Fant ikke gjesten." }, { status: 404 });
      }
      result = await rotateGuestCode({
        principalId: command.principalId,
        rotatedBy: authorization.principal.id,
        projectName: await projectName(id),
      });
    }
    await recordActivity({
      context: authorization,
      action: `project.access.${command.action}`,
      entityType: "project",
      entityId: id,
    });
    return NextResponse.json(result, {
      status: command.action === "invite" ? 201 : 200,
    });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke endre tilgang.") },
        { status: 400 },
      )
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const authorization = await authorize(id);
    const parsed = parseProjectAccessCommand(
      "PATCH",
      await request.json().catch(() => null),
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { command } = parsed;
    if (command.action === "update_member") {
      await updateProjectMemberRole({
        projectId: id,
        principalId: command.targetId,
        role: command.role,
      });
    } else {
      await updateProjectGroupRole({
        projectId: id,
        groupId: command.targetId,
        role: command.role,
      });
    }
    await recordActivity({
      context: authorization,
      action: "project.access.role_update",
      entityType: command.action === "update_group" ? "group" : "principal",
      entityId: command.targetId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke endre rolle.") },
        { status: 400 },
      )
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const authorization = await authorize(id);
    const parsed = parseProjectAccessCommand(
      "DELETE",
      await request.json().catch(() => null),
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { command } = parsed;
    if (command.action === "revoke_member") {
      await revokeProjectMember({ projectId: id, principalId: command.targetId });
    } else {
      await revokeProjectGroup({ projectId: id, groupId: command.targetId });
    }
    await recordActivity({
      context: authorization,
      action: "project.access.revoke",
      entityType: command.action === "revoke_group" ? "group" : "principal",
      entityId: command.targetId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke fjerne tilgang.") },
        { status: 400 },
      )
    );
  }
}
