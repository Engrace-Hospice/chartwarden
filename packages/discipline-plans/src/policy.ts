// @wardenx/discipline-plans — §1.1 / §2.3 / §7.6 pure-data policy constants (M15-T01 domain layout).
//
// The discipline-boundary matrix the RBAC/ABAC composition enforces, the CoP 418.78 volunteer out-of-scope
// list, and the 418.78(e) ratio thresholds — declared once here rather than re-derived in each service.
// PURE DATA — no IO, `@wardenx/types`-only.

import type {
  DisciplineAuthorRole,
  DisciplinePlanKind,
  DisciplineAssessmentKind,
  VolunteerGateKind,
  VolunteerRatioStatus,
} from "@wardenx/types";

/**
 * §1.1 / D1 — the plan-kind ↔ authoring-discipline matrix. An MSW cannot author the Aide POC, a chaplain
 * cannot author the MSW Plan, a CHHA cannot author the Volunteer Plan. Two documented exceptions live
 * OUTSIDE this table because they are role-based overrides, not discipline scope (§1.1 / §6):
 *   - the **IDG Coordinator** may author any kind, audited at `warn` (mirrors M7 §7.4);
 *   - the **Clinical Supervisor** may author the Aide POC when the assigned supervising RN is unavailable,
 *     with a documented reason ≥ `OVERRIDE_REASON_MIN_LENGTH`; the assigned RN re-signs on return.
 */
export const PLAN_KIND_AUTHOR_DISCIPLINES: {
  readonly [K in DisciplinePlanKind]: readonly DisciplineAuthorRole[];
} = {
  aide_poc: ["rn"],
  msw_plan: ["msw"],
  spiritual_plan: ["chaplain"],
  volunteer_plan: ["volunteer_coordinator"],
} as const;

/** §1.1 / D6 — which assessment kind each plan kind owns. */
export const ASSESSMENT_KIND_BY_PLAN_KIND: {
  readonly [K in DisciplinePlanKind]: DisciplineAssessmentKind;
} = {
  aide_poc: "aide_environmental",
  msw_plan: "msw_psychosocial",
  spiritual_plan: "chaplain_spiritual",
  volunteer_plan: "volunteer_relationship",
} as const;

/** §6 / §1.1 — the minimum length of a documented Clinical-Supervisor override reason. */
export const OVERRIDE_REASON_MIN_LENGTH = 40 as const;

/** §2.2.4 — the same floor applies to `aide_supervisory_visit.corrective_actions` when the aide's
 *  performance is recorded unsatisfactory (the CHECK constraint in M15-T02 encodes it). */
export const CORRECTIVE_ACTIONS_MIN_LENGTH = OVERRIDE_REASON_MIN_LENGTH;

/**
 * §1.1 — the CLOSED out-of-scope list every Volunteer Plan must acknowledge before its initial version may
 * be finalized. Closed by design: a volunteer coordinator cannot narrow it, and the acknowledgment is
 * stored on the plan's `data` payload so a surveyor sees a signed acknowledgment rather than agency lore.
 */
export const VOLUNTEER_OUT_OF_SCOPE = [
  "no_clinical_care",
  "no_medication_administration",
  "no_body_care",
  "no_off_premises_transport_without_separate_authorization",
  "no_clinical_document_signing",
] as const;

/** One entry of {@link VOLUNTEER_OUT_OF_SCOPE}. */
export type VolunteerOutOfScopeItem = (typeof VOLUNTEER_OUT_OF_SCOPE)[number];

/**
 * §2.3 / D7 — the gate kinds that must ALL be `satisfied` before a `volunteer_assignment` is insertable
 * and before M17's pre-schedule gate will select the volunteer. `vaccination_status` is excluded from the
 * blocking set because CoP 418.78 leaves it to agency policy; it is still tracked, alerted, and reported.
 * M15-F11: this evaluates fail-CLOSED — an unreachable gate store blocks the booking rather than allowing
 * a non-compliant volunteer through, and the bypass is an audited override.
 */
export const BLOCKING_VOLUNTEER_GATE_KINDS: readonly VolunteerGateKind[] = [
  "background_check",
  "tb_screening",
  "confidentiality_agreement",
  "initial_training",
  "annual_ce",
  "assignment_specific_training",
] as const;

/** §2.2.6 — how far ahead of `valid_until` the nightly watcher derives `expiring_soon`, and the day-out
 *  marks the 30/14/7/1 M36 alert ladder fires on. */
export const VOLUNTEER_GATE_EXPIRY_POLICY = {
  expiringSoonAtDaysOut: 30,
  alertAtDaysOut: [30, 14, 7, 1],
} as const;

/**
 * §1.1 / §7.6 / M15-F04 — the 42 CFR §418.78(e) volunteer ratio is **hours ÷ hours**: the numerator is
 * volunteer hours (direct-care `volunteer_visit` durations from M8 PLUS typed `volunteer_admin_hours`
 * entries), the denominator is the total patient-care HOURS of paid + contract staff supplied by M27/M23.
 * Dollars are NEVER the denominator — the cost-savings dollar figure is a separate ARCH-064 evidence
 * artifact owned by M27. Until the staffing-hours seam binds live the ratio surfaces as `unavailable`.
 */
export const VOLUNTEER_RATIO_POLICY = {
  /** The CoP floor. At or above → green. */
  floor: 0.05,
  /** Below this → red with escalation to DON + Compliance Officer; in between → yellow with a
   *  corrective-action prompt. */
  criticalBelow: 0.03,
} as const;

/**
 * §7.6 — the M33 dashboard badge for a computed ratio. A null ratio is the honest `unavailable` state
 * (the M27/M23 patient-care-hours denominator is not yet bound), never a silent 0 — a 0 would read as a
 * CoP breach the agency does not actually have.
 */
export function volunteerRatioStatus(ratio: number | null): VolunteerRatioStatus {
  if (ratio === null) return "unavailable";
  if (ratio >= VOLUNTEER_RATIO_POLICY.floor) return "green";
  if (ratio >= VOLUNTEER_RATIO_POLICY.criticalBelow) return "yellow";
  return "red";
}

/** §2.5 — every mutable M15 table carries `version bigint`; PATCH routes require `If-Match: <version>` and
 *  answer a mismatch with 412 + the current row state (M7 §7.7 / M9 D11 verbatim). */
export const OPTIMISTIC_CONCURRENCY_HEADER = "If-Match" as const;

/** §2.4 — the `payloadSchemaVersion` stamped on every M15 outbox envelope; a consumer refusing an unknown
 *  version dead-letters rather than guessing. */
export const M15_PAYLOAD_SCHEMA_VERSION = "2026-01-v1" as const;
