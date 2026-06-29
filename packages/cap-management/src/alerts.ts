// @wardenx/cap-management — the eleven typed M36 alert payloads (§4.9). M26 routes cap alerts through M36's
// generic AlertEmitter (M36-F03: NO cap_watch channel kind); each payload kind is registered with M36's alert
// type registry at boot (P4) and M36 validates dispatched alerts against the TypeBox schema. patientDisplayName
// is M5-redacted per recipient permission (M36 resolves it at dispatch), never carried as raw PHI here.
import { Type } from "@sinclair/typebox";

const id = Type.String({ format: "uuid" });
const BaseCapAlert = {
  capPeriodId: id,
  capYear: Type.String({ pattern: "^FY\\d{4}$" }),
  computedAt: Type.String({ format: "date-time" }),
  dashboardUrl: Type.String({ minLength: 1 }),
};

export const PatientWatch90Payload = Type.Object({
  ...BaseCapAlert,
  patientId: id,
  patientDisplayName: Type.String(),
  utilizationPct: Type.Number(),
  paidToDate: Type.String(),
  allocatedCap: Type.String(),
});
export const PatientWarn95Payload = PatientWatch90Payload;
export const PatientBreach100Payload = PatientWatch90Payload;

export const AgencyWatch90Payload = Type.Object({
  ...BaseCapAlert,
  utilizationPct: Type.Number(),
  paidToDate: Type.String(),
  totalAllocatedCap: Type.String(),
  topContributingPatientsCount: Type.Integer(),
});
export const AgencyWarn95Payload = AgencyWatch90Payload;
export const AgencyBreach100Payload = AgencyWatch90Payload;

export const InpatientWatch18Payload = Type.Object({
  ...BaseCapAlert,
  inpatientDays: Type.Integer(),
  totalDays: Type.Integer(),
  utilizationPct: Type.Number(),
});
export const InpatientWarn20Payload = InpatientWatch18Payload;
export const InpatientBreachPayload = InpatientWatch18Payload;

export const YearCloseReminderPayload = Type.Object({
  ...BaseCapAlert,
  daysUntilGraceWindowExpires: Type.Integer(),
  outstandingSettlementRequired: Type.Boolean(),
});

export const PsrVarianceDetectedPayload = Type.Object({
  ...BaseCapAlert,
  importId: id,
  varianceLineCount: Type.Integer(),
  totalVarianceAmount: Type.String(),
});

/** The eleven alert kinds M26 publishes, mapped to their payload schema (registered with M36 at boot). */
export const M26_ALERT_PAYLOADS = {
  "m26.cap.patient_watch_90": PatientWatch90Payload,
  "m26.cap.patient_warn_95": PatientWarn95Payload,
  "m26.cap.patient_breach_100": PatientBreach100Payload,
  "m26.cap.agency_watch_90": AgencyWatch90Payload,
  "m26.cap.agency_warn_95": AgencyWarn95Payload,
  "m26.cap.agency_breach_100": AgencyBreach100Payload,
  "m26.cap.inpatient_watch_18": InpatientWatch18Payload,
  "m26.cap.inpatient_warn_20": InpatientWarn20Payload,
  "m26.cap.inpatient_breach": InpatientBreachPayload,
  "m26.cap.year_close_reminder": YearCloseReminderPayload,
  "m26.cap.psr_variance_detected": PsrVarianceDetectedPayload,
} as const;

export type M26AlertKind = keyof typeof M26_ALERT_PAYLOADS;
export const M26_ALERT_KINDS = Object.keys(M26_ALERT_PAYLOADS) as M26AlertKind[];

/** The DB alert-band → the M36 alert kind for a scope, or null for the safe band (no alert). */
export function alertKindForBand(band: string): M26AlertKind | null {
  switch (band) {
    case "watch_90":
      return "m26.cap.agency_watch_90"; // patient vs agency disambiguated by the caller's scope
    case "warn_95":
      return "m26.cap.agency_warn_95";
    case "breach_100":
      return "m26.cap.agency_breach_100";
    case "inpatient_watch_18":
      return "m26.cap.inpatient_watch_18";
    case "inpatient_breach_20":
      return "m26.cap.inpatient_breach";
    default:
      return null;
  }
}
