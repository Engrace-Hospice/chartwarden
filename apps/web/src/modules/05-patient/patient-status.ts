// apps/web/src/modules/05-patient — shared patient-lifecycle presentation helpers (R1, Lantern).
// The status → tone map and label live with the shared chart banner in shell/patient-context.

import { ageYears } from "@chartwarden/ui";

/** Whole years from a date-only date-of-birth; null on an unparseable/future/implausible date. */
export const ageFromDob = (dob: string): number | null => ageYears(dob);
