// apps/web/src/shell — session/tenant context (M1, ADR-0030). The authenticated actor + org
// for the current browser session. F0 ships the context + a null default; M2 (Identity) screens
// (Track A) populate it via the auth routes and add sign-in/refresh. The server is always the
// authoritative enforcer — this context only drives client-side rendering and the token header.
import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";

export interface Session {
  userId: string;
  organizationId: string;
  /** Bearer token for the API client. */
  token: string;
  displayName?: string;
  roles?: string[];
}

const SessionContext = createContext<Session | null>(null);

export interface SessionProviderProps {
  session: Session | null;
  children: ReactNode;
}

export function SessionProvider({ session, children }: SessionProviderProps): JSX.Element {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** Current session, or null when unauthenticated. */
export function useSession(): Session | null {
  return useContext(SessionContext);
}
