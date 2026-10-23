// apps/web/src/shell — actor-session mapping + nav gating (M1 shell, FB-T15, ADR-0030).
// Pure (no React/DOM) so it stays unit-testable in the node test env: maps the live
// `GET /api/v1/auth/context` response — the M2↔M3 role/membership enrichment — into the shell's
// Session, and decides nav / Role-Home tile visibility from the actor's effective permissions.
// The server is ALWAYS the authoritative enforcer; this only drives what the shell renders.
import type { paths } from "@chartwarden/ui";
import type { Session, SessionStatus } from "./session-types";

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
    locationIds: ctx.locationIds,
    orgWidePatientScope: ctx.orgWidePatientScope,
    permissions: ctx.permissions,
    isAdmin: ctx.isAdmin,
  };
}

/**
 * Does the actor still need to pick an organization? True only for a RESOLVED session with no bound
 * org (post-login, before `select-organization`): every org-scoped route 401/403s for it, so the
 * shell routes it to organization-select. A still-loading or signed-out session is `null` → false
 * (no redirect); a bound session has a non-empty `organizationId` → false.
 */
export function needsOrgSelection(session: Session | null): boolean {
  return session !== null && !session.organizationId;
}

/**
 * Is a screen visible to the current actor? A screen with no `requiredPermission` is always
 * visible. A gated screen shows only when the actor's effective permission set is known AND holds
 * the key — the SAME key the server enforces on the underlying route. When the permission set is
 * unknown (session not yet resolved, or an environment without the context endpoint), a gated screen
 * FAILS CLOSED — it stays hidden (audit #6). The route guard already keeps the nav from rendering at
 * all until the session is authenticated, so this is the defensive second line; the server remains
 * the authoritative enforcer either way.
 */
export function canSeeScreen(
  screen: { requiredPermission?: string },
  session: Session | null,
): boolean {
  if (!screen.requiredPermission) return true;
  if (!session?.permissions) return false; // unknown perms → fail closed (was fail-open)
  return session.permissions.includes(screen.requiredPermission);
}

/**
 * Is a screen KNOWN to be off-limits to this actor? The route-level counterpart of {@link canSeeScreen}
 * (#592 F-025): nav hiding alone left a typed URL opening a create form the actor cannot submit. Unlike
 * the nav it denies only when the permission set is known and lacks the key — an unknown set renders the
 * screen and lets the server (the authoritative enforcer) refuse, so a context-less environment is not blanked.
 */
export function isScreenDenied(
  screen: { requiredPermission?: string },
  session: Session | null,
): boolean {
  if (!screen.requiredPermission || !session?.permissions) return false;
  return !session.permissions.includes(screen.requiredPermission);
}

/** What a chromed-route guard should do for a given session status (audit #6, TASK-033). */
export type RouteGuardOutcome = "loading" | "redirect" | "outage" | "allow";

/**
 * The chromed-route guard decision (pure, so it is unit-testable in the node env). `loading` →
 * render a spinner (don't flash chrome or redirect before we know); `redirect` → send an anonymous
 * actor to sign-in; `outage` → the backend is unreachable/unhealthy, render the offline page instead
 * of forcing a sign-out (TASK-033 / FLOW-004); `allow` → render the authenticated app frame. The
 * org-binding sub-case (authenticated but no org) is handled downstream by `needsOrgSelection`
 * inside the layout.
 */
export function guardChromedRoute(status: SessionStatus): RouteGuardOutcome {
  if (status === "loading") return "loading";
  if (status === "anonymous") return "redirect";
  if (status === "outage") return "outage";
  return "allow";
}
