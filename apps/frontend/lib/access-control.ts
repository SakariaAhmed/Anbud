export const IDENTITY_TYPES = ["internal", "guest"] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

export const ADMIN_ROLE = "admin" as const;

export const PROJECT_ROLES = [
  "restricted_viewer",
  "viewer",
  "editor",
  "owner",
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_PERMISSIONS = [
  "project.read",
  "project.update",
  "project.delete",
  "project.share",
  "document.read",
  "document.download",
  "document.upload",
  "document.delete",
  "analysis.read",
  "analysis.write",
  "chat.read",
  "chat.write",
  "artifact.read",
  "artifact.download",
  "artifact.write",
  "job.read",
  "job.run",
] as const;
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

const RESTRICTED_VIEWER_PERMISSIONS: readonly ProjectPermission[] = [
  "project.read",
  "document.read",
  "analysis.read",
  "chat.read",
  "artifact.read",
  "job.read",
];

const VIEWER_PERMISSIONS: readonly ProjectPermission[] = [
  ...RESTRICTED_VIEWER_PERMISSIONS,
  "document.download",
  "artifact.download",
];

const EDITOR_PERMISSIONS: readonly ProjectPermission[] = [
  ...VIEWER_PERMISSIONS,
  "project.update",
  "document.upload",
  "document.delete",
  "analysis.write",
  "chat.write",
  "artifact.write",
  "job.run",
];

const OWNER_PERMISSIONS: readonly ProjectPermission[] = [
  ...EDITOR_PERMISSIONS,
  "project.delete",
  "project.share",
];

export const PROJECT_ROLE_PERMISSIONS: Record<
  ProjectRole,
  readonly ProjectPermission[]
> = {
  restricted_viewer: RESTRICTED_VIEWER_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
  editor: EDITOR_PERMISSIONS,
  owner: OWNER_PERMISSIONS,
};

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  restricted_viewer: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function isIdentityType(value: unknown): value is IdentityType {
  return (
    typeof value === "string" &&
    (IDENTITY_TYPES as readonly string[]).includes(value)
  );
}

export function isAdminRole(value: unknown): value is typeof ADMIN_ROLE {
  return value === ADMIN_ROLE;
}

export function globalAccessAllows(
  isAdmin: boolean,
  permission: ProjectPermission,
) {
  return isAdmin && (isReadPermission(permission) || permission === "project.share");
}

export function isProjectRole(value: unknown): value is ProjectRole {
  return (
    typeof value === "string" &&
    (PROJECT_ROLES as readonly string[]).includes(value)
  );
}

export function strongestProjectRole(
  roles: readonly ProjectRole[],
): ProjectRole | null {
  return (
    roles.reduce<ProjectRole | null>((strongest, role) => {
      if (!strongest || PROJECT_ROLE_RANK[role] > PROJECT_ROLE_RANK[strongest]) {
        return role;
      }
      return strongest;
    }, null)
  );
}

export function projectRoleAllows(
  role: ProjectRole,
  permission: ProjectPermission,
) {
  return PROJECT_ROLE_PERMISSIONS[role].includes(permission);
}

export function isReadPermission(permission: ProjectPermission) {
  return (
    permission.endsWith(".read") ||
    permission.endsWith(".download")
  );
}

export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
  owner: "Full tilgang",
  editor: "Kan redigere",
  viewer: "Kan lese og laste ned",
  restricted_viewer: "Kun lesing",
};
