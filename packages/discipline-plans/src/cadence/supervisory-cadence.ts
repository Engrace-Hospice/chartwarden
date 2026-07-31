// @wardenx/discipline-plans — §2.2.4 / §7.1 / D3 supervisory-cadence policy (M15-T01 domain layout).
//
// The single source of the 42 CFR §418.76(h) RN supervisory rules the cadence service (M15-T03), the
// 6-hourly overdue cron, the encounter-sign gate, and the M36 alert builders read instead of re-deriving
// inline. PURE DATA — no IO, `@wardenx/types`-only.

import type { AideSupervisoryAttestationMode } from "@wardenx/types";

/**
 * §2.2.4 / D3 — the typed `SUPERVISORY_CADENCE` catalog. `platformFloorDays` is the 42 CFR §418.76(h)(1)
 * hard regulatory ceiling on the interval between RN supervisory contacts; a tenant override may only
 * TIGHTEN (`tenantMayTightenToDays` ≤ override ≤ `platformFloorDays`) and `cadence_days_override > 14` is
 * refused as a policy violation (the `discipline_care_plan.supervisory_cadence_days_override` CHECK in
 * M15-T02 encodes the same bound). Loosening is not configurable at any tier — a product that let an
 * operator weaken the CoP floor would be a survey-risk product (D3).
 */
export const SUPERVISORY_CADENCE = {
  /** 42 CFR §418.76(h)(1): "no less frequently than every 14 days". */
  platformFloorDays: 14,
  /** The tightest cadence a tenant may configure (e.g. a high-acuity location running weekly). */
  tenantMayTightenToDays: 1,
} as const;

/**
 * §7.1 — the escalation ladder measured in days since the last supervisory contact. `warnAtDays` fires the
 * `warn` M36 alert to the supervising RN; `overdueAtDays` is the CoP floor itself (alert escalates, the plan
 * banner turns red); `encounterSignGateAtDays` is the 2-day-grace point past which a new `chha_visit`
 * encounter cannot be signed (`AIDE_SUPERVISORY_OVERDUE`) without a documented Clinical-Supervisor override.
 *
 * These are offsets from the cadence window, not absolutes: with a tenant override of 7 days the ladder
 * shifts to 5 / 7 / 9. `daysFor()` resolves them against the effective cadence.
 */
export const SUPERVISORY_ESCALATION_OFFSET_DAYS = {
  /** 2 days before the cadence expires (day 12 at the 14-day default). */
  warn: -2,
  /** The cadence expiry itself (day 14 at the default). */
  overdue: 0,
  /** The 2-day grace past expiry (day 16 at the default). */
  encounterSignGate: 2,
} as const;

/** The resolved ladder for one plan's effective cadence. */
export interface SupervisoryEscalationDays {
  readonly warnAtDays: number;
  readonly overdueAtDays: number;
  readonly encounterSignGateAtDays: number;
}

/**
 * Resolve the §7.1 escalation ladder for an effective cadence. `cadenceDays` is
 * `COALESCE(tenant_override, SUPERVISORY_CADENCE.platformFloorDays)` and must already satisfy
 * {@link isCadenceOverrideLegal} — this function does not re-validate, it only shifts the offsets.
 */
export function supervisoryEscalationDays(cadenceDays: number): SupervisoryEscalationDays {
  return {
    warnAtDays: cadenceDays + SUPERVISORY_ESCALATION_OFFSET_DAYS.warn,
    overdueAtDays: cadenceDays + SUPERVISORY_ESCALATION_OFFSET_DAYS.overdue,
    encounterSignGateAtDays: cadenceDays + SUPERVISORY_ESCALATION_OFFSET_DAYS.encounterSignGate,
  };
}

/**
 * §2.3 — a tenant cadence override is legal only when it TIGHTENS the CoP floor. Rejects `> 14` (weakening
 * the regulation), `< 1`, and non-integers.
 */
export function isCadenceOverrideLegal(overrideDays: number): boolean {
  return (
    Number.isInteger(overrideDays) &&
    overrideDays >= SUPERVISORY_CADENCE.tenantMayTightenToDays &&
    overrideDays <= SUPERVISORY_CADENCE.platformFloorDays
  );
}

/**
 * §2.2.4 — which attestation modes ADVANCE the 14-day clock. Both 42 CFR §418.76(h)(2) modes do; a
 * documented phone-only supervision (an `aide_supervisory_visit` with a null `source_encounter_id`) does
 * NOT, and is tracked separately for survey discoverability.
 */
export const CLOCK_ADVANCING_ATTESTATION_MODES: readonly AideSupervisoryAttestationMode[] = [
  "aide_present",
  "observation_of_work",
] as const;

/**
 * M15-F03 (§418.76(h)) — the aide-present observation clock. Independent of the 14-day per-plan cadence:
 * every aide must be observed IN PERSON WITH THE AIDE PRESENT at least once per `observationIntervalDays`
 * per (aide × org), regardless of how many `observation_of_work` supervisions were recorded in between.
 *
 * `maxConsecutivePhoneOnlySupervisions` caps the F03 "consecutive phone-only supervisions" rule. The
 * remediation caps it without naming a number; 1 is the conservative platform floor (back-to-back
 * phone-only contacts would mean no in-person supervision at all across a full cadence window). Tenants
 * may tighten to 0; loosening is not configurable.
 */
export const AIDE_OBSERVATION_POLICY = {
  observationIntervalDays: 365,
  /** Advance warning before the annual aide-present observation lapses. */
  observationWarnAtDaysOut: 30,
  maxConsecutivePhoneOnlySupervisions: 1,
} as const;

/**
 * M15-F03 (§418.76(g)) — plan-before-care. A `chha_visit` encounter may not be created or signed unless the
 * patient's Aide POC is `active` with a signed current version. The documented same-day path lets the
 * supervising RN author + sign the instructions immediately before the first aide visit; it does not waive
 * the gate, it satisfies it.
 */
export const AIDE_POC_REQUIRED_BEFORE_CHHA_VISIT = true as const;
