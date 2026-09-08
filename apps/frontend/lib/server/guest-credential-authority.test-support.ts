export const state = { isAdmin: false, actorId: "u_owner_000000000000000001", emails: [] as unknown[] };
export class AuthorizationError extends Error { status = 403; }
export async function requireRequestPrincipal() {
  return { id: state.actorId, isAdmin: state.isAdmin };
}
export async function requireAdmin() {
  if (!state.isAdmin) throw new AuthorizationError("Administratortilgang kreves.");
  return requireRequestPrincipal();
}
export async function requireProjectPermission() {
  return { principal: await requireRequestPrincipal() };
}
export function authorizationErrorResponse(error: unknown) {
  return error instanceof AuthorizationError ? Response.json({ error: error.message }, { status: 403 }) : null;
}
export async function checkRateLimit() { return { allowed: true }; }
export async function recordActivity() {}
export async function sendGuestAccessEmail(input: unknown) {
  state.emails.push(input);
  return { delivered: true };
}
