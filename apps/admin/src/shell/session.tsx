import { useApiClient } from "@wardenx/ui";
// apps/admin/src/shell — session/tenant context (M1, ADR-0030). Ported verbatim from
// apps/web/src/shell/session.tsx (see that file for the full design rationale): self-loads the
// authenticated actor's role/membership context from the live `GET /api/v1/auth/context` endpoint on
// mount, exposing a resolution STATUS (loading | anonymous | authenticated | outage), not just a
// nullable Session — the chromed-route guard branches on which one it is.
import { createContext, useContext, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { toSession } from "./actor-session";
import type { Session, SessionState } from "./session-types";

export type { Session } from "./session-types";
export type { SessionState, SessionStatus } from "./session-types";

const SessionContext = createContext<SessionState>({ status: "loading", session: null });

export interface ActorSessionProviderProps {
  /** Pre-resolved session (tests). When given, the provider does NOT self-load. */
  initial?: Session | null;
  children: ReactNode;
}

/**
 * Self-loading session provider: on mount it reads the actor's role/membership context from the live
 * `GET /api/v1/auth/context` endpoint (cookie-authed, same-origin) via the typed client. Starts in
 * `loading`, then resolves to `authenticated`, `anonymous` (a confirmed 401), or `outage` (anything
 * else — the backend being unreachable is not the same as being signed out). An injected `initial`
 * (tests) skips the self-load entirely — mirrors apps/web/src/shell/session.tsx.
 */
export function ActorSessionProvider({
  initial = null,
  children,
}: ActorSessionProviderProps): JSX.Element {
  const client = useApiClient();
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
        setState(
          response.status === 401
            ? { status: "anonymous", session: null }
            : { status: "outage", session: null },
        );
      })
      .catch(() => {
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
