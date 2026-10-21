// @chartwarden/discipline-plans — §1.1 / D10 initial-assessment clock policy (M15-T01 domain layout).
//
// The per-plan-kind clocks the bootstrap worker starts and the daily MSW / chaplain overdue crons read.
// PURE DATA — no IO, `@chartwarden/types`-only.

import type { DisciplinePlanKind } from "@chartwarden/types";

/** What starts a kind's initial clock (§1.1 / D10). */
export type InitialClockAnchor =
  | "admission_activated"
  | "first_aide_scheduling"
  | "volunteer_assignment";

/** What stops it — the artifact whose signature (or declination) satisfies the clock. */
export type InitialClockSatisfier =
  | "signed_initial_assessment"
  | "signed_initial_version"
  | "signed_initial_assessment_or_declination"
  | "finalized_initial_version";

/** One kind's D10 initial clock. `warnAtDays` is null where the spec defines no pre-breach warning. */
export interface InitialAssessmentClock {
  readonly anchor: InitialClockAnchor;
  readonly dueWithinDays: number;
  /** True when `dueWithinDays` counts BUSINESS days rather than calendar days (§1.1: volunteer plan). */
  readonly businessDays: boolean;
  readonly warnAtDays: number | null;
  readonly satisfiedBy: InitialClockSatisfier;
  /** The regulatory citation the clock implements (surfaced on the operator's compliance worklist). */
  readonly citation: string;
}

/**
 * §1.1 / D10 — the per-kind initial-assessment clocks.
 *
 * - **MSW** — initial psychosocial assessment within 5 calendar days of `m6.admission.activated`
 *   (CoP 418.54(c) comprehensive assessment includes psychosocial); `warn` to the MSW at day 3, `critical`
 *   + Clin Supv + DON at day 5 (§7.2).
 * - **Chaplain** — initial spiritual assessment within 5 calendar days, UNLESS the patient/family declines
 *   spiritual care; the typed declination on the spiritual plan satisfies the clock (§7.3) and is
 *   trigger-enforced immutable so a later family request opens a new engagement rather than erasing it.
 * - **Aide POC** — the initial version must be SIGNED within 14 calendar days of first aide scheduling; the
 *   supervising RN authors (D11), and §418.76(g) additionally blocks any `chha_visit` before that signature
 *   (see `AIDE_POC_REQUIRED_BEFORE_CHHA_VISIT`).
 * - **Volunteer** — finalized within 5 BUSINESS days of the assignment that lazily created the plan.
 */
export const INITIAL_ASSESSMENT_CLOCKS: {
  readonly [K in DisciplinePlanKind]: InitialAssessmentClock;
} = {
  msw_plan: {
    anchor: "admission_activated",
    dueWithinDays: 5,
    businessDays: false,
    warnAtDays: 3,
    satisfiedBy: "signed_initial_assessment",
    citation: "42 CFR 418.54(c)",
  },
  spiritual_plan: {
    anchor: "admission_activated",
    dueWithinDays: 5,
    businessDays: false,
    warnAtDays: 3,
    satisfiedBy: "signed_initial_assessment_or_declination",
    citation: "42 CFR 418.64(d)",
  },
  aide_poc: {
    anchor: "first_aide_scheduling",
    dueWithinDays: 14,
    businessDays: false,
    warnAtDays: null,
    satisfiedBy: "signed_initial_version",
    citation: "42 CFR 418.76(g)",
  },
  volunteer_plan: {
    anchor: "volunteer_assignment",
    dueWithinDays: 5,
    businessDays: true,
    warnAtDays: null,
    satisfiedBy: "finalized_initial_version",
    citation: "42 CFR 418.78(a)",
  },
} as const;

/**
 * §1.1 / D10 — the three kinds bootstrapped in `draft` on `m6.admission.activated`. `volunteer_plan` is
 * created LAZILY on the first volunteer assignment: not every patient gets a volunteer, and an empty
 * volunteer plan on every admission is survey clutter.
 */
export const BOOTSTRAP_ON_ADMISSION_ACTIVATED: readonly DisciplinePlanKind[] = [
  "aide_poc",
  "msw_plan",
  "spiritual_plan",
] as const;

/** §1.1 / D10 — the kind created lazily rather than at admission. */
export const BOOTSTRAP_LAZILY_ON_ASSIGNMENT: readonly DisciplinePlanKind[] = [
  "volunteer_plan",
] as const;
