import { NextResponse } from "next/server";

import {
  addPrincipalToGroups,
  inviteEmailToProject,
  listGroups,
  listPrincipals,
} from "@/lib/server/access-control-repository";
import { isProjectRole, PROJECT_ROLE_LABELS } from "@/lib/access-control";
import { recordActivity } from "@/lib/server/activity";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";
import { createServiceClient } from "@/lib/server/supabase";
import { checkRateLimit } from "@/lib/server/observability";

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(
      { users: await listPrincipals() },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json({ error: "Kunne ikke hente brukere." }, { status: 500 })
    );
  }
}

async function projectName(projectId: string) {
  const supabase = createServiceClient();
  const modern = await supabase
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .single<{ name: string | null }>();
  if (!modern.error && modern.data) return modern.data.name || "Bidsite-prosjekt";
  const legacy = await supabase
    .from("projects")
    .select("title")
    .eq("id", projectId)
    .single<{ title: string | null }>();
  if (legacy.error || !legacy.data) {
    throw new Error(legacy.error?.message || "Fant ikke prosjektet.");
  }
  return legacy.data.title || "Bidsite-prosjekt";
}

export async function POST(request: Request) {
  try {
    const principal = await requireAdmin();
    const rateLimit = await checkRateLimit(request, "admin-user-invite", {
      limit: 20,
      windowMs: 60_000,
      fallbackLimit: 10,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "For mange invitasjoner. Prøv igjen om litt." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
    const body = (await request.json()) as {
      email?: unknown;
      displayName?: unknown;
      guestDescription?: unknown;
      projectId?: unknown;
      role?: unknown;
      groupIds?: unknown;
    };
    if (
      typeof body.email !== "string" ||
      body.email.length > 320 ||
      typeof body.projectId !== "string" ||
      !isProjectRole(body.role) ||
      body.role === "owner" ||
      typeof body.displayName !== "string" ||
      body.displayName.trim().length < 2 ||
      body.displayName.trim().length > 120 ||
      typeof body.guestDescription !== "string" ||
      body.guestDescription.trim().length < 3 ||
      body.guestDescription.trim().length > 240 ||
      (body.groupIds !== undefined &&
        (!Array.isArray(body.groupIds) ||
          body.groupIds.length > 100 ||
          !body.groupIds.every((id) => typeof id === "string")))
    ) {
      return NextResponse.json({ error: "Ugyldig brukerinvitasjon." }, { status: 400 });
    }
    const groupIds = Array.isArray(body.groupIds)
      ? [...new Set(body.groupIds)]
      : [];
    if (groupIds.length) {
      const availableGroupIds = new Set(
        (await listGroups()).map((group) => group.id),
      );
      if (groupIds.some((groupId) => !availableGroupIds.has(groupId))) {
        return NextResponse.json(
          { error: "En eller flere grupper finnes ikke." },
          { status: 400 },
        );
      }
    }
    const invited = await inviteEmailToProject({
      projectId: body.projectId,
      projectName: await projectName(body.projectId),
      email: body.email,
      displayName: body.displayName,
      guestDescription: body.guestDescription,
      role: body.role,
      createdBy: principal.id,
    });
    await addPrincipalToGroups({
      principalId: invited.principalId,
      groupIds,
      addedBy: principal.id,
    });
    await recordActivity({
      principal,
      action: "admin.user.invite",
      projectId: body.projectId,
      entityType: "principal",
      entityId: invited.principalId,
      metadata: {
        role: PROJECT_ROLE_LABELS[body.role],
        groupCount: groupIds.length,
      },
    });
    return NextResponse.json(invited, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json(
        { error: productionSafeErrorMessage(error, "Kunne ikke invitere brukeren.") },
        { status: 400 },
      )
    );
  }
}

export async function PATCH() {
  return NextResponse.json(
    { error: "Administratorrollen er låst og kan ikke tildeles flere brukere." },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}
