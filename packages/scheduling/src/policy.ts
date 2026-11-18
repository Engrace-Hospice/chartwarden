// @chartwarden/scheduling — the §1.1 / §2.3 pure-data scheduling policy constants (M17-T01).
//
// IO-free, `@chartwarden/types`-only data the later pure domain reads: the §1.1 D8-predicate-3
// (`discipline_matches_visit`) visit-purpose → acceptable-discipline map, the §1.1 D8 seven-predicate
// pre-schedule gate ordering, and the §1.1 D7 EVV-missing self-attest reason floor. The state machine
// (M17-T03), proposers (M17-T04), and the pre-schedule-gate orchestrator (M17-T07) consume these.

import {
  type EncounterType,
  type VisitPurpose,
  isValidEncounterDisciplinePair,
} from "@chartwarden/types";

/**
 * The discipline vocabulary (mirrors `encounter_discipline` / the M2-M3 catalog).
 *
 * `md` is PHYSICIAN — MD *or* DO. They are the same level with the same scope, which is why
 * {@link VISIT_PURPOSE_DISCIPLINES} below has always documented its physician-intent purposes as
 * "MD/DO or NP" while listing one value; splitting them would stop those four purposes accepting
 * osteopathic physicians. `pa` is a distinct licence BELOW MD/DO and appears in no purpose list
 * (F-030): recording the licence is not granting visit authority, and the Medicare hospice
 * face-to-face encounter is physician-or-NP only (42 CFR 418.22(a)(4)).
 */
export type SchedulingDiscipline =
  | "rn"
  | "lpn"
  | "chha"
  | "msw"
  | "chaplain"
  | "volunteer"
  | "md"
  | "np"
  | "pa";

/** §1.1 D8 predicate 3 (`discipline_matches_visit`) — the acceptable clinician disciplines for each
 * `visit_purpose`. An RN visit needs RN; an aide POC needs CHHA; a volunteer visit needs Volunteer; the
 * physician-intent purposes (`f2f`/`recert`/`loc_change`/`pronouncement`) need MD/DO or NP. */
export const VISIT_PURPOSE_DISCIPLINES: {
  readonly [K in VisitPurpose]: readonly SchedulingDiscipline[];
} = {
  routine_visit: ["rn", "lpn"],
  prn: ["rn", "lpn"],
  aide_poc: ["chha"],
  msw_assessment: ["msw"],
  msw_followup: ["msw"],
  chaplain_visit: ["chaplain"],
  chaplain_assessment: ["chaplain"],
  volunteer_visit: ["volunteer"],
  f2f: ["md", "np"],
  recert: ["md", "np"],
  loc_change: ["md", "np"],
  pronouncement: ["rn", "md", "np"],
  admission_visit: ["rn"],
  discharge_visit: ["rn"],
  // M10 HOPE author floors: HUV timepoints are RN/NP/MD; the scheduling taxonomy's `lpn`
  // represents both LPN and LVN for the SFV author set.
  huv1: ["rn", "np", "md"],
  huv2: ["rn", "np", "md"],
  sfv: ["rn", "np", "lpn"],
} as const;

/**
 * Select the discipline a visit assignment is actually authorized and credentialed under.
 * Policy order is deterministic when a clinician holds multiple qualifying disciplines, except that a
 * discipline with a legal M8 encounter pair ({@link encounterTypeForVisit}) wins over an earlier one
 * without (a clinician holding NP and LPN is stamped LPN for an SFV, not refused as NP). When none has a
 * legal pair the first is still returned, so the stamping gate refuses it with its own
 * `VISIT_ENCOUNTER_TYPE_UNSUPPORTED` code instead of reporting a generic gate miss.
 */
export function selectVisitAssignmentDiscipline(
  visitPurpose: VisitPurpose,
  heldDisciplines: readonly SchedulingDiscipline[],
  activeCredentialDisciplines: readonly SchedulingDiscipline[],
): SchedulingDiscipline | null {
  const held = new Set(heldDisciplines);
  const credentialed = new Set(activeCredentialDisciplines);
  const eligible = VISIT_PURPOSE_DISCIPLINES[visitPurpose].filter(
    (discipline) => held.has(discipline) && credentialed.has(discipline),
  );
  return (
    eligible.find((discipline) => encounterTypeForVisit(visitPurpose, discipline) !== null) ??
    eligible[0] ??
    null
  );
}

/**
 * The M8 encounter type a published visit of this purpose seeds (the `m17.visit.published` payload's
 * `encounterType`). Exhaustive on purpose: a new `VisitPurpose` fails to compile here instead of silently
 * falling through to `routine_visit`.
 *
 * M8 spec §2.2 names no HUV1/HUV2/SFV, `loc_change`, `pronouncement`, `prn` or `discharge_visit` encounter
 * type, so those seed the generic `routine_visit`, whose legal authors are RN and LPN only. A NP/MD author
 * of such a visit has no legal type: {@link encounterTypeForVisit} reports that as `null`.
 */
function encounterTypeForPurpose(purpose: VisitPurpose): EncounterType {
  switch (purpose) {
    case "f2f":
      return "face_to_face";
    case "recert":
      return "recert_visit";
    case "aide_poc":
      return "chha_visit";
    case "msw_assessment":
    case "msw_followup":
    case "chaplain_assessment":
    case "chaplain_visit":
    case "volunteer_visit":
    case "admission_visit":
      return purpose;
    case "routine_visit":
    case "prn":
    case "discharge_visit":
    case "loc_change":
    case "pronouncement":
    case "huv1":
    case "huv2":
    case "sfv":
      return "routine_visit";
  }
}

/**
 * The encounter type a visit of `purpose` stamped with `discipline` seeds, or `null` when M8 §2.2 has no
 * legal (encounter type, discipline) pair for it (M8 §2.7 `INVALID_ENCOUNTER_DISCIPLINE_PAIR`). The M8
 * seed consumer inserts the draft straight into `encounter`, so a visit that would publish an illegal pair
 * must be refused at scheduling time.
 */
export function encounterTypeForVisit(
  purpose: VisitPurpose,
  discipline: SchedulingDiscipline,
): EncounterType | null {
  const encounterType = encounterTypeForPurpose(purpose);
  // `pa` is a licence, not an M8 encounter discipline (F-030): it never has a legal pair.
  if (discipline === "pa") return null;
  return isValidEncounterDisciplinePair(encounterType, discipline) ? encounterType : null;
}

/** §1.1 D8 — the seven-predicate pre-schedule gate, in evaluation order (the `visit_overlap` DB backstop is
 * appended at publish time per §2.5; predicate 6 `volunteer_gate_satisfied` is invoked only for
 * `volunteer_visit`). */
export const PRE_SCHEDULE_GATE_PREDICATES = [
  "clinician_membership_active",
  "clinician_credentials_active",
  "discipline_matches_visit",
  "not_on_pto",
  "within_caseload_or_unassigned_pool",
  "volunteer_gate_satisfied",
  "drive_time_feasible",
] as const;

/** A pre-schedule gate predicate key (§1.1 D8). */
export type PreScheduleGatePredicate = (typeof PRE_SCHEDULE_GATE_PREDICATES)[number];

/** §1.1 D7 / D3 — the EVV-missing self-attest documented-reason floor (chars). The self-attest start path
 * requires step-up auth + a reason of at least this length. */
export const EVV_MISSING_SELF_ATTEST_MIN_REASON_LENGTH = 40;
