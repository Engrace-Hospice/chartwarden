// apps/backend/src/modules/15-discipline-care-plans/consumers/care-plan-elements.ts — M15-T03 (§2.1, §2.3).
//
// M15 CONSUMES M7's §7.8 `CarePlanReader`: a discipline plan does not invent its own problems — every
// `discipline_goal` hangs off an IPOC problem the IDG signs, and may optionally refine an IPOC goal
// (`parent_goal_id`) or an IPOC intervention (`parent_intervention_id`). §1.2 is explicit that M15 is a
// discipline VIEW of the shared plan, not a second plan; without this resolution the two records fork and
// the IDG signs one while the aide works the other.
//
// The reader is asked for the elements RELEVANT to this plan's discipline, so an MSW plan is offered the
// MSW-tagged interventions and a chaplain plan the chaplain-tagged ones. SUD redaction is applied SQL-side
// inside M7's reader (D7) — M15 never re-derives it, and `redacted:true` rides through so the caller can
// render the §7.8 "some content has been redacted" envelope rather than a silently short list.
import type {
  DisciplinePlanKind,
  EncounterType,
  InterventionDiscipline,
  PatientId,
  RelevantCarePlanElements,
} from "@wardenx/types";
import { checkOptionalParentElement, checkParentProblem } from "../lifecycle/index";
import { getCarePlanReader } from "../seams/index";

/**
 * The (discipline, encounter type) each plan kind reads the IPOC through. `volunteer_coordinator` is not
 * an M7 intervention discipline — a volunteer plan reads the `volunteer`-tagged elements, which is the
 * discipline the volunteer's own M8 encounters carry.
 */
const READER_LENS_BY_KIND: {
  readonly [K in DisciplinePlanKind]: {
    readonly discipline: InterventionDiscipline;
    readonly encounterType: EncounterType;
  };
} = {
  aide_poc: { discipline: "chha", encounterType: "chha_visit" },
  msw_plan: { discipline: "msw", encounterType: "msw_assessment" },
  spiritual_plan: { discipline: "chaplain", encounterType: "chaplain_assessment" },
  volunteer_plan: { discipline: "volunteer", encounterType: "volunteer_visit" },
} as const;

/** The IPOC elements a discipline plan of `kind` may parent onto (§2.1). Null when the patient has no plan. */
export async function relevantIpocElements(
  kind: DisciplinePlanKind,
  patientId: PatientId,
): Promise<RelevantCarePlanElements | null> {
  const lens = READER_LENS_BY_KIND[kind];
  return getCarePlanReader().relevantElementsForEncounter(
    patientId,
    lens.encounterType,
    lens.discipline,
  );
}

/** The parent links a discipline goal / intervention write asserts (§2.3). */
export interface ParentElementRefs {
  /** Required on a discipline goal — the IPOC problem it hangs off. */
  readonly parentProblemId?: string | null;
  /** Optional — the IPOC goal this discipline goal refines. */
  readonly parentGoalId?: string | null;
  /** Optional — the IPOC intervention this discipline intervention refines. */
  readonly parentInterventionId?: string | null;
}

/**
 * §2.3 — validate a discipline element's parent links against the LIVE IPOC through M7's seam. Raises
 * `PARENT_PROBLEM_REQUIRED` (422) when a goal carries no problem and `PARENT_ELEMENT_NOT_FOUND` (422) when
 * any supplied id is not an active element on this patient's care plan.
 *
 * `requireProblem` is false for interventions (§2.1 gives `discipline_intervention` an optional parent
 * intervention and no direct problem column) and true for goals.
 *
 * FAIL-CLOSED: a patient with no resolvable care plan cannot parent anything — the reader returning null
 * lands on `PARENT_ELEMENT_NOT_FOUND` rather than being waved through.
 */
export async function assertParentElements(
  kind: DisciplinePlanKind,
  patientId: PatientId,
  refs: ParentElementRefs,
  requireProblem: boolean,
): Promise<void> {
  const elements = await relevantIpocElements(kind, patientId);
  const problemIds = new Set((elements?.problems ?? []).map((p) => p.problemId));
  const goalIds = new Set((elements?.goals ?? []).map((g) => g.goalId));
  const interventionIds = new Set((elements?.interventions ?? []).map((i) => i.interventionId));

  if (requireProblem) {
    checkParentProblem(refs.parentProblemId, problemIds.has(refs.parentProblemId ?? ""));
  } else {
    checkOptionalParentElement(refs.parentProblemId, problemIds.has(refs.parentProblemId ?? ""));
  }
  checkOptionalParentElement(refs.parentGoalId, goalIds.has(refs.parentGoalId ?? ""));
  checkOptionalParentElement(
    refs.parentInterventionId,
    interventionIds.has(refs.parentInterventionId ?? ""),
  );
}
