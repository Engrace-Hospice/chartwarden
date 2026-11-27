// apps/backend/src/modules/09-assessments/wounds/patient-exists.ts — WF09 (CW-AC-54): a wound is registered only for a patient that exists
// in the caller's own organisation.
//
// `wound.patient_id` has no foreign key (M9 reads no M5 table), and the registration route authorises on `assessment.author` and the caseload
// predicate alone, so without this a clinician could register a wound against a uuid that names no patient of the organisation. M5's
// `PatientReader` seam answers (an org-scoped read behind RLS, so another tenant's patient answers the same as an absent one). It opens its own
// tenant context, so the check runs OUTSIDE any open transaction. The seam fails closed: an unbound registry entry is a deny stub that throws,
// which surfaces as a 500, never as "exists".
import { NotFoundError, type PatientReader } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";

/** What the wound services ask of M5: whether the patient exists in the organisation. */
export interface WoundPatientReader {
  exists(input: { readonly organizationId: string; readonly patientId: string }): Promise<boolean>;
}

/** The production reader: M5's seam through the M1 registry, resolved per call so a late-wired seam is picked up; the deny-stub fails closed. */
export const seamWoundPatientReader: WoundPatientReader = woundPatientReaderOver({
  findById: (input) => getSeam("PatientReader").findById(input),
});

/**
 * A reader over an M5 `PatientReader`. The patient must come back under the very id asked for: M5 follows a merge redirect and answers with the
 * SURVIVOR, and a wound filed under a retired id would be invisible to every read keyed on the survivor. The two ids are compared in lowercase:
 * the route's `uuid` format is case-insensitive and does not normalize, while Postgres answers a uuid in lowercase, so an uppercase or mixed-case
 * id of an existing patient must not read as a different patient.
 */
export function woundPatientReaderOver(
  reader: Pick<PatientReader, "findById">,
): WoundPatientReader {
  return {
    exists: async ({ organizationId, patientId }) => {
      const found = await reader.findById({ organizationId, id: patientId });
      return found !== null && found.id.toLowerCase() === patientId.toLowerCase();
    },
  };
}

/** The reader the in-memory service uses when a test names none: it has no patient table, so every patient exists. Never wired in production. */
export const everyWoundPatientExists: WoundPatientReader = { exists: async () => true };

/** Throws the one 404 an unknown patient answers (the caller's organisation only; no distinction for another tenant's patient). */
export async function assertPatientExists(
  patients: WoundPatientReader,
  input: { readonly organizationId: string; readonly patientId: string },
): Promise<void> {
  if (!(await patients.exists(input))) throw new NotFoundError("patient", input.patientId);
}
