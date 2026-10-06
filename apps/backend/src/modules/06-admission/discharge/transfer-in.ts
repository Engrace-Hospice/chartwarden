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
  /**
   * The RECEIVING hospice's medical director — required to draft the CTI for the `next` pending
   * period (D9: unlike the inherited period, the next period DOES require our CTI). `planTransferIn`
   * itself never reads this (pure period-sequencing math); the service layer uses it to draft that CTI.
   */
  readonly hospiceMedicalDirectorId: string;
  readonly attendingPhysicianId?: string;
  /** The date the transfer took effect — anchors `transfer_event.effective_at` (not `now()`). */
  readonly effectiveDate: string;
  /** The sending hospice's name — `transfer_event.receiving_or_sending_name`. */
  readonly otherHospiceName: string;
  /** The sending hospice's CMS CCN, when known — `transfer_event.receiving_or_sending_ccn`. */
  readonly otherHospiceCcn?: string;
  /** The sending hospice's NPI, when known — `transfer_event.receiving_or_sending_npi` (migration 0375). */
  readonly otherHospiceNpi?: string;
  /** Free-text transfer narrative — `transfer_event.narrative`. */
  readonly narrative: string;
}

/** Luhn mod 10 over "80840" + the first nine digits — the NPI check digit (45 CFR 162.406). */
export function isNpiCheckDigitValid(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits.charAt(digits.length - 1 - i));
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi.charAt(9));
}

/** Why a transfer-in's sending-hospice facts are refused (the `M6ErrorCode` the service raises). */
export type TransferInSourceRefusal =
  | "TRANSFER_SAME_PROVIDER"
  | "TRANSFER_LIMIT_EXCEEDED"
  | "TRANSFER_IN_SOURCE_INVALID";

/**
 * The receiving hospice's transfer-in source checks, CMS Pub. 100-04 ch. 11 §20.1.3 (Rev. 12847):
 *   • "Transfers are not allowed from the same provider. Hospices must not submit an 8XC if the CMS
 *     Certification Number (CCN) is the same" — a move between locations of one hospice is not a transfer;
 *   • "A beneficiary can change hospices only once per benefit period" — any transfer (in or out) already
 *     recorded for this patient in the carried benefit period refuses a second one (42 CFR 418.30);
 *   • a supplied NPI must pass its check digit.
 * PURE: the caller resolves our CCN and the prior-transfer fact. Returns null when the source is acceptable.
 */
export function transferInSourceRefusal(input: {
  readonly otherHospiceCcn: string | null;
  readonly otherHospiceNpi: string | null;
  readonly ownCcn: string | null;
  readonly transferAlreadyRecordedInPeriod: boolean;
}): { readonly code: TransferInSourceRefusal; readonly message: string } | null {
  if (
    input.otherHospiceCcn !== null &&
    input.ownCcn !== null &&
    input.otherHospiceCcn === input.ownCcn
  ) {
    return {
      code: "TRANSFER_SAME_PROVIDER",
      message:
        "The sending hospice has our CCN. A move between locations of the same hospice is not a transfer.",
    };
  }
  if (input.otherHospiceNpi !== null && !isNpiCheckDigitValid(input.otherHospiceNpi)) {
    return {
      code: "TRANSFER_IN_SOURCE_INVALID",
      message: "The sending hospice's NPI fails its check digit.",
    };
  }
  if (input.transferAlreadyRecordedInPeriod) {
    return {
      code: "TRANSFER_LIMIT_EXCEEDED",
      message:
        "This patient already changed hospices in this benefit period; only one change is allowed.",
    };
  }
  return null;
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
