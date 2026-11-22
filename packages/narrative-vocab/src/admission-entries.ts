// packages/narrative-vocab/src/admission-entries.ts — the RN admission visit's draft phrases (S2b, ADR-0114, VN-D35 to VN-D38).
//
// Appended to the corpus by `draft-entries.ts` as `narrative-vocab@2026.12.1`. DRAFT WORDING until ADA approves this release
// (`CORPUS_CLINICAL_REVIEW`: an approval names the release it covers, VN-D34). Every phrase states a fact that is on record and nothing
// else: an order that was in effect, a caregiver as recorded, an acknowledgment that was on file. None says a medication was
// reconciled or verified, none says the patient has or lacks an advance directive, and none states an absence (an empty record drafts
// nothing). All of them are draft-only: the draft compiler fills the slots from structured records, so none is listed in a section
// menu a clinician could type values into.
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import type { VocabEntry } from "./types";

const RN_ONLY: readonly EncounterDiscipline[] = ["rn"];
const ADMISSION_ONLY: readonly EncounterType[] = ["admission_visit"];
/**
 * The two order phrases are also drafted in the face-to-face visit by a physician or nurse practitioner (S5, VN-D52, `narrative-vocab@2026.12.4`):
 * its `med_reconciliation` states the orders in effect at the visit, as the admission visit's does. Wording untouched.
 */
const ORDER_DISCIPLINES: readonly EncounterDiscipline[] = ["rn", "md", "np"];
const ORDER_ENCOUNTER_TYPES: readonly EncounterType[] = ["admission_visit", "face_to_face"];

/** The 5 admission draft entries, in corpus order (appended after the 11 of 2026.12.0). */
export const ADMISSION_VOCABULARY: readonly VocabEntry[] = [
  // ── the orders in effect at the visit (the `med_reconciliation` section) ─────────────────────────────────────
  {
    code: "nv.adm.med_active",
    label: "Admission — an order in effect at the visit",
    phrase: "Active order at the visit: ${drug_name} ${strength} ${dose_form}, ${route}",
    category: "admission_record",
    disciplines: ORDER_DISCIPLINES,
    encounterTypes: ORDER_ENCOUNTER_TYPES,
  },
  {
    code: "nv.adm.med_active_prn",
    label: "Admission — an as-needed order in effect at the visit",
    phrase: "Active order at the visit, as needed: ${drug_name} ${strength} ${dose_form}, ${route}",
    category: "admission_record",
    disciplines: ORDER_DISCIPLINES,
    encounterTypes: ORDER_ENCOUNTER_TYPES,
  },

  // ── the advance directive acknowledgment on file (the `advance_directive` section) ───────────────────────────
  {
    code: "nv.adm.ad_ack_on_file",
    label: "Admission — an advance directive acknowledgment was on file",
    phrase: "An advance directive acknowledgment was on file at the time of the visit",
    category: "admission_record",
    disciplines: RN_ONLY,
    encounterTypes: ADMISSION_ONLY,
  },

  // ── the caregivers on record on the service date (the `caregiver_overview` section) ──────────────────────────
  {
    code: "nv.adm.caregiver_primary",
    label: "Admission — the primary caregiver on record",
    phrase: "${caregiver_name} (${caregiver_relationship}) is recorded as the primary caregiver",
    category: "admission_record",
    disciplines: RN_ONLY,
    encounterTypes: ADMISSION_ONLY,
  },
  {
    code: "nv.adm.caregiver_other",
    label: "Admission — a caregiver on record",
    phrase: "${caregiver_name} (${caregiver_relationship}) is recorded as a caregiver",
    category: "admission_record",
    disciplines: RN_ONLY,
    encounterTypes: ADMISSION_ONLY,
  },
];
