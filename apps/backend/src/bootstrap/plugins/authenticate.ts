// apps/backend/src/bootstrap — the production authenticate hook (M1 host, AUTH-T03, ADR-0033).
//
// Resolves a request to its authenticated, org-scoped context: read the session snapshot (injected —
// Better-Auth-backed in production, a stub in tests), then drive the SessionContextResolver seam to
// populate request.context (actor + org + roles). No better-auth import here — the snapshot reader is
// injected, so this stays M1-owned and unit-testable. Roles come from the resolver (M2 over the M1
// session repo); permission evaluation remains M3's separate concern.
import type { OrgScope, SessionContextResolver } from "@wardenx/types";
import type { FastifyRequest } from "fastify";

/** Matches the bootstrap `AuthenticateHook` shape without importing it (avoids an index↔plugin cycle). */
type AuthenticateHook = (request: FastifyRequest) => Promise<void> | void;

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly userId: string;
  /** Server-bound org; null for a pre-org session (authenticated but not yet org-bound). */
  readonly activeOrganizationId: string | null;
}

export interface SessionAuthenticateDeps {
  /** Read the session for a request (Better Auth in prod via getIdentitySession; a stub in tests). */
  getSnapshot(request: FastifyRequest): Promise<SessionSnapshot | null>;
  /** The SessionContextResolver seam — resolved lazily from the M1 registry at request time. */
  getResolver(): SessionContextResolver;
}

/** Build the authenticate hook. Anonymous requests leave request.context untouched. */
export function createSessionAuthenticate(deps: SessionAuthenticateDeps): AuthenticateHook {
  return async (request: FastifyRequest) => {
    const snap = await deps.getSnapshot(request);
    if (!snap) return; // unauthenticated — context stays anonymous (org routes deny)
    request.context.userId = snap.userId; // authenticated (pre-org or org-bound)
    if (!snap.activeOrganizationId) return; // pre-org: org-scoped routes gate on the missing org
    const scope: OrgScope = { orgId: snap.activeOrganizationId };
    const actor = await deps.getResolver().resolveActor(scope, snap.sessionId);
    if (!actor) return; // session/org mismatch — no org binding, no roles (no cross-tenant leak)
    request.context.organizationId = actor.organizationId;
    request.context.roles = [...actor.roles];
  };
}
