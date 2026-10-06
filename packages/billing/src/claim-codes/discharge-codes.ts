// @wardenx/billing — the discharge-driven claim codes on a Medicare hospice claim (TOB 81x): the patient
// discharge status (UB-04 FL 17 / 837I CL103), the condition codes (FL 18-28 / HI*BG) and the occurrence
// codes with their dates (FL 31-34 / HI*BH). PURE: no I/O, no clock, no PHI (codes + dates only).
//
// SOURCES (each code below cites the line it encodes):
//   [CH11]  CMS Pub. 100-04 Medicare Claims Processing Manual, Chapter 11 (Rev. 13190, 04-24-25), §30.3
//           "Data Required on the Institutional Claim to A/B MAC (HHH)" (Rev. 12847): "Patient Discharge
//           Status", "Condition Codes", "Occurrence Codes and Dates" and the "Discharge Reason / Coding
//           Required in Addition to Patient Status Code" table.
//   [CR7677] CMS Transmittal 2410 (CR 7677, 2012-02-03), "New Hospice Condition Code for Out of Service
//           Area Discharges" — the same §30.3 language plus the MAC return-to-provider edits 7677.3-7677.6.
//   [NUBC]  NUBC patient discharge status definitions as republished by the MACs: Noridian JF "Patient
//           Discharge Status Codes" and CGS "Claim Page 01 – Entering a Hospice Claim" (FL 17), plus ResDAC.
//
// NOT DERIVED HERE (stated, not silent):
//   * A LIVE discharge (revocation, no longer terminally ill, moved out of the service area, for cause)
//     takes "the NUBC approved discharge status code that best describes the beneficiary's situation"
//     [CH11]. WardenX records no live-discharge destination, so this module reports `01` (discharged to
//     home or self-care, the routine discharge [NUBC]). A patient discharged alive to a hospital or SNF
//     would need a different code (02/03/...) once M6 records the destination.
//   * `other` is not one of the 42 CFR 418.26 discharge reasons the manual codes, so it is UNRESOLVED and
//     the claim is blocked until the discharge is recorded under a real reason.
import type { IsoDate } from "../contracts";

/**
 * UB-04 FL 17 patient discharge status codes this module emits [NUBC]:
 *   01 discharged to home or self-care (routine discharge)
 *   30 still a patient
 *   40 expired at home (hospice claims only)
 *   41 expired in a medical facility (hospital, SNF, ICF or freestanding hospice)
 *   42 expired, place unknown (hospice claims only)
 *   50 discharged/transferred to hospice, home
 *   51 discharged/transferred to hospice, medical facility
 */
export const PATIENT_DISCHARGE_STATUS_CODES = ["01", "30", "40", "41", "42", "50", "51"] as const;
export type PatientDischargeStatusCode = (typeof PATIENT_DISCHARGE_STATUS_CODES)[number];

/**
 * Condition codes this module emits [CH11 "Condition Codes"]:
 *   52 Out of Hospice Service Area — discharged for moving out of the hospice's service area
 *   H2 Discharge by a Hospice Provider for Cause
 */
export const DISCHARGE_CONDITION_CODES = ["52", "H2"] as const;
export type DischargeConditionCode = (typeof DISCHARGE_CONDITION_CODES)[number];

/**
 * Occurrence codes this module emits [CH11 "Occurrence Codes and Dates"]:
 *   42 Date of Termination of Hospice Benefit — "can be used only when the beneficiary has revoked the
 *      benefit. It is not used in transfer situations."
 *   55 Beneficiary is Deceased — reported with "the appropriate NUBC discharge status code that best
 *      describes the place in which the beneficiary died (40, 41, or 42)".
 */
export const DISCHARGE_OCCURRENCE_CODES = ["42", "55"] as const;
export type DischargeOccurrenceCode = (typeof DISCHARGE_OCCURRENCE_CODES)[number];

export interface ClaimOccurrence {
  readonly code: DischargeOccurrenceCode;
  readonly date: IsoDate;
}

/** Where the patient died, as recorded on M6 `discharge_event.place_of_death`. */
export type PlaceOfDeath = "home" | "facility" | "unknown";
/** Where the RECEIVING hospice cares for the patient, as recorded on M6 `transfer_event.receiving_care_setting`. */
export type ReceivingCareSetting = "home" | "facility";

/**
 * How the stay ended, as M23 resolves it from M6: a completed `discharge_event` (its `discharge_type`), a
 * transfer-out (`transfer`) or a revocation (`revocation`). Any other string is treated as unknown.
 */
export type ClaimDischargeKind =
  | "death"
  | "revocation"
  | "transfer"
  | "moved_out_of_service_area"
  | "no_longer_terminal"
  | "for_cause"
  | "other";

export interface ClaimDischargeFact {
  readonly kind: string;
  /** The CMS-effective end of the stay (discharge, transfer, revocation or death date). */
  readonly effectiveDate: IsoDate;
  /** Death only: the date of death (falls back to `effectiveDate`). */
  readonly deathDate?: IsoDate | null;
  /** Death only. `null` = not recorded (historic rows) ⇒ unresolved. */
  readonly placeOfDeath?: PlaceOfDeath | null;
  /** Transfer only. `null` = not recorded (historic rows) ⇒ unresolved. */
  readonly receivingCareSetting?: ReceivingCareSetting | null;
  /** The M6 row the fact comes from (`discharge_event.id` / `transfer_event.id`); absent for a revocation. Lets a
   *  blocked claim point the biller at the exact record to complete. Never affects the derived codes. */
  readonly sourceEventId?: string | null;
}

export type DischargeCodesUnresolvedReason =
  | "place_of_death_missing"
  | "transfer_setting_missing"
  | "discharge_reason_not_codable";

export interface DischargeClaimCodes {
  /** `null` only when {@link DischargeClaimCodes.unresolved} is set. */
  readonly patientStatus: PatientDischargeStatusCode | null;
  readonly conditionCodes: readonly DischargeConditionCode[];
  readonly occurrenceCodes: readonly ClaimOccurrence[];
  /** Why the codes could not be derived; `null` when they were. The validation rule blocks on it. */
  readonly unresolved: DischargeCodesUnresolvedReason | null;
}

const STILL_A_PATIENT: DischargeClaimCodes = {
  // [CH11] "This code indicates the patient's status as of the 'Through' date of the billing period";
  // 30 = still a patient [NUBC].
  patientStatus: "30",
  conditionCodes: [],
  occurrenceCodes: [],
  unresolved: null,
};

const unresolved = (reason: DischargeCodesUnresolvedReason): DischargeClaimCodes => ({
  patientStatus: null,
  conditionCodes: [],
  occurrenceCodes: [],
  unresolved: reason,
});

/** The routine live-discharge status (see the header: no destination is recorded). [NUBC] 01. */
const LIVE_DISCHARGE_STATUS: PatientDischargeStatusCode = "01";

/**
 * Derive the discharge-driven codes for a claim whose service window ends on `serviceTo`. A discharge
 * dated after `serviceTo` (or none at all) means the patient is still a patient as of the Through date.
 */
export function deriveDischargeClaimCodes(input: {
  readonly serviceTo: IsoDate;
  readonly discharge: ClaimDischargeFact | null;
}): DischargeClaimCodes {
  const d = input.discharge;
  if (d === null || d.effectiveDate > input.serviceTo) return STILL_A_PATIENT;

  switch (d.kind as ClaimDischargeKind) {
    case "death": {
      // [CH11] "If the patient has died during the billing period, use codes 40, 41 or 42 as
      // appropriate"; occurrence code 55 carries the date of death.
      const status: PatientDischargeStatusCode | null =
        d.placeOfDeath === "home"
          ? "40"
          : d.placeOfDeath === "facility"
            ? "41"
            : d.placeOfDeath === "unknown"
              ? "42"
              : null;
      if (status === null) return unresolved("place_of_death_missing");
      return {
        patientStatus: status,
        conditionCodes: [],
        occurrenceCodes: [{ code: "55", date: d.deathDate ?? d.effectiveDate }],
        unresolved: null,
      };
    }
    case "transfer": {
      // [CH11] "Beneficiary Transfers Hospices — Patient Status Code 50 or 51; no other indicator", 50 or
      // 51 "depending on whether the beneficiary is transferring to home hospice or hospice in a medical
      // facility". No occurrence code 42 ("It is not used in transfer situations") and no condition code
      // 52, even when the transfer follows a move out of the service area.
      const status: PatientDischargeStatusCode | null =
        d.receivingCareSetting === "home"
          ? "50"
          : d.receivingCareSetting === "facility"
            ? "51"
            : null;
      if (status === null) return unresolved("transfer_setting_missing");
      return { patientStatus: status, conditionCodes: [], occurrenceCodes: [], unresolved: null };
    }
    case "revocation":
      // [CH11] "Beneficiary Revokes — Occurrence code 42", "indicating the date the beneficiary revoked
      // the benefit".
      return {
        patientStatus: LIVE_DISCHARGE_STATUS,
        conditionCodes: [],
        occurrenceCodes: [{ code: "42", date: d.effectiveDate }],
        unresolved: null,
      };
    case "moved_out_of_service_area":
      // [CH11] "Beneficiary Moves Out of Service Area — Condition Code 52"; "does not report occurrence
      // code 42".
      return {
        patientStatus: LIVE_DISCHARGE_STATUS,
        conditionCodes: ["52"],
        occurrenceCodes: [],
        unresolved: null,
      };
    case "no_longer_terminal":
      // [CH11] "Beneficiary No Longer Terminally Ill — No other indicator".
      return {
        patientStatus: LIVE_DISCHARGE_STATUS,
        conditionCodes: [],
        occurrenceCodes: [],
        unresolved: null,
      };
    case "for_cause":
      // [CH11] "Beneficiary Discharged for Cause — Condition code H2"; "does not report occurrence code 42".
      return {
        patientStatus: LIVE_DISCHARGE_STATUS,
        conditionCodes: ["H2"],
        occurrenceCodes: [],
        unresolved: null,
      };
    default:
      return unresolved("discharge_reason_not_codable");
  }
}

/**
 * The MAC return-to-provider edits from [CR7677] 7677.2-7677.6 plus the §30.3 table, checked over a code
 * set. Returns one message per violated edit (empty = consistent). Used by the validation rule as a
 * belt-and-braces check on whatever the claim carries.
 */
export function dischargeCodeConflicts(codes: DischargeClaimCodes): string[] {
  const out: string[] = [];
  const cc = new Set(codes.conditionCodes);
  const oc = new Set(codes.occurrenceCodes.map((o) => o.code));
  // 7677.2 — condition codes 52 and H2 together.
  if (cc.has("52") && cc.has("H2")) out.push("condition codes 52 and H2 cannot both be reported");
  // 7677.3 / 7677.4 — 52 or H2 with patient status 30.
  if (codes.patientStatus === "30" && (cc.has("52") || cc.has("H2"))) {
    out.push("condition code 52/H2 cannot be reported with patient status 30");
  }
  // 7677.5 / 7677.6 — H2 or 52 with occurrence code 42.
  if (oc.has("42") && (cc.has("52") || cc.has("H2"))) {
    out.push("condition code 52/H2 cannot be reported with occurrence code 42");
  }
  // §30.3 — occurrence code 42 "is not used in transfer situations".
  if (oc.has("42") && (codes.patientStatus === "50" || codes.patientStatus === "51")) {
    out.push("occurrence code 42 cannot be reported on a transfer (patient status 50/51)");
  }
  // §30.3 — occurrence code 55 goes with 40/41/42, and a 40/41/42 status needs the date of death.
  const expired =
    codes.patientStatus === "40" || codes.patientStatus === "41" || codes.patientStatus === "42";
  if (oc.has("55") && !expired) out.push("occurrence code 55 requires patient status 40, 41 or 42");
  if (expired && !oc.has("55")) out.push("patient status 40/41/42 requires occurrence code 55");
  return out;
}
