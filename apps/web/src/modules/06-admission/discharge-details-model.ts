// apps/web/src/modules/06-admission — the model of the "Discharge details for billing" guided screen
// (discharge-details.tsx): the read shape of GET /api/v1/admissions/:id/discharge-details, which detail the
// screen records, client validation and the error-code → message map. Pure (no React).
import {
  type MissingDischargeDetail,
  PLACE_OF_DEATH_CHOICES,
  type PlaceOfDeathValue,
  RECEIVING_CARE_SETTING_CHOICES,
  type ReceivingCareSettingValue,
} from "../../shell/discharge-claim-codes";

export interface DischargeDetailsView {
  admissionId: string;
  patientId: string;
  admissionState: string;
  discharge: {
    dischargeEventId: string;
    reason: string;
    status: string;
    effectiveDate: string;
    placeOfDeath: PlaceOfDeathValue | null;
    placeOfDeathCorrectionReason: string | null;
    version: number;
  } | null;
  transferOut: {
    transferEventId: string;
    effectiveDate: string;
    receivingHospiceName: string | null;
    receivingCareSetting: ReceivingCareSettingValue | null;
    receivingCareSettingCorrectionReason: string | null;
    version: number;
  } | null;
  missing: MissingDischargeDetail | null;
}

/** The one detail this screen works on, with the record it lives on. */
export interface DetailTarget {
  detail: MissingDischargeDetail;
  /** The discharge_event / transfer_event id the POST addresses. */
  recordId: string;
  version: number;
  effectiveDate: string;
  current: string | null;
  /** Filling a never-recorded value (`false`) or correcting a recorded one (`true`). */
  correcting: boolean;
}

/**
 * Which detail the screen records: the missing one when there is one; otherwise the recorded value on the
 * stay-ending event (a correction). `null` when the admission has neither a completed death nor a transfer-out.
 */
export function detailTarget(view: DischargeDetailsView): DetailTarget | null {
  const d = view.discharge;
  const t = view.transferOut;
  if (d && d.reason === "death") {
    return {
      detail: "place_of_death",
      recordId: d.dischargeEventId,
      version: d.version,
      effectiveDate: d.effectiveDate,
      current: d.placeOfDeath,
      correcting: d.placeOfDeath !== null,
    };
  }
  if (!d && t) {
    return {
      detail: "receiving_care_setting",
      recordId: t.transferEventId,
      version: t.version,
      effectiveDate: t.effectiveDate,
      current: t.receivingCareSetting,
      correcting: t.receivingCareSetting !== null,
    };
  }
  return null;
}

export function choicesFor(detail: MissingDischargeDetail) {
  return detail === "place_of_death" ? PLACE_OF_DEATH_CHOICES : RECEIVING_CARE_SETTING_CHOICES;
}

export const CORRECTION_REASON_MIN = 20;

export interface DetailErrors {
  value?: string;
  reason?: string;
}

export function validateDetail(target: DetailTarget, value: string, reason: string): DetailErrors {
  const e: DetailErrors = {};
  if (!value) {
    e.value =
      target.detail === "place_of_death"
        ? "Choose where the patient died."
        : "Choose where the receiving hospice cares for the patient.";
  } else if (target.correcting && value === target.current) {
    e.value = "This is already the recorded value — choose a different one to correct it.";
  }
  if (target.correcting && reason.trim().length < CORRECTION_REASON_MIN) {
    e.reason = `Explain the correction in at least ${CORRECTION_REASON_MIN} characters.`;
  }
  return e;
}

export const DETAIL_MESSAGES: Record<string, string> = {
  DISCHARGE_DETAIL_CORRECTION_REASON_REQUIRED:
    "A value is already recorded. Explain the correction (at least 20 characters) to change it.",
  DISCHARGE_DETAIL_NOT_APPLICABLE:
    "This record cannot carry that detail. Reload the page to see the admission's current discharge.",
  VERSION_MISMATCH:
    "Someone changed this discharge record after you opened it. Reload the page and review it before saving.",
};

/** The 403 message names the permission the server checked, so the reader knows whom to ask. */
export function forbiddenMessage(detail: MissingDischargeDetail): string {
  return detail === "place_of_death"
    ? "Recording a place of death needs the permission to record deaths (discharge.death). Ask a clinician or administrator who has it."
    : "Recording a receiving care setting needs the permission to record transfers out (transfer.out). Ask a clinician or administrator who has it.";
}
