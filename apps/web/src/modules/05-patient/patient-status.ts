// apps/web/src/modules/05-patient — shared patient-lifecycle presentation helpers (R1, Lantern).
// The patient status enum (spec §"Statuses") maps to the §6.6 badge taxonomy tone so every M5
// surface (census, chart banner, global-search hits) renders the same StatusPill for a status.

import { ageYears } from "@wardenx/ui";

// The status → tone map and label now live with the shared chart banner in the shell.
export {
  PATIENT_STATUS_TONE as STATUS_TONE,
  patientStatusLabel as statusLabel,
} from "../../shell/patient-context";

/** Whole years from a date-only date-of-birth; null on an unparseable/future/implausible date. */
export const ageFromDob = (dob: string): number | null => ageYears(dob);
