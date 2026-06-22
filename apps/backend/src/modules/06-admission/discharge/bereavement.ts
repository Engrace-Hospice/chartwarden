// apps/backend/src/modules/06-admission/discharge/bereavement.ts — M6-T09 the M6-owned bereavement
// eligibility rule (§7.6 W-DC-01 / D6). PURE: M6 owns the *rule* that decides whether a death discharge
// makes the patient eligible for the 13-month bereavement program; M16 owns the enrollment program. The
// handshake is a single outbox event `m6.bereavement.eligible` — M6 never imports M16.
//
// The rule fires when (a) discharge reason is `death`, (b) the patient was in an active hospice
// election ≥ 1 day before death, and (c) the organization's bereavement opt-out flag for the patient
// (carried on M5 patient demographics) is NOT set.
import type { DischargeReason } from "./permission-map";

/** Facts the bereavement rule reads (all resolved org-scoped — election days from M6, opt-out from M5). */
export interface BereavementFacts {
  /** The discharge reason; only `death` can make the patient bereavement-eligible. */
  readonly reason: DischargeReason;
  /** Whole days the patient spent in an active hospice election before death (W-DC-01 (b): ≥ 1). */
  readonly daysOnActiveElectionBeforeDeath: number;
  /** The M5 per-patient bereavement opt-out flag (W-DC-01 (c): eligibility is suppressed when set). */
  readonly bereavementOptOut: boolean;
}

/** The verdict: whether `m6.bereavement.eligible` fires alongside the death discharge cascade. */
export interface BereavementEligibility {
  readonly eligible: boolean;
}

/**
 * W-DC-01 / D6 — decide bereavement eligibility for a death discharge. All three conditions must hold;
 * any non-death reason, an election shorter than one day, or a set opt-out flag suppresses the event.
 */
export function decideBereavementEligibility(facts: BereavementFacts): BereavementEligibility {
  return {
    eligible:
      facts.reason === "death" &&
      facts.daysOnActiveElectionBeforeDeath >= 1 &&
      !facts.bereavementOptOut,
  };
}
