// apps/admin/src/shell — actor-session mapping (M1 shell, ADR-0030). Ported from
// apps/web/src/shell/actor-session.ts, minus the `navGroup === "Platform"` nav-hiding special case:
// that hack existed in apps/web only because the M34 platform-ops screens used to live inside the
// tenant web app's own nav alongside everything else. In this app, every registered screen already
// IS platform-ops-only by construction — the real gate is `require-chrome.tsx`'s `platform_ops` role
// check on the whole authenticated frame, not a per-screen nav filter. Pure (no React/DOM) so it
// stays unit-testable. The server is ALWAYS the authoritative enforcer; this only drives what the
// shell renders.
import type { paths } from "@chartwarden/ui";
import type { Session, SessionStatus } from "./session-types";

/** The wire shape of `GET /api/v1/auth/context` (generated contract) — identical across every app. */
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
 * org (post-login, before `select-organization`). A still-loading or signed-out session is `null` →
 * false (no redirect); a bound session has a non-empty `organizationId` → false.
 */
export function needsOrgSelection(session: Session | null): boolean {
  return session !== null && !session.organizationId;
}

/** What the chromed-route guard should do for a given session status. */
export type RouteGuardOutcome = "loading" | "redirect" | "outage" | "allow";

/**
 * The chromed-route guard decision (pure, unit-testable). `loading` → spinner; `redirect` → send an
 * anonymous actor to sign-in; `outage` → the backend is unreachable, render the offline/error page
 * instead of forcing a sign-out; `allow` → render the authenticated frame (the caller still applies
 * the `platform_ops` role check on top of `allow` — see `require-chrome.tsx`).
 */
export function guardChromedRoute(status: SessionStatus): RouteGuardOutcome {
  if (status === "loading") return "loading";
  if (status === "anonymous") return "redirect";
  if (status === "outage") return "outage";
  return "allow";
}
