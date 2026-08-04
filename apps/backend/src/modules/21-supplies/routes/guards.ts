// apps/backend/src/modules/21-supplies/routes/guards.ts — M21-T05 (§4.3 / §4.4) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` preHandler factories every M21 route plugin composes (the
// M15/M16/M23/M24/M26 routes/guards.ts precedent). The §4.4 predicates resolve their subject facts
// server-side from the route's path param — never from a caller-supplied org/actor claim.
//
// THREE composition rules the §4.1 table forces, each of which is easy to get exactly backwards:
//
//   1. ROW 1'S ABAC CELL IS CONDITIONAL. §4.1 binds `controlled_substance_dispatcher_eligible` on
//      `POST /supply-requests` "(when kind=comfort_kit_deploy)". A preHandler cannot see the parsed body's
//      discriminated union before the handler runs, but it CAN read the raw `kindPayload.kind`, so
//      {@link ABAC_DISPATCHER_ON_KIND} maps that onto the target's `involvesControlledSubstance` and the
//      predicate short-circuits to allow for the two non-kit kinds. Binding it unconditionally would have
//      made every wound-supply request require controlled-substance dispatch authority — which would
//      ground the aides who file most of them, and is strictly stricter than the spec.
//   2. THE PREDICATE IS NOT THE ONLY GATE. §2.5's `assertDispatchValid` re-checks dispatcher eligibility
//      INSIDE the transaction (`M21_CONTROLLED_SUBSTANCE_DISPATCHER_DENIED`). A request that slipped past
//      the guard on a grant revoked between preHandler and commit still cannot ship a kit. The guard is
//      the cheap early refusal; the machine is the authority.
//   3. `notFoundOnDeny` IS OFF ON THE KIT ROUTES, and that is deliberate — the opposite of M16's posture.
//      M16 hid a bereavement plan behind a 404 because the mere existence of one discloses that a patient
//      died. A comfort-kit dispatch id discloses nothing a caller who already holds
//      `comfort_kit.dispatch.read` does not have; and a 403 is the answer a supply coordinator who is not
//      the right Location actually needs to see, because "not found" would send them hunting for a kit
//      that is sitting on the shelf they can see. The one exception is the per-patient request list, which
//      is addressed by patient id and does 404.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { PreHandler } from "./actor";

type TargetRequest = {
  readonly params?: unknown;
  readonly body?: unknown;
  readonly query?: unknown;
};

const param = (request: TargetRequest, key: string): string =>
  (request.params as Record<string, string> | undefined)?.[key] ?? "";

const bodyObject = (request: TargetRequest): Record<string, unknown> =>
  (request.body as Record<string, unknown> | undefined) ?? {};

const bodyField = (request: TargetRequest, key: string): string => {
  const value = bodyObject(request)[key];
  return typeof value === "string" ? value : "";
};

/** The two kit kinds §4.1 row 1's conditional cell is about (`comfort_kit_replenish` tops up the same
 *  scheduled lots the deploy filled, so it is exactly as controlled as the first fill). */
const KIT_KINDS = new Set(["comfort_kit_deploy", "comfort_kit_replenish"]);

/** RBAC gate — `requirePermission(key)` from M3 (the §4.3 key catalog M21 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/**
 * §4.1 row 1 — `controlled_substance_dispatcher_eligible`, CONDITIONAL on the request kind (see rule 1 in
 * the module header). The target carries the declared serving Location and whether the kind moves a
 * scheduled drug; the predicate allows outright for a non-kit kind and evaluates the full §4.4 rule
 * otherwise.
 */
export const ABAC_DISPATCHER_ON_KIND = (key: string): PreHandler =>
  requireAbac(key, "controlled_substance_dispatcher_eligible", {
    getTarget: (r) => {
      const body = bodyObject(r);
      const payload = (body.kindPayload ?? {}) as Record<string, unknown>;
      const kind = typeof payload.kind === "string" ? payload.kind : "";
      return {
        locationId: bodyField(r, "locationId"),
        involvesControlledSubstance: KIT_KINDS.has(kind),
      };
    },
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 row 20 — `controlled_substance_dispatcher_eligible` on dispatch CREATION. There is no dispatch row
 * yet, so the target names the Location off the body and declares the movement controlled unconditionally:
 * every `comfort_kit_dispatch` is a controlled-substance custody record by construction (§3.1.9's CHECK
 * makes lot + expiration mandatory on the scheduled lines), so there is no kind to branch on here.
 */
export const ABAC_DISPATCHER_ON_CREATE = (key: string): PreHandler =>
  requireAbac(key, "controlled_substance_dispatcher_eligible", {
    getTarget: (r) => ({
      locationId: bodyField(r, "locationId"),
      involvesControlledSubstance: true,
    }),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.4 `controlled_substance_dispatcher_eligible` over an EXISTING dispatch (`:dispatchId`). */
export const ABAC_DISPATCHER_ON_ROW = (key: string): PreHandler =>
  requireAbac(key, "controlled_substance_dispatcher_eligible", {
    getTarget: (r) => ({ dispatchId: param(r, "dispatchId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 row 27 — `comfort_kit_return_reconciler_eligible` over the route's `:returnId`. The predicate reads
 * the ORIGINATING dispatch to compare dispatcher against reconciler (§4.4's separation-of-duties clause),
 * which is why the target names the return and not the dispatch: the return is the row that knows both.
 */
export const ABAC_RECONCILER = (key: string): PreHandler =>
  requireAbac(key, "comfort_kit_return_reconciler_eligible", {
    getTarget: (r) => ({ returnId: param(r, "returnId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate.
 *
 * §4.1's table carries no step-up column, but the M3 §4.2.1 policy family names controlled-substance
 * movement, and two M21 operations are exactly that: signing a comfort-kit dispatch and signing its
 * reconciliation. Both are DEA-attributable signatures on a scheduled drug, which is the same class of act
 * as M16's plan close and M14's IDG adjournment. Binding step-up here is stricter than §4.1 literally
 * requires; architecture (the security-hardening step-up policy) wins over a module spec's omission.
 */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;
