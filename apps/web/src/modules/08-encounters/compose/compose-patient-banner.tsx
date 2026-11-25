// apps/web/src/modules/08-encounters/compose — the composer's patient banner: the patient once it has loaded, a neutral title until then
// (moved out of encounter-compose.tsx).
import { PatientBanner } from "@chartwarden/ui";
import type { JSX } from "react";
import type { PatientSummary } from "./compose-model";

export function ComposePatientBanner({
  patient,
}: { readonly patient: PatientSummary | null }): JSX.Element {
  return patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      mrn={patient.mrn}
      dob={patient.dob}
    />
  ) : (
    <PatientBanner name="Encounter documentation" />
  );
}
