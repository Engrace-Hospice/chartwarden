// apps/backend/src/modules/25-remittance/routes/guards.ts — M25 (§4.6 / §4.7) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M25 route
// plugin composes (the M27/M30 routes/guards.ts precedent). Each is cast to the local {@link PreHandler}.
// The §4.7 predicates resolve their facts SERVER-SIDE from the route's `:id`: the denial routes map `:id`
// onto `denialCaseId` for `claim_assigned_to_actor`; the appeal-submit route maps `:id` onto `appealCaseId`
// for `appeal_within_deadline`. `notFoundOnDeny:true` realizes the §2.2 existence-non-leak (a denied
// object-level check returns 404, not 403). The §D15 step-up gate composes on adjustment-override /
// appeal.submit / denial.close_with_write_off (the operation key is the permission key so M3-T07 resolves
// the per-op freshness policy).
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import type { PreHandler } from "./actor";

type TargetRequest = { readonly params?: unknown; readonly body?: unknown };

/** Map the route's `:id` path-param onto the `denialCaseId` ABAC target. */
const targetDenialCaseId = (request: TargetRequest): Record<string, unknown> => {
  const params = request.params as { id?: string } | undefined;
  return { denialCaseId: params?.id ?? "" };
};

/** Map the route's `:id` path-param onto the `appealCaseId` ABAC target. */
const targetAppealCaseId = (request: TargetRequest): Record<string, unknown> => {
  const params = request.params as { id?: string } | undefined;
  return { appealCaseId: params?.id ?? "" };
};

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M25 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.7 `claim_assigned_to_actor` over the route's `:id` denial case — guards denial.read + the worklist item. */
export const ASSIGNED_TO_ACTOR = (key: string): PreHandler =>
  requireAbac(key, "claim_assigned_to_actor", {
    getTarget: targetDenialCaseId,
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.7 `appeal_within_deadline` over the route's `:id` appeal — the hard T-0 block on appeal.submit (D6/D7). */
export const WITHIN_DEADLINE = (key: string): PreHandler =>
  requireAbac(key, "appeal_within_deadline", {
    getTarget: targetAppealCaseId,
    notFoundOnDeny: false,
  }) as PreHandler;

/** §D15 step-up gate — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate. */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;
