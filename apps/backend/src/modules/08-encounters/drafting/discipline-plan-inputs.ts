// apps/backend/src/modules/08-encounters/drafting/discipline-plan-inputs.ts — the social-work and chaplain draft's reads of the discipline's OWN plan (M15,
// ADR-0114 S4, S4b): the plan in effect at the visit as the viewer is handed it, less the elements this visit left out, as the draft's source and as the
// element list the per-element routes show. Split out of `inputs.ts` (which was over the file-size ceiling); behaviour unchanged. Reads only through `DraftPorts`.
import type { DisciplinePlanDraftInput, DisciplinePlanStatedBy } from "@chartwarden/hearthnote";
import type {
  DisciplineGoalAsOf,
  DisciplinePlanElementsAsOf,
  DisciplinePlanKind,
  EncounterDiscipline,
} from "@chartwarden/types";
import { disciplinePlanElementKinds } from "./discipline-plan-refs";
import { type Part2Verdict, part2VerdictFor } from "./part2-verdict";
import type { DraftEncounter, DraftPorts, DraftViewer } from "./ports";
import { draftUnavailable, guarded, settleAll } from "./unavailable";

/** The plan kind a social-work or chaplain note is drafted from. Any other discipline has none: its draft never reads this source. */
function disciplinePlanKindFor(discipline: EncounterDiscipline): DisciplinePlanKind {
  switch (discipline) {
    case "msw":
      return "msw_plan";
    case "chaplain":
      return "spiritual_plan";
    default:
      throw draftUnavailable("the discipline plan (this discipline has none)");
  }
}

/**
 * Who stated a goal, where the plan's record says it was not the clinician. A goal a clinician revised is the clinician's words now, so it is
 * listed without the attribution (never as the patient's, family's or agent's).
 */
function statedByOf(goal: DisciplineGoalAsOf): DisciplinePlanStatedBy | null {
  if (goal.revised) return null;
  switch (goal.source) {
    case "patient_stated":
      return "patient";
    case "family_stated":
      return "family";
    case "agent_stated":
      return "agent";
    default:
      return null;
  }
}

/** The plan's goals and interventions, less the ones this visit left out (S4b: a removed link and no live one). */
function disciplinePlanInput(
  plan: DisciplinePlanElementsAsOf,
  removed: ReadonlySet<string>,
): DisciplinePlanDraftInput {
  return {
    goals: plan.goals
      .filter((g) => !removed.has(g.goalId))
      .map((g) => ({
        id: g.goalId,
        goalText: g.text,
        statedBy: statedByOf(g),
        sudRelated: g.sudRelated,
      })),
    interventions: plan.interventions
      .filter((i) => !removed.has(i.interventionId))
      .map((i) => ({
        id: i.interventionId,
        interventionText: i.scopeText,
        frequencyText: i.frequencyText,
        sudRelated: i.sudRelated,
      })),
  };
}

/**
 * S4: the open goals and active interventions of the discipline's own plan (M15) in the signed version in effect at the visit time, for this
 * viewer. M15 redacts Part 2 per viewer in its own M39 call, so the cross-check of `readCarePlan` applies here as well: a plan it says it
 * withheld from a viewer this draft's own verdict clears was cut by an outage or a consent change in between, and is never passed off as complete.
 * S4b: the elements this visit LEFT OUT (a removed link and no live one, `encounter_discipline_plan_link`) are read beside the plan and dropped from it,
 * as the care plan's removed links are; a viewer's Part 2 verdict does not change which elements are removed, only which the plan returned.
 */
export async function readDisciplinePlan(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  asOf: string,
  part2Verdict: Part2Verdict,
): Promise<DisciplinePlanDraftInput | null> {
  const checked = await readCheckedDisciplinePlan(ports, encounter, viewer, asOf, part2Verdict);
  return checked === null ? null : disciplinePlanInput(checked.plan, checked.removed);
}

/** The plan as M15 handed it for this viewer (every check applied) and the elements this visit left out; `null` when no plan is in effect. */
async function readCheckedDisciplinePlan(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  asOf: string,
  part2Verdict: Part2Verdict,
): Promise<{
  readonly plan: DisciplinePlanElementsAsOf;
  readonly removed: ReadonlySet<string>;
} | null> {
  const kind = disciplinePlanKindFor(encounter.discipline);
  const [plan, removed] = await settleAll([
    guarded("the discipline plan", () =>
      ports.disciplinePlanAsOf(
        encounter.organizationId,
        encounter.patientId,
        encounter.admissionId,
        kind,
        { roles: viewer.roles, membershipId: viewer.membershipId },
        asOf,
      ),
    ),
    guarded("the removed discipline-plan links", () =>
      ports.removedDisciplinePlanElementIds(encounter.id),
    ),
  ]);
  if (plan === null) return null;
  // A plan that is not this patient's must never reach a note, however the seam came to return it.
  if (plan.patientId !== encounter.patientId)
    throw draftUnavailable("the discipline plan (wrong patient)");
  if (plan.redacted && (await part2Verdict()))
    throw draftUnavailable("the discipline plan (withheld from a viewer entitled to it)");
  return { plan, removed };
}

/** One element of the discipline's plan as a visit sees it (S4b): its words, whether the visit keeps it, and its own Part 2 verdict (fails closed). */
export interface DisciplinePlanElement {
  readonly elementId: string;
  readonly kind: "goal" | "intervention";
  readonly text: string;
  readonly kept: boolean;
  /** True unless the plan says the literal `false`; it is the flag a link row for this element carries. */
  readonly part2Derived: boolean;
}

/**
 * The goals and then the interventions of the discipline's plan in effect at `asOf` for this viewer, in the plan's order, each with whether this
 * visit keeps it (a removed link and no live one is "left out"). What the plan hands a viewer is all there is: a Part 2 element a viewer without
 * disclosure is not handed is not here, so it can be neither read nor changed. The same read, checks and failure codes as the draft's own.
 */
export async function readDisciplinePlanElements(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  asOf: string,
): Promise<readonly DisciplinePlanElement[]> {
  const checked = await readCheckedDisciplinePlan(
    ports,
    encounter,
    viewer,
    asOf,
    part2VerdictFor(ports, encounter, viewer),
  );
  if (checked === null) return [];
  const { plan, removed } = checked;
  return [
    ...plan.goals.map(
      (g): DisciplinePlanElement => ({
        elementId: g.goalId,
        kind: "goal",
        text: g.text,
        kept: !removed.has(g.goalId),
        part2Derived: g.sudRelated !== false,
      }),
    ),
    ...(disciplinePlanElementKinds(encounter.discipline).includes("intervention")
      ? plan.interventions
      : []
    ).map(
      (i): DisciplinePlanElement => ({
        elementId: i.interventionId,
        kind: "intervention",
        text: i.frequencyText.trim() === "" ? i.scopeText : `${i.scopeText}, ${i.frequencyText}`,
        kept: !removed.has(i.interventionId),
        part2Derived: i.sudRelated !== false,
      }),
    ),
  ];
}
