// apps/web/src/shell — actor-session mapping + nav gating (M1 shell, FB-T15, ADR-0030).
// Pure (no React/DOM) so it stays unit-testable in the node test env: maps the live
// `GET /api/v1/auth/context` response — the M2↔M3 role/membership enrichment — into the shell's
// Session, and decides nav / Role-Home tile visibility from the actor's effective permissions.
// The server is ALWAYS the authoritative enforcer; this only drives what the shell renders.
import type { paths } from "@wardenx/ui";
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
 *
 * The "Platform" navGroup (M34 §5.1 control plane) is additionally gated on the `platform_ops`
 * RBAC role, not just `requiredPermission` (live-browser audit #2): an org-scoped Administrator's
 * role can legitimately hold RBAC keys like `tenant.list_platform` at their own org, but most of
 * those routes ALSO enforce the `tenant_lifecycle_platform_ops` ABAC predicate
 * (`context.roles.includes("platform_ops")`, apps/backend/.../34-saas-tenant-platform/abac-predicates.ts)
 * — so `requiredPermission` alone under-restricts the nav and advertises a section that 403s for
 * every non-platform-ops actor. These screens belong exclusively to the separate admin console app.
 */
export function canSeeScreen(
  screen: { requiredPermission?: string; navGroup?: string },
  session: Session | null,
): boolean {
  if (screen.navGroup === "Platform" && !session?.roles?.includes("platform_ops")) return false;
  if (!screen.requiredPermission) return true;
  if (!session?.permissions) return false; // unknown perms → fail closed (was fail-open)
  return session.permissions.includes(screen.requiredPermission);
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
