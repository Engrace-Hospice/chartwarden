// apps/web/src/modules/05-patient — shared patient-lifecycle presentation helpers (R1, Lantern).
// The patient status enum (spec §"Statuses") maps to the §6.6 badge taxonomy tone so every M5
// surface (census, chart banner, global-search hits) renders the same StatusPill for a status.

// The status → tone map and label now live with the shared chart banner in the shell.
export {
  PATIENT_STATUS_TONE as STATUS_TONE,
  patientStatusLabel as statusLabel,
} from "../../shell/patient-context";

/** Whole years from an ISO date-of-birth; null on an unparseable/future date. */
export function ageFromDob(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 ? age : null;
}
