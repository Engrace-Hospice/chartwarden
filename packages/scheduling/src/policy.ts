// @wardenx/scheduling — the §1.1 / §2.3 pure-data scheduling policy constants (M17-T01).
//
// IO-free, `@wardenx/types`-only data the later pure domain reads: the §1.1 D8-predicate-3
// (`discipline_matches_visit`) visit-purpose → acceptable-discipline map, the §1.1 D8 seven-predicate
// pre-schedule gate ordering, and the §1.1 D7 EVV-missing self-attest reason floor. The state machine
// (M17-T03), proposers (M17-T04), and the pre-schedule-gate orchestrator (M17-T07) consume these.

import type { VisitPurpose } from "@wardenx/types";

/** The discipline vocabulary (mirrors `encounter_discipline` / the M2-M3 catalog). */
export type SchedulingDiscipline =
  | "rn"
  | "lpn"
  | "chha"
  | "msw"
  | "chaplain"
  | "volunteer"
  | "md"
  | "np";

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
} as const;

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
