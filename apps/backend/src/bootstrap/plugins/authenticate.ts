// apps/backend/src/bootstrap — the production authenticate hook (M1 host, AUTH-T03, ADR-0033).
//
// Resolves a request to its authenticated, org-scoped context: read the session snapshot (injected —
// Better-Auth-backed in production, a stub in tests), then drive the SessionContextResolver seam to
// populate request.context (actor + org + roles). No better-auth import here — the snapshot reader is
// injected, so this stays M1-owned and unit-testable. Roles come from the resolver (M2 over the M1
// session repo); permission evaluation remains M3's separate concern.
import { timingSafeEqual } from "node:crypto";
import {
  DEVICE_ATTESTATION_ATTRIBUTE,
  type SessionTimeoutEnforcer,
  sessionClassRequiresMfa,
} from "@chartwarden/auth";
import { type OrgScope, type SessionContextResolver, ChartWardenError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { stepUpFreshFor } from "../step-up";

/** Matches the bootstrap `AuthenticateHook` shape without importing it (avoids an index↔plugin cycle). */
type AuthenticateHook = (request: FastifyRequest) => Promise<void> | void;

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly userId: string;
  /** Server-bound org; null for a pre-org session (authenticated but not yet org-bound). */
  readonly activeOrganizationId: string | null;
  readonly passwordChangeRequired?: boolean;
}

/** The shared secret an internal (non-interactive) caller presents to authenticate as a system principal. */
export interface SystemCredentialConfig {
  /** The `INTERNAL_SERVICE_TOKEN` value (bootstrap/env.ts requires ≥32 chars in production). */
  readonly token: string;
}

const SYSTEM_TOKEN_HEADER = "x-internal-service-token";
const SYSTEM_ORG_HEADER = "x-internal-org-id";
/** HTTP methods an `auditor`-class session may use (M2 §2.2.4: auditor sessions are read-only). */
const AUDITOR_SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * The only mutations an auditor session may make: ending its own session, and redeeming a (second)
 * engagement link — which replaces it (no concurrent auditor sessions) and authenticates by token.
 */
const AUDITOR_ALLOWED_MUTATION_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/sign-out",
  "/api/v1/auditors/redeem",
]);

/**
 * M2 §7.7 — the ONLY routes an ENROLMENT-stage auditor session may call (method + path, exact). Everything
 * else — including the engagement read — is refused until the BAA is accepted and a second factor proven,
 * and the enrolment service upgrades the session to `active`. Sign-out and a (second) link redemption stay
 * reachable so a half-enrolled auditor can always leave or start over.
 */
const AUDITOR_ENROLMENT_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/v1/auth/csrf",
  "GET /api/v1/auditors/enrolment/state",
  "POST /api/v1/auditors/enrolment/baa",
  "POST /api/v1/auditors/enrolment/totp/begin",
  "POST /api/v1/auditors/enrolment/totp/confirm",
  "POST /api/v1/auditors/enrolment/verify",
]);

/**
 * GAP-003 - the prefixes an MFA-enrolment-stage session may still call: Better Auth's own surface (enrol TOTP /
 * passkey, sign out) and the pre-org account routes. Everything else is refused until the factor exists.
 */
const MFA_ENROLMENT_ALLOWED_PREFIXES: readonly string[] = ["/api/auth/", "/api/v1/auth/"];

/** GAP-002 — a timer poll the user did not cause; checked for timeout but not counted as activity. */
const BACKGROUND_HEADER = "x-chartwarden-background";

/** Exact capabilities of a limited password-rotation session. No business route uses this prefix. */
const PASSWORD_CHANGE_ALLOWED_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/auth/get-session",
  "POST /api/auth/sign-out",
  "GET /api/v1/auth/csrf",
  "GET /api/v1/auth/credential-status",
  "POST /api/v1/auth/password/complete-required-change",
]);

function assertCredentialStateMayCall(
  request: FastifyRequest,
  required: boolean | undefined,
): void {
  if (!required) return;
  const path = request.url.split("?")[0] ?? "";
  if (PASSWORD_CHANGE_ALLOWED_ROUTES.has(`${request.method.toUpperCase()} ${path}`)) return;
  throw new ChartWardenError(
    "PASSWORD_CHANGE_REQUIRED",
    "change the temporary password before accessing ChartWarden",
    403,
  );
}

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
  /**
   * GAP-002 — the server-side SESSION_POLICY idle/absolute enforcer (M2 §2.2.4). Called once per
   * request before anything is stamped; an expired session is deleted by the enforcer and the request
   * proceeds ANONYMOUS, carrying `attributes.sessionExpired` so the error handler can answer 401
   * SESSION_EXPIRED rather than a bare UNAUTHORIZED. Absent (unit tests that do not exercise it) → no
   * timeout check.
   */
  sessionTimeout?: Pick<SessionTimeoutEnforcer, "enforce">;
  /**
   * GAP-003 / GAP-005 - the MFA matrix (M2 section 2.3). Called for an org-bound STAFF session with its resolved
   * roles; `satisfied: false` holds the session at the enrolment stage (only {@link MFA_ENROLMENT_ALLOWED_PREFIXES}
   * stay reachable) - the same shape as the auditor enrolment stage. Absent means the matrix is not enforced.
   */
  mfaEnrolment?: {
    check(input: {
      userId: string;
      sessionId: string;
      roleKeys: readonly string[];
    }): Promise<{ satisfied: boolean; requirement: string; reason?: string }>;
  };
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

/**
 * The auditor method/route gate (M2 §2.2.4 read-only + §7.7 enrolment). An `active` session is read-only
 * (sign-out and a second redemption are the only mutations); any other stage - fail closed - may call
 * exactly the enrolment routes plus those two.
 */
function assertAuditorMayCall(request: FastifyRequest, stage: "enrolment" | "active" | null): void {
  const method = request.method.toUpperCase();
  const path = request.url.split("?")[0] ?? "";
  if (stage === "active") {
    if (AUDITOR_SAFE_METHODS.has(method) || AUDITOR_ALLOWED_MUTATION_PATHS.has(path)) return;
    throw new ChartWardenError("AUDITOR_READ_ONLY", "auditor sessions are read-only", 403);
  }
  if (
    AUDITOR_ENROLMENT_ROUTES.has(`${method} ${path}`) ||
    AUDITOR_ALLOWED_MUTATION_PATHS.has(path)
  ) {
    return;
  }
  throw new ChartWardenError(
    "AUDITOR_ENROLMENT_REQUIRED",
    "accept the engagement terms and verify a second factor before using this session",
    403,
  );
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
    if (deps.sessionTimeout) {
      const state = await deps.sessionTimeout.enforce(snap.sessionId, {
        recordActivity: headerOf(request, BACKGROUND_HEADER) !== "1",
      });
      if (state !== "active") {
        // Terminal: the enforcer has deleted the row. Nothing about the session is stamped, so
        // every guard sees an anonymous caller; public routes (sign-in) still work.
        request.context.attributes ??= {};
        request.context.attributes.sessionExpired = state;
        return;
      }
    }
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
    // Global and backend-enforced: this runs before the pre-org return and before tenant resolution,
    // so org switching, passkey sessions, refreshes and direct REST calls cannot bypass rotation.
    assertCredentialStateMayCall(request, snap.passwordChangeRequired);
    if (!snap.activeOrganizationId) return; // pre-org: org-scoped routes gate on the missing org
    const scope: OrgScope = { orgId: snap.activeOrganizationId };
    const actor = await deps.getResolver().resolveActor(scope, snap.sessionId);
    if (!actor) return; // session/org mismatch — no org binding, no roles (no cross-tenant leak)
    // M2 §2.2.4 — an `auditor`-class session is READ-ONLY, enforced here for every route (the class
    // descriptor's `readOnly` flag had no reader, and the auditor role's single read permission is the second
    // layer, not the only one). The only mutation allowed is signing out.
    if (actor.sessionClass === "auditor") {
      assertAuditorMayCall(request, actor.auditorStage ?? null);
    }
    if (deps.mfaEnrolment && sessionClassRequiresMfa(actor.sessionClass)) {
      const verdict = await deps.mfaEnrolment.check({
        userId: actor.userId,
        sessionId: snap.sessionId,
        roleKeys: actor.roles,
      });
      if (!verdict.satisfied) {
        const path = request.url.split("?")[0] ?? "";
        if (!MFA_ENROLMENT_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
          throw new ChartWardenError(
            "MFA_ENROLMENT_REQUIRED",
            verdict.reason === "not_verified"
              ? "sign in again with your second factor before continuing (required for your role)"
              : verdict.requirement === "passkey"
                ? "register a passkey before continuing (required for your role)"
                : "enrol an authenticator app or passkey before continuing (required for your role)",
            403,
          );
        }
      }
    }
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
    // Stamp the SESSION CLASS and, for the three M31 portal classes, the portal account + bound
    // patient (F-030). M16, M19, M31 and M39 all read `sessionClass`, and M16/M19/M31 gate on it being
    // one of the portal classes — which the `session_class` enum did not even contain until migration
    // 0219, so every one of those predicates denied unconditionally and the whole portal ABAC surface
    // with them. `portalAccountId`/`sessionPatientId` come off the session's `scope` jsonb, which is the
    // only legitimate source: M31's `portalAccountIdOf` throws 403 rather than fall back to a request
    // parameter (§8.3.1 threat (b) is a valid session naming another patient's id in the query string).
    //
    // `sessionPatientId` is ONE key rather than the three the readers used to ask for. M31 and M19's
    // portal guards read `portalPatientId`, M19's portal-triage routes read `portalPatientId ??
    // patientId`, and M7's `caseload_or_scope` read a `scopePatientIds` array — three names, one fact
    // (`session.scope.patientId`), and nothing wrote any of them. It is deliberately not named for a
    // class: M7's readers are `external_collaborator` sessions, which are pinned to a patient from the
    // moment they are minted, so `portal…` would have become the fourth name instead of the last one.
    // It is legitimately null on a portal session until `select-patient` binds it (M31 §2.3 / D2).
    request.context.attributes.sessionClass = actor.sessionClass;
    if (actor.portalAccountId) request.context.attributes.portalAccountId = actor.portalAccountId;
    if (actor.sessionPatientId)
      request.context.attributes.sessionPatientId = actor.sessionPatientId;
    // GAP-093(c) — the auditor session's OWN engagement, for M31's `portal_engagement_scope`. Stamped only
    // for the `auditor` class and only from the resolver (`session.scope.engagementId`, class- and
    // window-gated at the source by `sessionEngagementId`) — never from a header or the route, which is
    // exactly the claim the predicate compares this against.
    //
    // M2 §7.7 — an ENROLMENT-stage session does NOT get `engagementId`: the engagement read's
    // `portal_engagement_scope` predicate therefore denies it even if a route were ever reachable. The enrolment
    // routes read the separate `auditorEnrolmentEngagementId`, which names no read scope at all.
    if (actor.sessionClass === "auditor" && actor.engagementId) {
      request.context.attributes.auditorEnrolmentEngagementId = actor.engagementId;
      if (actor.auditorStage === "active") {
        request.context.attributes.engagementId = actor.engagementId;
      }
    }
    if (actor.sessionClass === "auditor") {
      request.context.attributes.auditorStage = actor.auditorStage ?? "enrolment";
    }
    // SecHardening §12.4 — the platform's OWN verdict on the device, resolved from M2's
    // `device_attestation` row and never from anything the request carries. Stamped only when a LIVE
    // attestation stands behind the session: absent means "no attested device", which is exactly what
    // `deviceAttestationValid` must read as deny. Writing `{ valid: false }` instead would be the same
    // decision at the gate and a worse record at the audit — see `liveDeviceAttestation`.
    if (actor.deviceAttestation) {
      request.context.attributes[DEVICE_ATTESTATION_ATTRIBUTE] = actor.deviceAttestation;
    }
    // F-030 — the `external_triage_vendor` an M19 answering-service session acts for. Class-gated at
    // the source, so a staff session carrying a stray `scope.externalActorId` stamps nothing: this key
    // IS what `external_triage_actor` compares against, and a session that could acquire it any other
    // way would reach a vendor-scoped triage call.
    if (actor.externalActorId) {
      request.context.attributes.externalActorId = actor.externalActorId;
    }
    request.context.attributes.stepUpRecent = await stepUpFreshFor({
      organizationId: actor.organizationId,
      sessionId: snap.sessionId,
      resolver: deps.getResolver(),
    });
  };
}
