import { useApiClient } from "@wardenx/ui";
// apps/web/src/shell — session/tenant context (M1, ADR-0030). The authenticated actor + org
// for the current browser session. F0 ships the context + a null default; FB-T15 self-loads it
// from the live `GET /api/v1/auth/context` (the M2↔M3 role/membership enrichment) via the typed
// client, so the Role Home + nav reflect the actor's real roles/permissions. The server is always
// the authoritative enforcer — this context only drives client-side rendering and the token header.
//
// The context exposes a resolution STATUS (loading | anonymous | authenticated), not just a nullable
// Session (audit #6): a loading null and a signed-out null are different, and the chromed-route guard
// must branch on which one it is (spinner vs. redirect to /login) rather than rendering fail-open.
import { createContext, useContext, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { toSession } from "./actor-session";
import type { Session, SessionState } from "./session-types";

export type { Session } from "./session-types";
export type { SessionState, SessionStatus } from "./session-types";

const SessionContext = createContext<SessionState>({ status: "loading", session: null });

/** Derive a resolved (non-loading) state from a known session — a present session is authenticated. */
function resolvedState(session: Session | null): SessionState {
  return session ? { status: "authenticated", session } : { status: "anonymous", session: null };
}

export interface SessionProviderProps {
  session: Session | null;
  children: ReactNode;
}

/** Static session provider — supplies a known, already-resolved session (tests / SSR / injection). */
export function SessionProvider({ session, children }: SessionProviderProps): JSX.Element {
  return (
    <SessionContext.Provider value={resolvedState(session)}>{children}</SessionContext.Provider>
  );
}

export interface ActorSessionProviderProps {
  /** Pre-resolved session (tests/SSR). When given, the provider does NOT self-load. */
  initial?: Session | null;
  children: ReactNode;
}

/**
 * Self-loading session provider (FB-T15): on mount it reads the actor's role/membership context
 * from the live `GET /api/v1/auth/context` endpoint (cookie-authed, same-origin) via the typed
 * client. It starts in `loading`, then resolves to `authenticated` (context present) or `anonymous`
 * (unauthenticated / endpoint unavailable). The chromed-route guard renders a spinner while loading
 * and redirects to /login when anonymous; the server still denies every route regardless.
 */
export function ActorSessionProvider({
  initial = null,
  children,
}: ActorSessionProviderProps): JSX.Element {
  const client = useApiClient();
  // An injected `initial` is already resolved; otherwise we begin loading and self-load below.
  const [state, setState] = useState<SessionState>(
    initial ? { status: "authenticated", session: initial } : { status: "loading", session: null },
  );

  useEffect(() => {
    if (initial) return; // explicit session injected — don't self-load
    let cancelled = false;
    void client
      .GET("/api/v1/auth/context")
      .then(({ data, response }) => {
        if (cancelled) return;
        if (data) {
          setState({ status: "authenticated", session: toSession(data) });
          return;
        }
        // A confirmed 401 is a real "signed out" — anything else (500/503/…) is the backend being
        // unreachable/unhealthy, not a logout (TASK-033 / FLOW-004): don't force-redirect to /login.
        setState(
          response.status === 401
            ? { status: "anonymous", session: null }
            : { status: "outage", session: null },
        );
      })
      .catch(() => {
        // The fetch itself threw (offline, DNS, timeout, CORS) — no response at all reached us.
        if (!cancelled) setState({ status: "outage", session: null });
      });
    return () => {
      cancelled = true;
    };
  }, [client, initial]);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

/** The full session state (status + session) — for the route guard and status-aware rendering. */
export function useSessionState(): SessionState {
  return useContext(SessionContext);
}

/** Current session, or null when loading/unauthenticated. */
export function useSession(): Session | null {
  return useContext(SessionContext).session;
}
