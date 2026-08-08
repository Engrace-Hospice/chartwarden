// apps/admin/src/shell — session type leaf (M1, ADR-0030). Ported verbatim from
// apps/web/src/shell/session-types.ts: the Session shape lives here (no React, no sibling imports)
// so both the React provider (session.tsx) and the pure mapping/gating helper (actor-session.ts) can
// depend on it without forming an import cycle. See that file for the full design rationale.

/**
 * Resolution state of the browser session. The shell must distinguish "still loading the actor
 * context" from "resolved, but signed out" — otherwise a loading null is indistinguishable from an
 * anonymous null and the chromed route guard renders fail-open. `outage`: the initial self-load
 * either threw (offline/DNS/timeout) or got back a non-401 error response — neither means "signed
 * out". Only a confirmed 401 resolves to `anonymous`; everything else that isn't a clean 2xx
 * resolves to `outage`.
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
  displayName?: string;
  organizationName?: string;
  membershipId?: string;
  /** The actor's M3-resolved role keys in the bound org — this app's login guard requires `platform_ops`. */
  roles?: string[];
  permissions?: string[];
  isAdmin?: boolean;
}
