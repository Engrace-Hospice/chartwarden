// apps/backend/src/bootstrap — the production authenticate hook (M1 host, AUTH-T03, ADR-0033).
//
// Resolves a request to its authenticated, org-scoped context: read the session snapshot (injected —
// Better-Auth-backed in production, a stub in tests), then drive the SessionContextResolver seam to
// populate request.context (actor + org + roles). No better-auth import here — the snapshot reader is
// injected, so this stays M1-owned and unit-testable. Roles come from the resolver (M2 over the M1
// session repo); permission evaluation remains M3's separate concern.
import { timingSafeEqual } from "node:crypto";
import type { OrgScope, SessionContextResolver } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { stepUpFreshFor } from "../step-up";

/** Matches the bootstrap `AuthenticateHook` shape without importing it (avoids an index↔plugin cycle). */
type AuthenticateHook = (request: FastifyRequest) => Promise<void> | void;

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly userId: string;
  /** Server-bound org; null for a pre-org session (authenticated but not yet org-bound). */
  readonly activeOrganizationId: string | null;
}

/** The shared secret an internal (non-interactive) caller presents to authenticate as a system principal. */
export interface SystemCredentialConfig {
  /** The `INTERNAL_SERVICE_TOKEN` value (bootstrap/env.ts requires ≥32 chars in production). */
  readonly token: string;
}

const SYSTEM_TOKEN_HEADER = "x-internal-service-token";
const SYSTEM_ORG_HEADER = "x-internal-org-id";

export interface SessionAuthenticateDeps {
  /** Read the session for a request (Better Auth in prod via getIdentitySession; a stub in tests). */
  getSnapshot(request: FastifyRequest): Promise<SessionSnapshot | null>;
  /** The SessionContextResolver seam — resolved lazily from the M1 registry at request time. */
  getResolver(): SessionContextResolver;
  /**
   * The internal-seam machine credential (M23 #39/#40, M15's `/internal/...` routes — `requireSystemPrincipal()`).
   * Absent by default: without a configured secret, NOTHING can authenticate as a system principal —
   * those routes stay unreachable exactly as before, rather than accepting an unconfigured/empty match.
   */
  systemCredential?: SystemCredentialConfig;
}

/** Constant-time header/secret comparison (mirrors the M12/M19/M20/M13 witness-token precedent). */
function timingSafeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A single request header value, or null (absent / repeated). Fastify lower-cases header names. */
function headerOf(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Build the authenticate hook. Anonymous requests leave request.context untouched. */
export function createSessionAuthenticate(deps: SessionAuthenticateDeps): AuthenticateHook {
  return async (request: FastifyRequest) => {
    // The machine-credential path (internal seam routes, system-to-system only). Checked FIRST and
    // independent of the interactive Better Auth session: a caller presenting the shared secret is
    // never treated as an interactive user, and a caller WITHOUT it falls through to the normal
    // (session-based) path unaffected — the two are mutually exclusive by construction, not priority.
    // THIS IS THE ONLY OTHER PLACE (besides the "user" stamp below) a principal kind may be set — see
    // that comment for why `actorKind` absence/mis-set is a real authorization bug, not cosmetic.
    if (deps.systemCredential) {
      const presented = headerOf(request, SYSTEM_TOKEN_HEADER);
      if (presented && timingSafeMatch(presented, deps.systemCredential.token)) {
        const orgId = headerOf(request, SYSTEM_ORG_HEADER);
        request.context.userId = "system";
        request.context.attributes ??= {};
        request.context.attributes.actorKind = "system";
        if (orgId) request.context.organizationId = orgId; // absent → org-gated system routes still deny
        return;
      }
    }
    const snap = await deps.getSnapshot(request);
    if (!snap) return; // unauthenticated — context stays anonymous (org routes deny)
    request.context.userId = snap.userId; // authenticated (pre-org or org-bound)
    // Expose the real Better Auth session id so route helpers (e.g. select-organization's session
    // writer) can act on the actual session row, not the per-request id. Init the bag if absent.
    request.context.attributes ??= {};
    request.context.attributes.sessionId = snap.sessionId;
    // Stamp the PRINCIPAL KIND. This hook only ever resolves an interactive Better Auth session, so
    // the answer here is always "user" — but it must be WRITTEN rather than left absent, because the
    // readers split two ways on it and they disagree about what absence means:
    //   • `requireSystemPrincipal()` (M23 §4.1 internal seams) demands exactly "system" ⇒ absence
    //     fails CLOSED, which is why those two routes 403 for every caller today.
    //   • `rejectAiActor()` (M15/M23/M24 §D13 AI-block) coalesces a missing value to "user" ⇒ absence
    //     fails OPEN. Harmless while no AI principal can authenticate, but it is an AI-block that has
    //     never actually blocked anything, and "nobody set it" is not a safe default for that check.
    // THIS IS THE OTHER PLACE A PRINCIPAL KIND MAY BE SET (the system-credential branch above is the
    // first) — a machine/service credential sets "system" only through the verified shared-secret
    // check, never at a route, and never off an unverified request header, which would let a caller
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
    // Stamp the actor's PE/location SCOPE (ARCH-008/009). `request.context.providerEntityIds`/
    // `.locationIds` were declared on `HttpRequestContext` and initialized to `[]` in
    // `request-context.ts`, but nothing ever wrote them here — so `provider_entity_scope` /
    // `location_scope` (packages/auth/src/abac/registry.ts) and every module's own PE/location ABAC
    // predicate (M14 `idg_meeting_scope`, M20/M23/M24's PE checks) denied unconditionally in
    // production: an empty scope array can never contain a target's id. M20's `providerEntityOf()`
    // (routes/actor.ts) went further and THREW `ForbiddenError` whenever the (always-empty) array's
    // length wasn't exactly 1 — every field-safety check-in 403'd. M7/M20/M21/M27 each grew their own
    // redundant per-request `memberships.defaultProviderEntityId`/`defaultLocationIds` re-query as a
    // workaround (see M27 `loadMembershipProviderScope`); this is the real, shared assembly they were
    // standing in for.
    request.context.providerEntityIds = [...actor.providerEntityIds];
    request.context.locationIds = [...actor.locationIds];
    // Stamp the STEP-UP freshness fact (F-029). Fifteen modules lift
    // `context.attributes.stepUpRecent` off the context into their route actor, and their doc
    // comments assert this hook sets it — nothing ever did, so every one of them read `false` for
    // every request. The same defect as `membershipId` and the PE/location scopes above, in the same
    // hook, one line further down.
    //
    // It fails CLOSED, so this was never exposure — but four routes are worse off than "a control
    // that never fires": M37's IRC cap override and restraint apply, M23's claim submit/replace/void
    // and M27's cost-report submit all mount `requireStepUp(...)`, which PASSES (that path is real),
    // and then hand the always-false flag to a service or a pure machine that refuses. The guard
    // allowed and the domain refused, for every caller, always. No test saw it: the live suites build
    // the actor directly with `stepUpRecent: true` and every inject suite stubs the attribute in its
    // own fake authenticate hook, so the production assembly was the one path nothing exercised.
    //
    // This is the FLOOR answer. The policy is tightenable per operation
    // (`tenant_step_up_policy_override`, §4.3.2 D9) and this hook does not know which operation the
    // request is for, so the attribute carries the platform-floor decision only — which is exactly
    // what all fifteen readers already assume it is. `requireStepUp(opKey)` remains the
    // per-operation form and resolves the tightened policy itself; the two agree except where a
    // tenant has tightened, where the guard is the stricter of the two. Never read this attribute as
    // authoritative for a tightened operation.
    request.context.attributes.stepUpRecent = await stepUpFreshFor({
      organizationId: actor.organizationId,
      sessionId: snap.sessionId,
      resolver: deps.getResolver(),
    });
  };
}
