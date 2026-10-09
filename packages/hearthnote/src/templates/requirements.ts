// packages/hearthnote/src/templates/requirements.ts -- Sec 2.6 checks 2 & 3's data (#125).
//
// The Sec 2.6 gate's checks 2 (required vitals) and 3 (required clinical scales) were REGISTERED but
// `deferred` from the day the gate went real (#121): the spec states a vitals roster for exactly two
// of the fourteen encounter types in prose (routine_visit; telephonic) and a scales roster for one
// (recert_visit), and nowhere else. Writing the missing rosters would be authoring clinical policy
// inside an enforcement point -- getting one wrong in the strict direction refuses a signature for a
// visit that was documented correctly, and nobody had decided the other eleven.
//
// VITALS is decided by DERIVATION, not a second hand-authored list. `registry.ts`'s `baseSectionIds`
// already decided, per DISCIPLINE, which (encounterType x discipline) pairs carry a required
// `vitals_review` narrative section -- rn/lpn/md/np get one (stripped only for `telephonic`);
// chha/msw/chaplain/volunteer never do. That decision and this one drifting apart -- a template that
// asks a clinician to review vitals in the narrative while the gate does not require the numbers behind
// it, or the reverse -- is worse than the two staying one fact read twice, so `requiredVitalsFor` reads
// the template's own section rather than re-deciding per type. This resolves every encounter type the
// spec's Sec 2.6 prose left silent (admission_visit, recert_visit, face_to_face, lpn_visit, idg_followup;
// the last of which is genuinely discipline-dependent -- an RN's IDG follow-up requires vitals, an MSW's
// does not, because the underlying template does) the SAME way the template author already decided it,
// rather than inventing a fifteenth answer. The one deliberate DEPARTURE from a naive per-type reading:
// `chha_visit` is NOT given the CHHA-scoped vitals roster (BP/weight/pain) the Sec 4.5 role table's
// capture-scope note might suggest, because `baseSectionIds("chha")` carries no `vitals_review` section
// at all -- the template's own design is that a CHHA visit does not narratively review vitals, and
// requiring the numbers while the template requires no discussion of them would be the drift this file
// exists to avoid. `STANDARD_VITALS_ROSTER` is the exact six-item list Sec 2.6 states for `routine_visit`.
//
// SCALES has no comparable structural signal to derive from (M9's scales are not sectioned into
// HearthNote templates at all), so it stays a literal per-type map -- and stays almost entirely empty:
// only `recert_visit` has an explicit roster (Sec 2.2: "Required: PPS, ESAS, prognosis indicators...."),
// and Sec 2.6's own gloss for check 3 is "if mandated by the type" -- silence for the other thirteen is
// the answer, not a gap, because no other type's spec text mandates one.
import type { EncounterType, ScaleType } from "@wardenx/types";
import type { HearthnoteTemplate } from "./types";

/**
 * The Sec 2.6 check-2 vital-sign identity. `bp` is ONE roster entry over TWO `vitals` table columns
 * (`bpSystolic`/`bpDiastolic`) -- a blood pressure reading is one clinical fact captured as a pair, so
 * "captured" requires both and a lone systolic does not count. Also the vocabulary check 2 reads out of
 * `vitals.clinically_not_indicated_fields` (`text[]`, unconstrained at the DB -- nothing wrote a
 * vocabulary into it before this; an entry not spelled exactly one of these six is neither a captured
 * field nor a valid escape and is ignored rather than treated as a typo'd pass).
 */
export type VitalField = "bp" | "heartRate" | "respiratoryRate" | "temperature" | "spo2" | "pain";

/** Sec 2.6's own literal roster for `routine_visit` -- "BP, HR, RR, T, SpO2, pain" -- reused wherever a
 *  template's resolved `vitals_review` section says vitals are required at all (see module header). */
export const STANDARD_VITALS_ROSTER: readonly VitalField[] = [
  "bp",
  "heartRate",
  "respiratoryRate",
  "temperature",
  "spo2",
  "pain",
];

/**
 * Sec 2.6 check 2 -- the vitals a resolved (type x discipline) template requires captured before sign,
 * or `clinically_not_indicated` with a reason. `[]` when the template carries no required
 * `vitals_review` section (every chha/msw/chaplain/volunteer pair, and every `telephonic` pair
 * regardless of discipline -- `buildTemplate` strips the section for that type specifically).
 */
export function requiredVitalsFor(template: HearthnoteTemplate): readonly VitalField[] {
  return template.sections.some((s) => s.id === "vitals_review" && s.required)
    ? STANDARD_VITALS_ROSTER
    : [];
}

/**
 * Sec 2.6 check 3 -- the M9 clinical scales an ENCOUNTER TYPE mandates (consulted via
 * `LatestAssessmentProvider` -- WHICH patient/whether it is present is a service-layer fact, not this
 * file's). Every one of the encounter types is given an explicit, decided value per #125's acceptance
 * criterion; every type but `recert_visit` is a deliberate `[]` because the spec never names one for them, not an
 * oversight.
 */
export const REQUIRED_SCALES: Readonly<Record<EncounterType, readonly ScaleType[]>> = {
  routine_visit: [],
  admission_visit: [],
  recert_visit: ["pps", "esas_r"],
  face_to_face: [],
  telephonic: [],
  lpn_visit: [],
  chha_visit: [],
  msw_assessment: [],
  msw_followup: [],
  chaplain_assessment: [],
  chaplain_visit: [],
  volunteer_visit: [],
  bereavement_contact: [],
  idg_followup: [],
  pt_visit: [],
  ot_visit: [],
  slp_visit: [],
};

/** Resolver form of {@link REQUIRED_SCALES}, mirroring {@link requiredVitalsFor}'s call shape. */
export function requiredScalesFor(encounterType: EncounterType): readonly ScaleType[] {
  return REQUIRED_SCALES[encounterType];
}
