// apps/backend/src/modules/08-encounters/consumers/seed-modality.ts — the visit modality a draft encounter
// opens with. PURE. The value is an UNCONFIRMED pre-selection (the encounter row's
// `visit_modality_confirmed_at` stays NULL until the signing clinician confirms it); anything the visit does
// not say seeds null. A modality is never guessed: an unknown setting is "unknown", not "in person".
import type { EncounterType, EncounterVisitModality } from "@chartwarden/types";

/** The M17 `visit_setting` values that put the clinician physically with the patient. */
const IN_PERSON_VISIT_SETTINGS: ReadonlySet<string> = new Set([
  "patient_home",
  "facility",
  "inpatient_unit",
]);

/**
 * The modality to seed on a new draft. `visitSetting` is the raw `m17.visit.published` payload value
 * (`unknown`: the wire is untrusted). A `telephonic` encounter type is telephonic by definition, and it wins
 * over an in-person setting: the conflict resolves to the modality Medicare does not count, never the one it
 * does.
 */
export function seedModalityFor(input: {
  readonly visitSetting?: unknown;
  readonly encounterType?: EncounterType;
}): EncounterVisitModality | null {
  if (input.encounterType === "telephonic" || input.visitSetting === "telephonic") {
    return "telephonic";
  }
  if (typeof input.visitSetting === "string" && IN_PERSON_VISIT_SETTINGS.has(input.visitSetting)) {
    return "in_person";
  }
  return null;
}
