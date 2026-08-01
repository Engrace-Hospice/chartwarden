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
    // Expose the real Better Auth session id so route helpers (e.g. select-organization's session
    // writer) can act on the actual session row, not the per-request id. Init the bag if absent.
    (request.context.attributes ??= {}).sessionId = snap.sessionId;
    // Stamp the PRINCIPAL KIND. This hook only ever resolves an interactive Better Auth session, so
    // the answer here is always "user" — but it must be WRITTEN rather than left absent, because the
    // readers split two ways on it and they disagree about what absence means:
    //   • `requireSystemPrincipal()` (M23 §4.1 internal seams) demands exactly "system" ⇒ absence
    //     fails CLOSED, which is why those two routes 403 for every caller today.
    //   • `rejectAiActor()` (M15/M23/M24 §D13 AI-block) coalesces a missing value to "user" ⇒ absence
    //     fails OPEN. Harmless while no AI principal can authenticate, but it is an AI-block that has
    //     never actually blocked anything, and "nobody set it" is not a safe default for that check.
    // THIS IS THE ONE PLACE A PRINCIPAL KIND MAY BE SET. A machine/service credential must set
    // "system" here — never at a route, and never off a request header, which would let a caller
    // promote itself past `requireSystemPrincipal()` and read any tenant it names.
    request.context.attributes.actorKind = "user";
    if (!snap.activeOrganizationId) return; // pre-org: org-scoped routes gate on the missing org
    const scope: OrgScope = { orgId: snap.activeOrganizationId };
    const actor = await deps.getResolver().resolveActor(scope, snap.sessionId);
    if (!actor) return; // session/org mismatch — no org binding, no roles (no cross-tenant leak)
    request.context.organizationId = actor.organizationId;
    request.context.roles = [...actor.roles];
    // Stamp the ACTIVE membership id the §4.x ownership predicates read. Seven modules
    // (M15/M16/M20/M21/M30/M33/M34) resolve `context.attributes.membershipId` and their doc comments
    // already assert this hook sets it — it did not, so every one of them read `null` and denied.
    // They fail CLOSED, so this was silently-dead authorization rather than exposure: M34's D16
    // `support_session_actor_distinct_from_grantor` separation-of-duties check and M33's
    // `dashboard_visibility` owner clause could never allow. Worse, support-sessions.ts falls back to
    // `ctx.userId` for the RECORDED actor while the predicate denied on null — the identity written to
    // the record and the identity checked were different values. `membershipId` is nullable on
    // ResolvedActor (no active membership → null), which those predicates already treat as deny.
    request.context.attributes.membershipId = actor.membershipId;
  };
}
