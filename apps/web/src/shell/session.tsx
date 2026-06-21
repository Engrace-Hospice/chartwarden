// apps/web/src/shell — session/tenant context (M1, ADR-0030). The authenticated actor + org
// for the current browser session. F0 ships the context + a null default; FB-T15 self-loads it
// from the live `GET /api/v1/auth/context` (the M2↔M3 role/membership enrichment) via the typed
// client, so the Role Home + nav reflect the actor's real roles/permissions. The server is always
// the authoritative enforcer — this context only drives client-side rendering and the token header.
import { createContext, useContext, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useApiClient } from "@wardenx/ui";
import { toSession } from "./actor-session";
import type { Session } from "./session-types";

export type { Session } from "./session-types";

const SessionContext = createContext<Session | null>(null);

export interface SessionProviderProps {
  session: Session | null;
  children: ReactNode;
}

/** Static session provider — supplies a known session (tests / SSR / explicit injection). */
export function SessionProvider({ session, children }: SessionProviderProps): JSX.Element {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export interface ActorSessionProviderProps {
  /** Pre-resolved session (tests/SSR). When given, the provider does NOT self-load. */
  initial?: Session | null;
  children: ReactNode;
}

/**
 * Self-loading session provider (FB-T15): on mount it reads the actor's role/membership context
 * from the live `GET /api/v1/auth/context` endpoint (cookie-authed, same-origin) via the typed
 * client and provides the resolved Session. An unauthenticated/unavailable response leaves the
 * session null — the shell renders its signed-out state and the server still denies every route.
 */
export function ActorSessionProvider({
  initial = null,
  children,
}: ActorSessionProviderProps): JSX.Element {
  const client = useApiClient();
  const [session, setSession] = useState<Session | null>(initial);

  useEffect(() => {
    if (initial) return; // explicit session injected — don't self-load
    let cancelled = false;
    void client.GET("/api/v1/auth/context").then(({ data }) => {
      if (!cancelled && data) setSession(toSession(data));
    });
    return () => {
      cancelled = true;
    };
  }, [client, initial]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** Current session, or null when unauthenticated. */
export function useSession(): Session | null {
  return useContext(SessionContext);
}
