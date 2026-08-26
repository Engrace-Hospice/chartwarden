// apps/backend/src/modules/19-oncall/routes/guards.ts — M19-T07 (§4.1 / §4.7) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M19 route
// plugin composes (the M15/M16/M21/M23/M24/M26 routes/guards.ts precedent). Every §4.7 predicate resolves
// its subject facts server-side from the route's PATH PARAM or the SESSION — never from a caller-supplied
// org, actor or vendor claim.
//
// FOUR COMPOSITION RULES §4.1'S TABLE FORCES, each of which is easy to get exactly backwards:
//
//   1. THE PER-CALL CELL IS ONE PREDICATE CHOSEN BY SESSION CLASS, NOT TWO PREDICATES ANDED. §4.1 rows
//      3-15 say "(same)" and §6's last column grants a vendor operator four of those same rows. Two
//      `requireAbac` preHandlers would AND (the M16-T06 finding) and would then deny EVERYONE: a staff
//      clinician holds no vendor identity, and a vendor operator holds no caseload. {@link ABAC_CALL_ACTOR}
//      therefore picks `external_triage_actor` for a vendor-class session and
//      `triage_call_owner_or_supervisor` for every other, from the M2-assembled `sessionClass` — a fact no
//      request field can reach. See ../abac-predicates.ts decision 1 for why folding the vendor arm into
//      the owner predicate would have been worse.
//   2. `notFoundOnDeny` IS ON FOR THE PER-CALL ROUTES AND OFF FOR THE ESCALATION ONES. A triage call id
//      maps 1:1 to "this patient rang the after-hours line", which is PHI; §9.4's IDOR test asks that a
//      cross-tenant id be unprobeable, so a denied per-call route answers 404. An ESCALATION id discloses
//      nothing to a caller who already holds `triage.read_escalations` — and "not yours" is the answer a
//      supervisor scanning a shared inbox actually needs, because a 404 would send them hunting for a page
//      that is sitting in a colleague's queue. §8.3.1 likewise fixes the portal mismatch at 403.
//   3. THE GUARD IS NOT THE ONLY GATE. §7.3's disposition matrix, §7.2's mandatory-escalation block and
//      §2.5's version check all re-run INSIDE the write transaction. A request that slipped past a guard on
//      a grant revoked between preHandler and commit still cannot disposition a call. The guard is the cheap
//      early refusal; the machine is the authority.
//   4. STEP-UP IS COMPOSED WHERE §4.1 SAYS AND NOWHERE ELSE. The four keys are pinned in
//      `../permission-keys.ts` (`M19_STEP_UP_PERMISSION_KEYS`) and asserted by the §9 test. The §7.7 verbal
//      order is DELIBERATELY not among them: its step-up is asserted at the M11 seam call
//      (`../clinical/verbal-order.ts`), because the gate must hold for the seam invocation and not merely
//      for the HTTP request that started it — a worker retry path would otherwise carry no gate at all.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { VENDOR_SESSION_CLASSES } from "../abac-predicates";
import type { PreHandler } from "./actor";

type TargetRequest = {
  readonly params?: unknown;
  readonly body?: unknown;
  readonly query?: unknown;
};

const param = (request: TargetRequest, key: string): string =>
  (request.params as Record<string, string> | undefined)?.[key] ?? "";

const bodyField = (request: TargetRequest, key: string): string => {
  const value = (request.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
};

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M19 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.1 — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate (rule 4). */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;

/** The M2-assembled session class. Never a header, body or query field (§8.3.1). */
function sessionClassOfRequest(request: FastifyRequest): string {
  const value = request.context?.attributes?.sessionClass;
  return typeof value === "string" && value.length > 0 ? value : "staff";
}

/** Is the caller an external triage VENDOR operator (§7.5 / D13)? */
function isVendorSession(request: FastifyRequest): boolean {
  return (VENDOR_SESSION_CLASSES as readonly string[]).includes(sessionClassOfRequest(request));
}

/**
 * §4.1 rows 3-15 — THE per-call gate (rule 1). One preHandler; the predicate NAME is chosen by session
 * class at request time, so `external_triage_actor` and `triage_call_owner_or_supervisor` behave as the
 * alternatives §4.7 describes rather than as a conjunction that denies everyone.
 *
 * Implemented as a dispatching preHandler rather than as a `requireAbac` with a computed name, because
 * `requireAbac` binds its name at factory time; building BOTH guards once and choosing between them per
 * request is what keeps the name a compile-time constant on each path (and therefore visible to
 * `arch:abac-predicates`, which scans for literal predicate names).
 */
export function ABAC_CALL_ACTOR(action: string, idParam = "triageCallId"): PreHandler {
  const staffGuard = requireAbac(action, "triage_call_owner_or_supervisor", {
    getTarget: (r) => ({ triageCallId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true, // rule 2
  }) as PreHandler;
  const vendorGuard = requireAbac(action, "external_triage_actor", {
    getTarget: (r) => ({ triageCallId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true,
  }) as PreHandler;

  return async (request, reply) => {
    if (isVendorSession(request)) {
      await vendorGuard(request, reply);
      return;
    }
    await staffGuard(request, reply);
  };
}

/**
 * §4.1 row 1 — `oncall_eligible` on call OPEN. The target names the ProviderEntity off the BODY, which is
 * the one place it can come from: there is no row yet. That is safe because the predicate does not TRUST
 * the value — it asks whether the actor is on call FOR that PE, so naming someone else's PE denies rather
 * than escalates. `notFoundOnDeny` is off: an actor who is not on call must be told so, not told the
 * ProviderEntity does not exist.
 */
export const ABAC_ONCALL_ELIGIBLE = (action: string): PreHandler =>
  requireAbac(action, "oncall_eligible", {
    getTarget: (r) => ({ providerEntityId: bodyField(r as TargetRequest, "providerEntityId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 rows 2, 19, 24 — `caseload_or_scope` on the PHI LIST routes. M7 owns the predicate; M19 binds it by
 * name (a shared predicate is keyed on its OWNER's target shape — the M15-T06 lesson — so the target here
 * names `patientId` when the caller filtered by one and `{}` otherwise, which is the collection case M3's
 * own doc-comment describes: the predicate is the precondition, RLS plus the read service's own caseload
 * narrowing is the control).
 */
export const ABAC_CASELOAD_OR_SCOPE = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", {
    getTarget: (r) => {
      const query = ((r as TargetRequest).query ?? {}) as Record<string, unknown>;
      return typeof query.patientId === "string" ? { patientId: query.patientId } : {};
    },
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.1 row 16 — the escalation inbox (`escalation_recipient_scope`). No row yet; the actor's band decides. */
export const ABAC_ESCALATION_SCOPE = (action: string): PreHandler =>
  requireAbac(action, "escalation_recipient_scope", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.1 rows 17-18 — acknowledge / resolve one escalation (`escalation_recipient`; rule 2: 403, not 404). */
export const ABAC_ESCALATION_RECIPIENT = (action: string): PreHandler =>
  requireAbac(action, "escalation_recipient", {
    getTarget: (r) => ({ escalationId: param(r as TargetRequest, "escalationId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 row 36 — the M31 portal read (`portal_session_consent_active`).
 *
 * The target's `patientId` comes from the SESSION (`context.attributes.sessionPatientId`), never from the
 * query string. §8.3.1's threat (b) is precisely a caregiver with a valid portal session naming another
 * patient's id; taking the id from the session makes the mismatch unrepresentable rather than merely
 * refused, and §8.3.1 fixes the answer at 403.
 */
export const ABAC_PORTAL_CONSENT = (action: string): PreHandler =>
  requireAbac(action, "portal_session_consent_active", {
    getTarget: (r) => {
      const fromSession = (r as { context?: { attributes?: Record<string, unknown> } }).context
        ?.attributes?.sessionPatientId;
      return typeof fromSession === "string" ? { patientId: fromSession } : {};
    },
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 rows 20-23, 25-26, 27-35 — the ORG-SCOPED cells. M3's intrinsic `inOrg` is the base predicate every
 * org-scoped route composes on; binding it explicitly (rather than leaving the cell bare) is what keeps
 * "this route is org-scoped" a declared fact the §9 test can assert, instead of an absence.
 */
export const ABAC_IN_ORG = (action: string): PreHandler =>
  requireAbac(action, "inOrg", { getTarget: () => ({}), notFoundOnDeny: false }) as PreHandler;
