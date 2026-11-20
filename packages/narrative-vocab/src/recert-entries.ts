// packages/narrative-vocab/src/recert-entries.ts — the recertification and face-to-face draft phrases (S2, ADR-0114, VN-D31 to VN-D34).
//
// Appended to the corpus by `draft-entries.ts` as `narrative-vocab@2026.12.0`. DRAFT WORDING until ADA approves this release
// (`CORPUS_CLINICAL_REVIEW`: an approval names the release it covers, VN-D34). Every phrase states numbers, dates and the names of
// recorded facts, and nothing else: "down" and "up" restate arithmetic, and no phrase states a prognosis, an eligibility conclusion
// or a life expectancy (VN-D32). All of them are draft-only: the draft compiler fills the slots from structured records, so none
// is listed in a section menu a clinician could type values into.
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import type { VocabEntry } from "./types";

const RN_ONLY: readonly EncounterDiscipline[] = ["rn"];
const RECERT_ONLY: readonly EncounterType[] = ["recert_visit"];
// Cross-product tags: the legal pairs are recert_visit x rn, face_to_face x md and face_to_face x np. The other combinations
// (recert_visit x md, face_to_face x rn) are not legal pairs, so they never resolve a template.
const RN_MD_NP: readonly EncounterDiscipline[] = ["rn", "md", "np"];
const RECERT_AND_F2F: readonly EncounterType[] = ["recert_visit", "face_to_face"];

/** The 11 recertification and face-to-face draft entries, in corpus order (appended after the 25 of 2026.11.0). */
export const RECERT_VOCABULARY: readonly VocabEntry[] = [
  // ── PPS against the first reading of the benefit period (the `prognosis` section of both templates) ─────────
  {
    code: "nv.rc.pps_baseline_down",
    label: "Decline evidence — PPS, lower than the first reading of the benefit period",
    phrase:
      "PPS ${pps_value}%, down from ${pps_baseline_value}% on ${pps_baseline_date}, the first reading of this benefit period",
    category: "decline_evidence",
    disciplines: RN_MD_NP,
    encounterTypes: RECERT_AND_F2F,
  },
  {
    code: "nv.rc.pps_baseline_up",
    label: "Decline evidence — PPS, higher than the first reading of the benefit period",
    phrase:
      "PPS ${pps_value}%, up from ${pps_baseline_value}% on ${pps_baseline_date}, the first reading of this benefit period",
    category: "decline_evidence",
    disciplines: RN_MD_NP,
    encounterTypes: RECERT_AND_F2F,
  },
  {
    code: "nv.rc.pps_baseline_same",
    label: "Decline evidence — PPS, same as the first reading of the benefit period",
    phrase:
      "PPS ${pps_value}%, unchanged from ${pps_baseline_value}% on ${pps_baseline_date}, the first reading of this benefit period",
    category: "decline_evidence",
    disciplines: RN_MD_NP,
    encounterTypes: RECERT_AND_F2F,
  },

  // ── weight over the benefit period (the `prognosis` section of both templates) ──────────────────────────────
  {
    code: "nv.rc.weight_first",
    label: "Decline evidence — weight, the only reading of the benefit period",
    phrase:
      "Weight ${weight_value} ${weight_unit} on ${weight_date}, the only weight recorded in this benefit period",
    category: "decline_evidence",
    disciplines: RN_MD_NP,
    encounterTypes: RECERT_AND_F2F,
  },
  {
    code: "nv.rc.weight_down",
    label: "Decline evidence — weight, lower than the first reading of the benefit period",
    phrase:
      "Weight ${weight_value} ${weight_unit} on ${weight_date}, down ${weight_change_percent}% from ${weight_baseline_value} ${weight_unit} on ${weight_baseline_date}",
    category: "decline_evidence",
    disciplines: RN_MD_NP,
    encounterTypes: RECERT_AND_F2F,
  },
  {
    code: "nv.rc.weight_up",
    label: "Decline evidence — weight, higher than the first reading of the benefit period",
    phrase:
      "Weight ${weight_value} ${weight_unit} on ${weight_date}, up ${weight_change_percent}% from ${weight_baseline_value} ${weight_unit} on ${weight_baseline_date}",
    category: "decline_evidence",
    disciplines: RN_MD_NP,
    encounterTypes: RECERT_AND_F2F,
  },
  {
    code: "nv.rc.weight_same",
    label: "Decline evidence — weight, same as the first reading of the benefit period",
    phrase:
      "Weight ${weight_value} ${weight_unit} on ${weight_date}, unchanged from ${weight_baseline_value} ${weight_unit} on ${weight_baseline_date}",
    category: "decline_evidence",
    disciplines: RN_MD_NP,
    encounterTypes: RECERT_AND_F2F,
  },

  // ── the face-to-face encounter's facts (the recertification's `prognosis` section only) ────────────────────
  {
    code: "nv.rc.f2f",
    label: "Decline evidence — face-to-face encounter performed and attested",
    phrase:
      "Face-to-face encounter performed by a hospice ${f2f_performer} on ${f2f_performed_on}, attested on ${f2f_attested_on}",
    category: "decline_evidence",
    disciplines: RN_ONLY,
    encounterTypes: RECERT_ONLY,
  },

  // ── the benefit period (the recertification's `recert_summary` section) ───────────────────────────────────
  {
    code: "nv.rc.period",
    label: "Benefit period — number, length, dates and day of the period",
    phrase:
      "Benefit period ${period_sequence}, ${period_length}-day period from ${period_start} to ${period_end}; day ${period_day} on the date of this visit",
    category: "benefit_period",
    disciplines: RN_ONLY,
    encounterTypes: RECERT_ONLY,
  },
  {
    code: "nv.rc.level_of_care",
    label: "Benefit period — level of care on the visit date",
    phrase: "Level of care on the date of this visit: ${level_of_care}",
    category: "benefit_period",
    disciplines: RN_ONLY,
    encounterTypes: RECERT_ONLY,
  },
  {
    code: "nv.rc.cti_signed",
    label: "Benefit period — certification of terminal illness signed",
    phrase: "Certification of terminal illness for this benefit period signed on ${cti_signed_on}",
    category: "benefit_period",
    disciplines: RN_ONLY,
    encounterTypes: RECERT_ONLY,
  },
] as const;
