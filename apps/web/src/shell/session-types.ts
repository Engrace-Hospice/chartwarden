// apps/web/src/shell — session type leaf (M1, ADR-0030). The Session shape lives here (no React,
// no sibling imports) so both the React provider (session.tsx) and the pure mapping/gating helper
// (actor-session.ts) can depend on it without forming an import cycle.

/**
 * Resolution state of the browser session (FB-T15 / audit #6). The shell must distinguish
 * "still loading the actor context" from "resolved, but signed out" — otherwise a loading null
 * is indistinguishable from an anonymous null and chromed routes render fail-open. The route
 * guard branches on this: loading → spinner, anonymous → redirect to /login, authenticated → render.
 *
 * `outage` (TASK-033 / FLOW-004) is a THIRD failure mode, distinct from `anonymous`: the initial
 * self-load either threw (offline/DNS/timeout — no response at all) or got back a non-401 error
 * response (5xx). Neither means "signed out" — collapsing them into `anonymous` is exactly the bug
 * that force-logs-out a clinician mid-shift when the backend blips. Only a confirmed 401 resolves
 * to `anonymous`; everything else that isn't a clean 2xx resolves to `outage`.
 */
export type SessionStatus = "loading" | "anonymous" | "authenticated" | "outage";

/** The session context value: the resolution status plus the resolved Session (null unless authenticated). */
export interface SessionState {
  status: SessionStatus;
  session: Session | null;
}

export interface Session {
  userId: string;
  organizationId: string;
  /** Bearer token for the API client (optional — same-origin cookie sessions need none). */
  token?: string;
  displayName?: string;
  /** Display name of the bound organization (FB-T15). */
  organizationName?: string;
  /** The actor's active membership id in the bound org (FB-T15, absent when pre-org). */
  membershipId?: string;
  /** The actor's M3-resolved role keys in the bound org. */
  roles?: string[];
  /** Server-derived location memberships used only to narrow selectors; backend ABAC remains authoritative. */
  locationIds?: string[];
  /** The shared authorization decision for org-wide patient scope. */
  orgWidePatientScope?: boolean;
  /** The actor's effective permission keys (M3-resolved) — for nav/Role-Home gating only. */
  permissions?: string[];
  /** Whether the actor holds the org_admin role (FB-T15). */
  isAdmin?: boolean;
}
