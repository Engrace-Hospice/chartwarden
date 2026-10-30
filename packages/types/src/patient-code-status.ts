/** `patient_code_status.code_status` (M5, ADR-0104). "Not recorded" is NOT a value: it is no active row. */
export const PATIENT_CODE_STATUSES = [
  "full_code",
  "dnr",
  "dnr_dni",
  "comfort_measures_only",
] as const;
export type PatientCodeStatus = (typeof PATIENT_CODE_STATUSES)[number];
