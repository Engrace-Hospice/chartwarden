// apps/backend/src/modules/20-field-safety/routes/guards.ts — M20-T06 (§4.1 / §4.7) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M20 route
// plugin composes (the M15/M16/M19/M21/M23/M24/M26 routes/guards.ts precedent). Every §4.7 predicate
// resolves its subject facts server-side from the route's PATH PARAM or the SESSION — never from a
// caller-supplied org or actor claim.
//
// FIVE COMPOSITION RULES §4.1'S TABLE FORCES, each of which is easy to get exactly backwards:
//
//   1. A `∨` CELL IS **ONE** PREHANDLER, NOT TWO. §4.1 spells six cells as disjunctions
//      (`clinician_self ∨ supervises_clinician`, `safety_supervisor_or_above ∨ clinician_self`, …). Two
//      `requireAbac` preHandlers would AND — the M16-T06 finding — and ANDing `clinician_self` with
//      `supervises_clinician` denies EVERYONE: §3.3's `m20_sss_no_self_supervision` CHECK makes a
//      supervisor who is also the subject structurally impossible. {@link ABAC_ANY} therefore evaluates
//      the named predicates in order through M3's registry and passes on the FIRST that allows, with each
//      name a compile-time literal so `arch:abac-predicates` still sees it.
//   2. `notFoundOnDeny` IS ON FOR THE PER-ROW PHI ROUTES AND OFF FOR THE ORG-SCOPED ONES. An SOS alert id
//      or a check-in id maps 1:1 to "this named clinician was in trouble at this hour", which §9.4's IDOR
//      test asks to be unprobeable — so a denied per-row route answers 404. A POLICY, a HIGH-RISK AREA or
//      a SUBSCRIPTION id discloses nothing to a caller who already holds the org-scoped read key, and
//      "not yours" is the answer a DON scanning a shared configuration surface actually needs.
//   3. THE GUARD IS NOT THE ONLY GATE. §2.2.2's transition table, D5's cancel window and §2.5's version
//      check all re-run INSIDE the write transaction. A request that slipped past a guard on a grant
//      revoked between preHandler and commit still cannot acknowledge an SOS. The guard is the cheap
//      early refusal; the machine is the authority.
//   4. STEP-UP IS COMPOSED WHERE §4.1 SAYS AND NOWHERE ELSE — the two keys pinned in
//      `../permission-keys.ts` (`M20_STEP_UP_PERMISSION_KEYS`), asserted by the §9 test. D5's cancel
//      BIOMETRIC is deliberately NOT a `requireStepUp`: see that file's doc-comment on why a session-level
//      re-auth would sail a hostile actor holding an already-stepped-up phone straight through.
//   5. `org_scope` IS M3's INTRINSIC `inOrg`. §4.7 defines the two as the same rule; M20 registers no
//      second name for it (../abac-predicates.ts states the decision). {@link ABAC_IN_ORG} binds it
//      explicitly rather than leaving the cell bare, so "this route is org-scoped" is a declared fact the
//      §9 test can assert instead of an absence.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PreHandler } from "./actor";

type TargetRequest = { readonly params?: unknown; readonly body?: unknown; readonly query?: unknown };

const param = (request: TargetRequest, key: string): string =>
  (request.params as Record<string, string> | undefined)?.[key] ?? "";

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M20 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.1 — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate (rule 4). */
export const STEP_UP = (operationKey: string): PreHandler => requireStepUp(operationKey) as PreHandler;

/**
 * Rule 1 — the §4.1 `∨` cell as ONE preHandler.
 *
 * Takes ALREADY-BUILT guards and runs them in order until one passes. A guard signals denial by throwing,
 * so "passed" is "did not throw"; the LAST failure is re-thrown when every arm refuses, which keeps the
 * 403-vs-404 shape of the last-listed arm. `notFoundOnDeny` is therefore kept uniform across the arms of
 * a single cell — mixing them would make the status code depend on which arm happened to be evaluated
 * last.
 *
 * IT TAKES GUARDS, NOT PREDICATE NAMES, AND THAT SIGNATURE IS THE POINT. A version that took
 * `names: string[]` and called `requireAbac(action, name, …)` in a loop compiles, runs and denies exactly
 * the same — and makes every name INVISIBLE to `arch:abac-predicates`, which scans for the literal second
 * argument of a `requireAbac` call. That gate exists because M30 shipped 15 guards on a predicate nothing
 * registered and no other check noticed; a helper that re-opened the hole while wearing its name would be
 * the worst possible place to reintroduce it. Each builder below therefore spells its predicate names as
 * literals in its own `requireAbac` calls.
 */
export function ABAC_ANY(...guards: readonly PreHandler[]): PreHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let lastError: unknown;
    for (const guard of guards) {
      try {
        await guard(request, reply);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
}

/** §4.1 rows 1, 3, 4, 6, 27-29 — the clinician acting on her own row. */
export const ABAC_SELF = (action: string, target: (r: FastifyRequest) => Record<string, unknown>) =>
  requireAbac(action, "clinician_self", {
    getTarget: target as never,
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.1 rows 2, 9 — `clinician_self ∨ supervises_clinician` on a per-row PHI read (404 on deny). */
export const ABAC_SELF_OR_SUPERVISOR = (
  action: string,
  idParam: string,
  idField: "checkInId" | "sosAlertId" | "incidentId",
): PreHandler => {
  // rule 2 — a safety-row id is 1:1 with "this clinician was in trouble at this hour".
  const opts = {
    getTarget: ((r: TargetRequest) => ({ [idField]: param(r, idParam) })) as never,
    notFoundOnDeny: true,
  };
  return ABAC_ANY(
    requireAbac(action, "clinician_self", opts) as PreHandler,
    requireAbac(action, "supervises_clinician", opts) as PreHandler,
  );
};

/** §4.1 row 5 — who may PRESS the button (`field_eligible_for_sos`). No row exists yet. */
export const ABAC_FIELD_ELIGIBLE = (action: string): PreHandler =>
  requireAbac(action, "field_eligible_for_sos", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.1 rows 7, 8 — acknowledge / resolve an ACTIVE alert (`active_sos_responder`; 404 on deny). */
export const ABAC_SOS_RESPONDER = (action: string, idParam = "sosAlertId"): PreHandler =>
  requireAbac(action, "active_sos_responder", {
    getTarget: (r) => ({ sosAlertId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true,
  }) as PreHandler;

/**
 * §4.1 row 10 — the coordinate stream: `active_sos_responder` (during) ∨ `safety_supervisor_or_above`
 * (after).
 *
 * §4.1's parenthetical is a TIME split, and it is expressed here as a disjunction rather than as a branch
 * on the alert's state, because the state is exactly what `active_sos_responder` already checks
 * (../abac-predicates.ts pins `ACTIVE_SOS_RESPONDER_STATES`). During an active alert the first arm
 * answers; once it resolves, the first arm fails on the state and the second — the Clin Supv / DON
 * after-the-fact read §6 grants — answers. Writing the split as a route-layer time comparison would put a
 * second, drifting copy of "is this alert still live" beside the machine's.
 */
export const ABAC_SOS_COORDS = (action: string, idParam = "sosAlertId"): PreHandler => {
  const opts = {
    getTarget: ((r: TargetRequest) => ({ sosAlertId: param(r, idParam) })) as never,
    notFoundOnDeny: true,
  };
  return ABAC_ANY(
    requireAbac(action, "active_sos_responder", opts) as PreHandler,
    requireAbac(action, "safety_supervisor_or_above", opts) as PreHandler,
  );
};

/** §4.1 row 11 — the active-SOS board: `safety_supervisor_or_above ∨ clinician_self`. No row named. */
export const ABAC_SUPERVISOR_OR_SELF = (action: string): PreHandler => {
  const opts = { getTarget: (() => ({})) as never, notFoundOnDeny: false };
  return ABAC_ANY(
    requireAbac(action, "safety_supervisor_or_above", opts) as PreHandler,
    requireAbac(action, "clinician_self", opts) as PreHandler,
  );
};

/** §4.1 rows 12, 13, 15 — the incident surface (`incident_subject_or_supervisor`). */
export const ABAC_INCIDENT_SUBJECT = (action: string, idParam?: string): PreHandler =>
  requireAbac(action, "incident_subject_or_supervisor", {
    getTarget: (r) =>
      idParam === undefined ? {} : { incidentId: param(r as TargetRequest, idParam) },
    notFoundOnDeny: idParam !== undefined,
  }) as PreHandler;

/**
 * §4.1 row 14 — `PATCH /incidents/:id`: `clinician_self` (draft) ∨ `safety_supervisor_or_above`.
 *
 * The `(draft)` qualifier is NOT expressed here. It is a lifecycle fact, and the write service re-checks
 * it inside the transaction (§2.2.3: a submitted incident is immutable to its subject) — putting a state
 * read in the guard would mean two places decide when a draft stops being editable, and the one that is
 * not the transaction is the one that can be stale.
 */
export const ABAC_INCIDENT_EDIT = (action: string, idParam = "incidentId"): PreHandler => {
  const opts = {
    getTarget: ((r: TargetRequest) => ({ incidentId: param(r, idParam) })) as never,
    notFoundOnDeny: true,
  };
  return ABAC_ANY(
    requireAbac(action, "clinician_self", opts) as PreHandler,
    requireAbac(action, "safety_supervisor_or_above", opts) as PreHandler,
  );
};

/** §4.1 rows 16, 17, 19, 20-22, 24, 25 — oversight by office (`safety_supervisor_or_above`). */
export const ABAC_SUPERVISOR = (action: string): PreHandler =>
  requireAbac(action, "safety_supervisor_or_above", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 row 26 — the dashboard: `safety_supervisor_or_above ∨ caseload_or_scope`.
 *
 * `caseload_or_scope` is M7's predicate and a shared predicate is keyed on its OWNER's target shape (the
 * M15-T06 lesson), so the target names `patientId` when the caller filtered by one and `{}` otherwise —
 * the collection case M3's own doc-comment describes. The board's own row filtering (a clinician sees only
 * herself) is the read service's, not the guard's.
 */
export const ABAC_DASHBOARD = (action: string): PreHandler => {
  const opts = {
    getTarget: ((r: TargetRequest) => {
      const query = (r.query ?? {}) as Record<string, unknown>;
      return typeof query.patientId === "string" ? { patientId: query.patientId } : {};
    }) as never,
    notFoundOnDeny: false,
  };
  return ABAC_ANY(
    requireAbac(action, "safety_supervisor_or_above", opts) as PreHandler,
    requireAbac(action, "caseload_or_scope", opts) as PreHandler,
  );
};

/** §4.1 rows 18, 23 — the ORG-SCOPED cells (§4.7's `org_scope` ≡ M3's intrinsic `inOrg`; rule 5). */
export const ABAC_IN_ORG = (action: string): PreHandler =>
  requireAbac(action, "inOrg", { getTarget: () => ({}), notFoundOnDeny: false }) as PreHandler;
