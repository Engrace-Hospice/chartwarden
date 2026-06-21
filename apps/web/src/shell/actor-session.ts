// apps/web/src/shell — actor-session mapping + nav gating (M1 shell, FB-T15, ADR-0030).
// Pure (no React/DOM) so it stays unit-testable in the node test env: maps the live
// `GET /api/v1/auth/context` response — the M2↔M3 role/membership enrichment — into the shell's
// Session, and decides nav / Role-Home tile visibility from the actor's effective permissions.
// The server is ALWAYS the authoritative enforcer; this only drives what the shell renders.
import type { paths } from "@wardenx/ui";
import type { Session } from "./session-types";

/** The wire shape of `GET /api/v1/auth/context` (generated contract). */
export type ActorContextResponse =
  paths["/api/v1/auth/context"]["get"]["responses"][200]["content"]["application/json"];

/** Map the live actor-context response into the shell Session (cookie-auth: no bearer token). */
export function toSession(ctx: ActorContextResponse): Session {
  return {
    userId: ctx.userId,
    organizationId: ctx.organizationId ?? "",
    displayName: ctx.displayName ?? undefined,
    organizationName: ctx.organizationName ?? undefined,
    membershipId: ctx.membershipId ?? undefined,
    roles: ctx.roles,
    permissions: ctx.permissions,
    isAdmin: ctx.isAdmin,
  };
}

/**
 * Is a screen visible to the current actor? A screen with no `requiredPermission` is always
 * visible. When the actor's effective permission set is known, a gated screen shows only if the
 * actor holds the key — the SAME key the server enforces on the underlying route. When it is
 * unknown (session not yet resolved, or an environment without the context endpoint), screens
 * stay visible: the shell never adds authz of its own, and the server denies the routes anyway.
 */
export function canSeeScreen(
  screen: { requiredPermission?: string },
  session: Session | null,
): boolean {
  if (!screen.requiredPermission) return true;
  if (!session?.permissions) return true;
  return session.permissions.includes(screen.requiredPermission);
}
