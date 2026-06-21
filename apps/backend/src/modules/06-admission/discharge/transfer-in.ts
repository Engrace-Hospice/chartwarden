// apps/backend/src/modules/06-admission/discharge/transfer-in.ts — M6-T09 the transfer-in inherited
// benefit-period sequencing (§7.6 W-DC-03 / D9). PURE: when a patient transfers in mid-period from
// another hospice, the receiving hospice does NOT restart the period counter (42 CFR 418.28). It
// inherits the carried sequence as the active period and opens the next-pending period. The prior
// hospice's CTI applies until the inherited period ends, so the receiving hospice does NOT need a CTI
// for it — but DOES for the next period it certifies.

/** The carried context the transfer-in route supplies (R-XFR-02 validates the source CCN upstream). */
export interface TransferInInput {
  /** The benefit-period sequence carried from the sending hospice (CMS-inherited; never restarts). */
  readonly priorBenefitPeriodSequence: number;
  /** The sending hospice's election start date — anchors the inherited active period's start. */
  readonly priorElectionStartDate: string;
}

/** A planned election period the receiving hospice creates on the new transferred-in admission. */
export interface TransferInPeriodPlan {
  readonly sequence: number;
  readonly state: "active" | "pending";
  /** Whether the receiving hospice must obtain a CTI for this period (D9). */
  readonly ctiRequired: boolean;
}

/** The two periods M6 creates on a transfer-in admission: the inherited active + the next pending. */
export interface TransferInPlan {
  readonly inherited: TransferInPeriodPlan;
  readonly next: TransferInPeriodPlan;
}

/**
 * W-DC-03 / D9 — plan the inherited + next benefit periods for a transfer-in. The inherited period
 * keeps the carried sequence and goes straight to `active` with NO CTI required from us (the prior
 * hospice's certification applies until it ends); the next period is `pending` and DOES require our
 * CTI. F2F requirements follow the inherited sequence (a 3rd-or-later period requires F2F regardless of
 * which hospice held it) — that gate lives in the certification window math, keyed off these sequences.
 */
export function planTransferIn(input: TransferInInput): TransferInPlan {
  const inheritedSequence = input.priorBenefitPeriodSequence;
  return {
    inherited: { sequence: inheritedSequence, state: "active", ctiRequired: false },
    next: { sequence: inheritedSequence + 1, state: "pending", ctiRequired: true },
  };
}
