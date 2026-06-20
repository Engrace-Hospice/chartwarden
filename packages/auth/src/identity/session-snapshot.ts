// @wardenx/auth · identity — read a Better Auth session as a minimal snapshot (M2, AUTH-T03, ADR-0033).
//
// The vendor boundary for session reads: wraps `auth.api.getSession` + `fromNodeHeaders` so the rest of
// the system never imports better-auth. The composition root feeds this into the authenticate hook
// (apps/backend/src/bootstrap/plugins/authenticate.ts), which drives the SessionContextResolver seam.
import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import type { IdentityAuth } from "./auth";

export interface IdentitySessionSnapshot {
  readonly sessionId: string;
  readonly userId: string;
  /** Server-bound org for this session; null for a PRE-ORG session (before select-organization). */
  readonly activeOrganizationId: string | null;
}

/** Resolve the current request's Better Auth session to a minimal snapshot, or null if none. */
export async function getIdentitySession(
  auth: IdentityAuth,
  nodeHeaders: IncomingHttpHeaders,
): Promise<IdentitySessionSnapshot | null> {
  const result = (await auth.api.getSession({ headers: fromNodeHeaders(nodeHeaders) })) as
    | { session?: { id: string; userId: string; activeOrganizationId?: string | null } }
    | null;
  const session = result?.session;
  if (!session) return null;
  return {
    sessionId: session.id,
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId ?? null,
  };
}
