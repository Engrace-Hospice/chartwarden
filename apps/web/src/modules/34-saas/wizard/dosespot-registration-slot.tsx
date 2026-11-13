// apps/web/src/modules/34-saas/wizard — the seam the DoseSpot branch fills (clinic registration, prescriber enrolment). It renders nothing
// in this tree. It is its OWN file so the branch overwrites exactly this one, and no test or panel here has to change when it does.
import type { JSX } from "react";

export function DoseSpotRegistrationSlot(): JSX.Element | null {
  return null;
}
