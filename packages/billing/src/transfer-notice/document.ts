// @chartwarden/billing — the PHI-free document M23 hands the X12 gateway for a transfer notice (8xC / 8xD), the
// sibling of `claim-codes/x12-segments.ts`'s `ClaimDocument837i`. It carries the billing FACTS only (TOB,
// statement date, admission date, codes, physician ids); the gateway resolves the beneficiary's name, address,
// birth date, sex and MBI from M5 at generation time (D13: the MBI never enters M23). The full 837I a gateway
// must produce from it is `build837iTransferNotice` in `@chartwarden/x12-837-client` (golden-tested).
//
// The fixed values follow the CMS 837I NOE Companion Guide v1.2 (April 2021), which governs every NOE-related
// TOB (8XA–8XE, CLM05-3 "A, B, C, D, E"): https://www.cms.gov/files/document/cms-837i-noe-companion-guide.pdf
//   CLM02 total charges 0 · CL102 admission source "1" · CL103 patient status "30" · a single SV2 line
//   (revenue 0650, HCPCS Q5009, description "NOE", charge 0, 1 unit).
import type { IsoDate } from "../contracts";
import {
  type HospiceFacilityTypeCode,
  type TransferNoticeAction,
  type TransferNoticeOccurrenceCode,
  assertCorrectionPair,
} from "./rules";

/** CMS 837I NOE Companion Guide defaults (Loop 2300 CL1 / Loop 2400 SV2). */
export const NOE_837I_DEFAULTS = {
  /** CL101 — required by 005010X223A2 but not addressed by the NOE companion guide; NUBC "9" = information
   *  not available. Recorded here so the gateway and the golden fixture agree. */
  admissionTypeCode: "9",
  admissionSourceCode: "1",
  patientStatusCode: "30",
  revenueCode: "0650",
  hcpcs: "Q5009",
  lineDescription: "NOE",
  units: 1,
} as const;

export interface TransferNoticeDocument837i {
  readonly transferNoticeId: string;
  readonly controlNumber: string;
  readonly action: TransferNoticeAction;
  /** "81C" | "82C" | "81D" | "82D". */
  readonly tob: string;
  readonly facilityTypeCode: HospiceFacilityTypeCode;
  /** CLM05-3 claim frequency: "C" (8xC) or "D" (8xD). */
  readonly frequencyCode: "C" | "D";
  /** Statement From; the 837I DTP*434 range repeats it as Through (§20.1.3: "No through date is required"). */
  readonly statementFromDate: IsoDate;
  /** DTP*435: the receiving hospice's own admission date (8xC); the transfer date on an 8xD (§20.1.4). */
  readonly admissionDate: IsoDate;
  readonly conditionCodes: readonly string[];
  readonly occurrenceCodes: readonly TransferNoticeOccurrenceCode[];
  /** Attending physician (Loop 2310A); the certifying physician when none is designated (§20.1.3). */
  readonly attendingPhysicianId: string;
  /** Other physician = the hospice certifying physician (Loop 2310F); null when the same as the attending. */
  readonly otherPhysicianId: string | null;
}

/**
 * Build the gateway document. Throws (fail-closed) when the codes break the 56/D0 pair or the facts the 837I
 * cannot do without are missing — the write service evaluates blockers first, so reaching here incomplete is
 * a bug, not a user error.
 */
export function buildTransferNoticeDocument(input: {
  readonly transferNoticeId: string;
  readonly controlNumber: string;
  readonly action: TransferNoticeAction;
  readonly tob: string;
  readonly statementFromDate: IsoDate;
  readonly admissionDate: IsoDate | null;
  readonly conditionCodes: readonly string[];
  readonly occurrenceCodes: readonly TransferNoticeOccurrenceCode[];
  readonly attendingPhysicianId: string | null;
  readonly certifyingPhysicianId: string | null;
}): TransferNoticeDocument837i {
  if (!/^8[12][CD]$/.test(input.tob)) throw new Error(`invalid transfer-notice TOB '${input.tob}'`);
  assertCorrectionPair(input.conditionCodes, input.occurrenceCodes);
  const frequencyCode = input.tob.endsWith("D") ? "D" : "C";
  if ((frequencyCode === "D") !== (input.action === "void")) {
    throw new Error(`TOB ${input.tob} does not match a ${input.action} transfer notice`);
  }
  // §20.1.4: on a transfer, the 8xD's admit date must match the transfer date.
  const admissionDate = input.action === "void" ? input.statementFromDate : input.admissionDate;
  if (admissionDate === null) throw new Error("transfer notice has no admission date");
  const attending = input.attendingPhysicianId ?? input.certifyingPhysicianId;
  if (attending === null) {
    throw new Error("transfer notice has neither an attending nor a certifying physician");
  }
  const other =
    input.certifyingPhysicianId !== null && input.certifyingPhysicianId !== attending
      ? input.certifyingPhysicianId
      : null;
  return {
    transferNoticeId: input.transferNoticeId,
    controlNumber: input.controlNumber,
    action: input.action,
    tob: input.tob,
    facilityTypeCode: input.tob.slice(0, 2) as HospiceFacilityTypeCode,
    frequencyCode,
    statementFromDate: input.statementFromDate,
    admissionDate,
    conditionCodes: [...input.conditionCodes],
    occurrenceCodes: input.occurrenceCodes.map((o) => ({ code: o.code, date: o.date })),
    attendingPhysicianId: attending,
    otherPhysicianId: other,
  };
}
