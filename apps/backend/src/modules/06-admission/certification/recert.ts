// apps/backend/src/modules/06-admission/certification/recert.ts — M6-T08 the recertification CTI sign
// outcome (§7.3 W-CTI-01..04). PURE: given the period sequence and which signatures are now on file,
// decide the CTI's next state, whether the benefit period advances to `active`, and which outbox events
// fire. The §2.3.3 `transitionCertification` machine owns the per-event guards; this rule owns the
// CROSS-entity consequence the machine deliberately leaves out — a signed RECERT (period ≥ 2) advances
// its election period at its start date (W-CTI-03), whereas a signed period-1 CTI does NOT (period 1
// activates through the R-AC-01 admission gate, not the CTI sign).
//
// W-CTI-04 (period-1 dual sign): the hospice-MD and attending signatures are validated as separate
// practitioner identities, so a practitioner who is BOTH signs twice with distinct timestamps and no
// anti-self-cosign rule applies — that is a property of the two signature facts, captured here as the
// `bothSignaturesPresent` gate on reaching `signed`.

/** Whether the period-1 attending co-signature is still outstanding after a hospice-MD sign. */
export type CtiSignProgress = "awaiting_attending" | "signed";

/** Facts the recert decision reads (all resolved org-scoped; never client input). */
export interface RecertSignFacts {
  /** Benefit-period sequence the CTI certifies; the attending co-sign + auto-advance branch on it. */
  readonly sequence: number;
  /** Does the patient have an attending physician on file? (period-1 attending co-sign, R-CTI-03). */
  readonly patientHasAttending: boolean;
  /** Has the hospice medical director's signature been recorded? */
  readonly hospiceMdSigned: boolean;
  /** Has the attending physician's signature been recorded? (only meaningful for period 1). */
  readonly attendingSigned: boolean;
}

/** The recert sign verdict the slice applies after a signature is recorded. */
export interface RecertSignOutcome {
  /** The CTI's resulting state once the recorded signatures are accounted for. */
  readonly progress: CtiSignProgress;
  /** The CTI is fully signed (`m6.cti.signed` fires on the transition INTO this state). */
  readonly fullySigned: boolean;
  /** A signed recert (period ≥ 2) advances its election period to `active` at its start date. */
  readonly activatesPeriod: boolean;
}

/**
 * R-CTI / W-CTI-03/04 — decide the outcome after a CTI signature is recorded. Period 1 with an
 * attending needs BOTH signatures to reach `signed`; any other period (recert) is `signed` on the
 * hospice-MD signature alone. Only a fully-signed period ≥ 2 advances its period (W-CTI-03).
 */
export function decideRecertSign(facts: RecertSignFacts): RecertSignOutcome {
  const needsAttending = facts.sequence === 1 && facts.patientHasAttending;
  const fullySigned = facts.hospiceMdSigned && (!needsAttending || facts.attendingSigned);
  if (!fullySigned) {
    return { progress: "awaiting_attending", fullySigned: false, activatesPeriod: false };
  }
  return { progress: "signed", fullySigned: true, activatesPeriod: facts.sequence >= 2 };
}
