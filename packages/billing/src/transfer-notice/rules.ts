// @wardenx/billing — the validation rules and derived codes of the Medicare hospice Change of Provider /
// Transfer Notice (TOB 8xC), its date correction and its 8xD void. PURE: no DB, no clock, no PHI.
//
// Every rule cites its source. CMS Pub. 100-04 (Medicare Claims Processing Manual) ch. 11, Rev. 12847
// (issued 2024-09-13, effective 2024-06-03): https://www.cms.gov/regulations-and-guidance/guidance/manuals/downloads/clm104c11.pdf
//   §20.1.3 Change of Provider/Transfer Notice — same-CCN block; once per benefit period; From = transferring
//            Through (continuity, the CR 12619 CWF edit, MLN MM12619); the hold until the other provider has
//            finalized its billing; TOB 81C/82C; From = effective date, no Through; the receiving hospice's own
//            admission date; condition codes not required on an original; correction = OC 56 + CC D0 together;
//            OC 27 only when the transfer date is also the first day of the next benefit period.
//   §20.1.4 Cancellation of an Election — TOB 81D/82D; on a transfer, From and Admission date = the transfer date.
import type { IsoDate } from "../contracts";

export type TransferNoticeAction = "original" | "correction" | "void";

/** UB-04 FL 4 digit 2 — 81 hospice (non-hospital based), 82 hospice (hospital based). */
export type HospiceFacilityTypeCode = "81" | "82";

/** The transferring hospice's final-claim patient status: 50 hospice-home, 51 hospice-medical facility. */
export type PriorHospicePatientStatus = "50" | "51";

/** Everything the rules read — the transfer-notice row's snapshot plus one cross-row count. */
export interface TransferNoticeFacts {
  readonly action: TransferNoticeAction;
  readonly facilityTypeCode: HospiceFacilityTypeCode;
  /** Statement From (the effective / corrected / voided transfer date). */
  readonly statementFromDate: IsoDate;
  /** Correction only — the original incorrect transfer date (OC 56). */
  readonly originalTransferDate: IsoDate | null;
  /** The receiving hospice's own admission date; null while M6 has not recorded it. */
  readonly admissionDate: IsoDate | null;
  readonly benefitPeriodSequence: number;
  readonly benefitPeriodStartDate: IsoDate | null;
  /** The filing provider entity's CCN. */
  readonly providerCcn: string;
  readonly priorHospiceCcn: string | null;
  /** The staff confirmation that the transferring hospice finalized its billing (§20.1.3 hold), or null. */
  readonly priorBilling: {
    readonly throughDate: IsoDate;
    readonly patientStatus: PriorHospicePatientStatus;
  } | null;
  /** OTHER live originals for the same patient + benefit period (not this notice's own chain). */
  readonly otherTransfersInBenefitPeriod: number;
  /** Correction / void only — whether the notice it acts on is ACK_ACCEPTED at Medicare. */
  readonly supersededAccepted: boolean | null;
}

export type TransferNoticeBlockerCode =
  | "SAME_CCN"
  | "PRIOR_HOSPICE_CCN_REQUIRED"
  | "SECOND_TRANSFER_IN_BENEFIT_PERIOD"
  | "PRIOR_BILLING_NOT_CONFIRMED"
  | "CONTINUITY_GAP"
  | "ADMISSION_DATE_UNKNOWN"
  | "ADMISSION_AFTER_TRANSFER_DATE"
  | "TRANSFER_BEFORE_BENEFIT_PERIOD_START"
  | "CORRECTION_SAME_DATE"
  | "SUPERSEDED_NOT_ACCEPTED";

export type TransferNoticeWarningCode = "ADMISSION_BEFORE_TRANSFER_DATE";

export interface TransferNoticeFinding<C extends string> {
  readonly code: C;
  readonly message: string;
  /** The manual section the finding enforces. */
  readonly citation: string;
}

export interface TransferNoticeOccurrenceCode {
  readonly code: "27" | "56";
  readonly date: IsoDate;
}

export interface TransferNoticeEvaluation {
  readonly tob: string;
  readonly blockers: readonly TransferNoticeFinding<TransferNoticeBlockerCode>[];
  readonly warnings: readonly TransferNoticeFinding<TransferNoticeWarningCode>[];
  /** UB-04 FL 18-28 / 837I HI*BG. */
  readonly conditionCodes: readonly string[];
  /** UB-04 FL 31-34 / 837I HI*BH. */
  readonly occurrenceCodes: readonly TransferNoticeOccurrenceCode[];
}

const S2013 = "CMS Pub. 100-04 ch. 11 §20.1.3";
const S2014 = "CMS Pub. 100-04 ch. 11 §20.1.4";

/** TOB 8xC for an original or corrected transfer notice, 8xD for the void that removes one. */
export function transferNoticeTob(
  facilityTypeCode: HospiceFacilityTypeCode,
  action: TransferNoticeAction,
): string {
  return `${facilityTypeCode}${action === "void" ? "D" : "C"}`;
}

/**
 * The derived occurrence codes. OC 27 ("date of hospice certification or re-certification") only when the
 * transfer date is also the first day of the NEXT benefit period — i.e. the inherited period is not the first
 * (sequence ≥ 2) and starts on the transfer date. OC 56 carries the original incorrect date on a correction.
 * A void reports neither (§20.1.4 lists no occurrence codes).
 */
export function transferNoticeOccurrenceCodes(
  facts: Pick<
    TransferNoticeFacts,
    | "action"
    | "statementFromDate"
    | "originalTransferDate"
    | "benefitPeriodSequence"
    | "benefitPeriodStartDate"
  >,
): TransferNoticeOccurrenceCode[] {
  if (facts.action === "void") return [];
  const codes: TransferNoticeOccurrenceCode[] = [];
  if (
    facts.benefitPeriodSequence >= 2 &&
    facts.benefitPeriodStartDate !== null &&
    facts.benefitPeriodStartDate === facts.statementFromDate
  ) {
    codes.push({ code: "27", date: facts.statementFromDate });
  }
  if (facts.action === "correction" && facts.originalTransferDate !== null) {
    codes.push({ code: "56", date: facts.originalTransferDate });
  }
  return codes;
}

/** Condition codes: none on an original (§20.1.3), D0 with OC 56 on a correction, none on a void. */
export function transferNoticeConditionCodes(
  facts: Pick<TransferNoticeFacts, "action" | "originalTransferDate">,
): string[] {
  return facts.action === "correction" && facts.originalTransferDate !== null ? ["D0"] : [];
}

/**
 * §20.1.3: "If the hospice is correcting a date of transfer using occurrence code 56, the hospice reports
 * condition code D0. If the two codes are not reported together, the transfer notice will be returned."
 * Throws when a code set breaks the pair — the 837I builder calls this so a malformed notice never leaves.
 */
export function assertCorrectionPair(
  conditionCodes: readonly string[],
  occurrenceCodes: readonly { readonly code: string }[],
): void {
  const hasD0 = conditionCodes.includes("D0");
  const has56 = occurrenceCodes.some((o) => o.code === "56");
  if (hasD0 !== has56) {
    throw new Error(
      "transfer notice correction must report occurrence code 56 and condition code D0 together (§20.1.3)",
    );
  }
}

function blocker(
  code: TransferNoticeBlockerCode,
  message: string,
  citation = S2013,
): TransferNoticeFinding<TransferNoticeBlockerCode> {
  return { code, message, citation };
}

/** Run every rule; the notice may move to READY only when `blockers` is empty. */
export function evaluateTransferNotice(facts: TransferNoticeFacts): TransferNoticeEvaluation {
  const blockers: TransferNoticeFinding<TransferNoticeBlockerCode>[] = [];
  const warnings: TransferNoticeFinding<TransferNoticeWarningCode>[] = [];
  const isVoid = facts.action === "void";

  if (!isVoid) {
    if (facts.priorHospiceCcn === null) {
      blockers.push(
        blocker(
          "PRIOR_HOSPICE_CCN_REQUIRED",
          "Enter the transferring hospice's CCN. A transfer notice is not allowed when the CCN is the same as ours, so it must be known.",
        ),
      );
    } else if (facts.priorHospiceCcn === facts.providerCcn) {
      blockers.push(
        blocker(
          "SAME_CCN",
          "The transferring hospice has our CCN. A move between locations of the same hospice is not a transfer; do not file a transfer notice.",
        ),
      );
    }
  }

  if (facts.action === "original" && facts.otherTransfersInBenefitPeriod > 0) {
    blockers.push(
      blocker(
        "SECOND_TRANSFER_IN_BENEFIT_PERIOD",
        `This patient already changed hospices in benefit period ${facts.benefitPeriodSequence}. A beneficiary can change hospices only once per benefit period.`,
      ),
    );
  }

  if (facts.action === "original" && facts.priorBilling === null) {
    blockers.push(
      blocker(
        "PRIOR_BILLING_NOT_CONFIRMED",
        "Confirm that the transferring hospice has finalized its billing. The transfer notice is not submitted until then.",
      ),
    );
  }

  if (
    !isVoid &&
    facts.priorBilling !== null &&
    facts.priorBilling.throughDate !== facts.statementFromDate
  ) {
    blockers.push(
      blocker(
        "CONTINUITY_GAP",
        `The transferring hospice billed through ${facts.priorBilling.throughDate} but the transfer date is ${facts.statementFromDate}. They must be the same day, or Medicare rejects the transfer as a gap in care.`,
      ),
    );
  }

  if (!isVoid) {
    if (facts.admissionDate === null) {
      blockers.push(
        blocker(
          "ADMISSION_DATE_UNKNOWN",
          "Our admission date is not recorded yet. The transfer notice reports our own admission date.",
        ),
      );
    } else if (facts.admissionDate > facts.statementFromDate) {
      blockers.push(
        blocker(
          "ADMISSION_AFTER_TRANSFER_DATE",
          `Our admission date ${facts.admissionDate} is after the transfer date ${facts.statementFromDate}. Any gap after the transfer date is a discharge and re-election, not a transfer.`,
        ),
      );
    } else if (facts.admissionDate < facts.statementFromDate) {
      warnings.push({
        code: "ADMISSION_BEFORE_TRANSFER_DATE",
        message: `Our admission date ${facts.admissionDate} is before the transfer date ${facts.statementFromDate}. The transferring hospice is responsible through the transfer date.`,
        citation: S2013,
      });
    }
  }

  if (
    facts.benefitPeriodStartDate !== null &&
    facts.statementFromDate < facts.benefitPeriodStartDate
  ) {
    blockers.push(
      blocker(
        "TRANSFER_BEFORE_BENEFIT_PERIOD_START",
        `The transfer date ${facts.statementFromDate} is before the start of benefit period ${facts.benefitPeriodSequence} (${facts.benefitPeriodStartDate}).`,
      ),
    );
  }

  if (facts.action === "correction" && facts.originalTransferDate === facts.statementFromDate) {
    blockers.push(
      blocker(
        "CORRECTION_SAME_DATE",
        "The corrected transfer date is the same as the date already on file.",
      ),
    );
  }

  if (facts.action !== "original" && facts.supersededAccepted !== true) {
    blockers.push(
      blocker(
        "SUPERSEDED_NOT_ACCEPTED",
        "Only a transfer notice Medicare has accepted can be corrected or voided.",
        facts.action === "void" ? S2014 : S2013,
      ),
    );
  }

  const occurrenceCodes = transferNoticeOccurrenceCodes(facts);
  const conditionCodes = transferNoticeConditionCodes(facts);
  assertCorrectionPair(conditionCodes, occurrenceCodes);
  return {
    tob: transferNoticeTob(facts.facilityTypeCode, facts.action),
    blockers,
    warnings,
    conditionCodes,
    occurrenceCodes,
  };
}
