import "server-only";

export function tenantIdFromHeaders(headers: Headers): string {
  return headers.get("x-tenant-id") ?? "default";
}

export function actorFromHeaders(headers: Headers): string {
  return headers.get("x-user-name") ?? "system";
}
