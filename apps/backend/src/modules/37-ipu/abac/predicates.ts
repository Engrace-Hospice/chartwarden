// apps/backend/src/modules/37-ipu/abac/predicates.ts — M37 §4.7.
//
// The five named ABAC predicate resolvers M37 OWNS and registers into M3's named-predicate registry. Each
// is a pure `(context, target) => boolean` evaluated server-side AFTER RBAC passes; M37 never authorizes by
// reading the request body — the route write service resolves the DB fact (RN-coverage window, IRC episode
// state, equipment inspection currency, attester discipline, staff-assignment membership) under RLS and
// puts it on the ABAC target, and the pure §2 domain machines RE-ASSERT the same invariant inside the write
// transaction (defense in depth). Default-deny throughout: a missing fact fails closed. `inOrg` (M3) is the
// re-used base predicate every route also composes; it is not re-registered here.
//
// The five names M37 owns (§4.7):
//   m37.ipu.rn_coverage_active         — the unit's 24/7 RN coverage is active (or a break-glass override).
//   m37.irc_episode.within_cap         — the admission's IRC episode is not breached.
//   m37.equipment.inspection_current   — the equipment's biomed inspection is not overdue.
//   m37.gip_criteria.attester_eligible — the actor is a hospice MD with an active M40 ExternalPhysician.
//   m37.ipu.staff_member               — the actor has an active IPU staff assignment on the unit (or is a
//                                        unit/medical director with org-wide access).
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";

/** The §4.7 predicate names M37 OWNS. `inOrg` (M3) is excluded — re-used, never re-registered. */
export const M37_REGISTERED_ABAC_PREDICATES = [
  "m37.ipu.rn_coverage_active",
  "m37.irc_episode.within_cap",
  "m37.equipment.inspection_current",
  "m37.gip_criteria.attester_eligible",
  "m37.ipu.staff_member",
] as const;
export type M37RegisteredAbacPredicate = (typeof M37_REGISTERED_ABAC_PREDICATES)[number];

/** Read a boolean fact off the ABAC target; fail-closed (false) when absent or non-boolean. */
const targetBool = (target: AbacTarget, field: string): boolean => target[field] === true;

/** Build the five pure M37 predicates. */
export function buildM37AbacPredicates(): Record<
  M37RegisteredAbacPredicate,
  (c: AbacContext, t: AbacTarget) => boolean
> {
  return {
    // §2.3 — the unit's RN coverage is active for the target hour, or a non-expired break-glass override is
    // in force. The route resolves ipu_rn_coverage_window + any override onto `target.rnCoverageActive`; the
    // ipu-admission / restraint / IV-overlay / equipment-assign machines re-assert IPU_RN_COVERAGE_UNAVAILABLE.
    "m37.ipu.rn_coverage_active": (_c, t) => targetBool(t, "rnCoverageActive"),
    // §2.5 — the admission's IRC episode is not breached (no episode, or active/approaching, or override).
    "m37.irc_episode.within_cap": (_c, t) => targetBool(t, "ircWithinCap"),
    // §2.9 — the equipment's biomed inspection is current (next_due >= today AND last outcome pass/conditional).
    "m37.equipment.inspection_current": (_c, t) => targetBool(t, "equipmentInspectionCurrent"),
    // §2.4 — the actor is an eligible GIP attester (M2 discipline hospice_md AND M40 ExternalPhysician active).
    "m37.gip_criteria.attester_eligible": (_c, t) => targetBool(t, "attesterEligible"),
    // §4.7 — the actor is an active IPU staff member on the unit (or a unit/medical director, org-wide).
    "m37.ipu.staff_member": (_c, t) => targetBool(t, "ipuStaffMember"),
  };
}

/**
 * Register M37's five §4.7 ABAC predicate resolvers into M3's shared registry (idempotent). Called at boot;
 * the predicates are pure (no db handle). Re-boot (tests) skips already-registered names (single-owner /
 * no-clear; the M27/M30/M35 precedent). Never fails open.
 */
export function registerM37AbacPredicates(): void {
  const predicates = buildM37AbacPredicates();
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
