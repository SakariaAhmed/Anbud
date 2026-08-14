import { isProjectRole, type ProjectRole } from "@/lib/access-control";

type ShareableProjectRole = Exclude<ProjectRole, "owner">;

export type ProjectAccessPostCommand =
  | {
      action: "invite";
      email: string;
      displayName: string;
      guestDescription: string;
      role: ShareableProjectRole;
      expiresAt: string | null;
    }
  | {
      action: "grant_group";
      groupId: string;
      role: ShareableProjectRole;
      expiresAt: string | null;
    }
  | { action: "rotate_guest"; principalId: string };

export type ProjectAccessPatchCommand =
  | {
      action: "update_member" | "update_group";
      targetId: string;
      role: ShareableProjectRole;
    };

export type ProjectAccessDeleteCommand = {
  action: "revoke_member" | "revoke_group";
  targetId: string;
};

export type ProjectAccessCommand =
  | ProjectAccessPostCommand
  | ProjectAccessPatchCommand
  | ProjectAccessDeleteCommand;

export type ProjectAccessParseResult<Command = ProjectAccessCommand> =
  | { ok: true; command: Command }
  | { ok: false; error: string };

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function optionalString(value: unknown, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  return boundedString(value, maxLength);
}

function shareableRole(value: unknown): ShareableProjectRole | null {
  return isProjectRole(value) && value !== "owner" ? value : null;
}

export function parseProjectAccessCommand(
  method: "POST",
  input: unknown,
): ProjectAccessParseResult<ProjectAccessPostCommand>;
export function parseProjectAccessCommand(
  method: "PATCH",
  input: unknown,
): ProjectAccessParseResult<ProjectAccessPatchCommand>;
export function parseProjectAccessCommand(
  method: "DELETE",
  input: unknown,
): ProjectAccessParseResult<ProjectAccessDeleteCommand>;
export function parseProjectAccessCommand(
  method: "POST" | "PATCH" | "DELETE",
  input: unknown,
): ProjectAccessParseResult {
  const body = recordValue(input);
  if (!body) return { ok: false, error: "Ugyldig forespørsel." };

  if (method === "POST") {
    const action = body.action === undefined ? "invite" : body.action;
    if (action === "invite") {
      const email = boundedString(body.email, 320);
      const displayName = boundedString(body.displayName, 120)?.trim();
      const guestDescription = boundedString(
        body.guestDescription,
        240,
      )?.trim();
      const role = shareableRole(body.role);
      if (
        !email ||
        !displayName ||
        displayName.length < 2 ||
        !guestDescription ||
        guestDescription.length < 3 ||
        !role
      ) {
        return {
          ok: false,
          error: "Navn og en kort gjestebeskrivelse er obligatorisk.",
        };
      }
      return {
        ok: true,
        command: {
          action,
          email,
          displayName,
          guestDescription,
          role,
          expiresAt: optionalString(body.expiresAt, 64),
        },
      };
    }
    if (action === "grant_group") {
      const groupId = boundedString(body.groupId, 128);
      const role = shareableRole(body.role);
      if (!groupId || !role) {
        return { ok: false, error: "Ugyldig gruppetilgang." };
      }
      return {
        ok: true,
        command: {
          action,
          groupId,
          role,
          expiresAt: optionalString(body.expiresAt, 64),
        },
      };
    }
    if (action === "rotate_guest") {
      const principalId = boundedString(body.principalId, 128);
      return principalId
        ? { ok: true, command: { action, principalId } }
        : { ok: false, error: "Gjest mangler." };
    }
    return { ok: false, error: "Ukjent handling." };
  }

  const principalId = boundedString(body.principalId, 128);
  const groupId = boundedString(body.groupId, 128);
  if (Boolean(principalId) === Boolean(groupId)) {
    return { ok: false, error: "Medlem eller gruppe mangler." };
  }
  const targetId = principalId ?? groupId;
  if (!targetId) return { ok: false, error: "Medlem eller gruppe mangler." };

  if (method === "PATCH") {
    const role = shareableRole(body.role);
    if (!role) return { ok: false, error: "Ugyldig rolle." };
    return {
      ok: true,
      command: {
        action: principalId ? "update_member" : "update_group",
        targetId,
        role,
      },
    };
  }

  return {
    ok: true,
    command: {
      action: principalId ? "revoke_member" : "revoke_group",
      targetId,
    },
  };
}
