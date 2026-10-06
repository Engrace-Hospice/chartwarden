// apps/backend/src/modules/06-admission/discharge/discharge-details.ts — the claim-relevant discharge details
// that can be recorded AFTER the fact: the place of death on a completed death discharge and the receiving care
// setting on a transfer-out. Both drive the Medicare claim's patient discharge status (CMS Pub. 100-04 Ch. 11
// §30.3): place of death → 40 (home) / 41 (medical facility) / 42 (place unknown); receiving care setting → 50
// (hospice, home) / 51 (hospice, medical facility). Rows written before migration 0370 have neither, so M23's
// `bereavement_discharge_legitimacy` rule blocks their final claim until someone records the value.
//
// PURE: the decision of what a request may do, the plain-language error messages, and the claim-code hints the
// API errors and the web screens share. The Drizzle service applies the verdict; the route maps it to HTTP.
import type { PlaceOfDeath } from "./permission-map";

/** Where the RECEIVING hospice cares for the patient (`transfer_event.receiving_care_setting`). */
export const RECEIVING_CARE_SETTINGS = ["home", "facility"] as const;
export type ReceivingCareSetting = (typeof RECEIVING_CARE_SETTINGS)[number];

/** Which after-the-fact detail a request records. */
export type DischargeDetailKind = "place_of_death" | "receiving_care_setting";

/** A replaced (not first-time) value needs a reason of at least this many characters (migration 0372 CHECK). */
export const DETAIL_CORRECTION_REASON_MIN = 20;
export const DETAIL_CORRECTION_REASON_MAX = 2000;

/** The claim patient status each place of death sets (UB-04 FL 17 / 837I CL103). */
export const PLACE_OF_DEATH_STATUS: Record<PlaceOfDeath, string> = {
  home: "40",
  facility: "41",
  unknown: "42",
};

/** The claim patient status each receiving care setting sets. */
export const RECEIVING_CARE_SETTING_STATUS: Record<ReceivingCareSetting, string> = {
  home: "50",
  facility: "51",
};

/**
 * The plain-language API message for a death discharge without a place of death (422 PLACE_OF_DEATH_REQUIRED).
 * Names the field, the allowed values and the claim effect so an integrator can fix the call from the error.
 */
export const PLACE_OF_DEATH_REQUIRED_MESSAGE =
  'placeOfDeath is required when reason is "death". Send "home", "facility" or "unknown": it sets the ' +
  "Medicare claim's patient discharge status (40 expired at home, 41 expired in a medical facility, 42 " +
  "expired, place unknown — CMS Pub. 100-04 Ch. 11 §30.3). Without it the final claim cannot be billed. " +
  '"unknown" is a valid answer when the place of death is not known.';

/** 422 PLACE_OF_DEATH_NOT_ALLOWED — the field was sent on a non-death discharge. */
export const PLACE_OF_DEATH_NOT_ALLOWED_MESSAGE =
  'placeOfDeath is only accepted when reason is "death" (it sets claim patient status 40/41/42). Remove ' +
  "the field for any other discharge reason.";

/** 422 RECEIVING_CARE_SETTING_REQUIRED — a transfer-out without where the receiving hospice cares for the patient. */
export const RECEIVING_CARE_SETTING_REQUIRED_MESSAGE =
  'receivingCareSetting is required on a transfer-out. Send "home" or "facility" — where the RECEIVING ' +
  "hospice will care for the patient: it sets the Medicare claim's patient discharge status (50 discharged " +
  "to hospice, home; 51 discharged to hospice, medical facility — CMS Pub. 100-04 Ch. 11 §30.3). Without it " +
  "the final claim cannot be billed.";

/** The current state of the detail and what the request asks for. */
export interface DetailUpdateInput<V extends string> {
  readonly current: V | null;
  readonly requested: V;
  readonly correctionReason: string | undefined;
}

/**
 * What a record-detail request may do:
 *   - `set`     — the value was never recorded (NULL); fill it in. A correction reason is not needed (and is
 *                 not stored — there is nothing being corrected).
 *   - `correct` — a DIFFERENT value is already recorded; allowed only with a correction reason of at least
 *                 {@link DETAIL_CORRECTION_REASON_MIN} characters, which is persisted beside the value.
 *   - `noop`    — the same value is already recorded; nothing changes (idempotent retry).
 *   - `reason_required` — a different value is recorded and no (or too short a) reason was given (409).
 */
export type DetailUpdateVerdict =
  | { readonly kind: "set" }
  | { readonly kind: "correct"; readonly reason: string }
  | { readonly kind: "noop" }
  | { readonly kind: "reason_required" };

export function decideDetailUpdate<V extends string>(
  input: DetailUpdateInput<V>,
): DetailUpdateVerdict {
  if (input.current === null) return { kind: "set" };
  if (input.current === input.requested) return { kind: "noop" };
  const reason = (input.correctionReason ?? "").trim();
  if (reason.length < DETAIL_CORRECTION_REASON_MIN) return { kind: "reason_required" };
  return { kind: "correct", reason };
}

/** The 409 message when a recorded value would be replaced without a reason. */
export function correctionReasonRequiredMessage(
  kind: DischargeDetailKind,
  current: string,
): string {
  const field = kind === "place_of_death" ? "place of death" : "receiving care setting";
  return (
    `the ${field} is already recorded as "${current}". To change it, send correctionReason (at least ` +
    `${DETAIL_CORRECTION_REASON_MIN} characters) explaining the correction; it is kept with the change.`
  );
}

/**
 * The detail an admission's stay-ending event is missing, or `null` when nothing is missing: a completed death
 * discharge with no place of death, or a transfer-out with no receiving care setting.
 */
export function missingDischargeDetail(facts: {
  readonly discharge: { readonly reason: string; readonly placeOfDeath: string | null } | null;
  readonly transferOut: { readonly receivingCareSetting: string | null } | null;
}): DischargeDetailKind | null {
  if (facts.discharge?.reason === "death" && facts.discharge.placeOfDeath === null) {
    return "place_of_death";
  }
  if (
    facts.discharge === null &&
    facts.transferOut &&
    facts.transferOut.receivingCareSetting === null
  ) {
    return "receiving_care_setting";
  }
  return null;
}

/** A request-body problem with one of the two claim-relevant fields, raised BEFORE schema validation so the caller
 *  gets the field-specific code and message instead of a generic schema error. */
export interface DischargeDetailBodyIssue {
  readonly code: "RECEIVING_CARE_SETTING_REQUIRED" | "PLACE_OF_DEATH_REQUIRED";
  readonly message: string;
  readonly field: "receivingCareSetting" | "placeOfDeath";
}

const PLACES: readonly string[] = ["home", "facility", "unknown"];

/** Route 37 (transfer-out): `receivingCareSetting` must be present and one of home / facility. */
export function checkTransferOutCareSettingBody(body: unknown): DischargeDetailBodyIssue | null {
  const value = (body as { receivingCareSetting?: unknown } | null | undefined)
    ?.receivingCareSetting;
  if (typeof value === "string" && (RECEIVING_CARE_SETTINGS as readonly string[]).includes(value)) {
    return null;
  }
  return {
    code: "RECEIVING_CARE_SETTING_REQUIRED",
    message: RECEIVING_CARE_SETTING_REQUIRED_MESSAGE,
    field: "receivingCareSetting",
  };
}

/**
 * Route 39 (discharge): a `placeOfDeath` that is present but not one of home / facility / unknown on a death
 * discharge gets the same field-specific error as a missing one (the service refuses the missing case).
 */
export function checkPlaceOfDeathBody(body: unknown): DischargeDetailBodyIssue | null {
  const b = body as { reason?: unknown; placeOfDeath?: unknown } | null | undefined;
  if (b?.reason !== "death" || b.placeOfDeath === undefined) return null;
  if (typeof b.placeOfDeath === "string" && PLACES.includes(b.placeOfDeath)) return null;
  return {
    code: "PLACE_OF_DEATH_REQUIRED",
    message: PLACE_OF_DEATH_REQUIRED_MESSAGE,
    field: "placeOfDeath",
  };
}
