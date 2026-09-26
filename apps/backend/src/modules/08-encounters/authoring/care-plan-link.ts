// apps/backend/src/modules/08-encounters/authoring/care-plan-link.ts — F-064 (#159), §3.3
// `encounter_care_plan_link`.
//
// The guard the route never ran. `POST /api/v1/encounters/{encounterId}/care-plan-links` parsed a body
// carrying the M7 problem / goal / intervention refs and passed NONE of them on — `addCarePlanLink`
// took no third argument — so the join that says *this visit addressed this problem, worked this goal,
// delivered this intervention* was empty for every encounter the platform has ever recorded, and no
// consumer could tell that apart from "this visit addressed nothing". It is the join between the
// encounter and the plan of care that 42 CFR 418.56(b) requires the care to follow.
//
// Pure: the service supplies the input and persists the row.
import { require_ } from "../lifecycle/errors";

/** The M7 element refs a link records. All optional individually; at least one is required. */
export interface CarePlanLinkRefs {
  readonly problemId?: string;
  readonly goalId?: string;
  readonly interventionId?: string;
}

/**
 * §3.3 — a link must name at least one care-plan element.
 *
 * `encounter_care_plan_link_at_least_one` is a DB CHECK, so an empty body would have raised a raw
 * `23514` at the driver — a 500 with a Postgres constraint name in it. Mirrored here so the caller gets
 * a 422 that names what is missing, the same way `mileage_override_reason_required` is mirrored in
 * `MILEAGE_OVERRIDE_REASON_REQUIRED`.
 */
export function assertAtLeastOneCarePlanRef(refs: CarePlanLinkRefs): void {
  require_(
    isRef(refs.problemId) || isRef(refs.goalId) || isRef(refs.interventionId),
    "CARE_PLAN_LINK_REF_REQUIRED",
    "A care-plan link must name at least one of problemId, goalId or interventionId.",
  );
}

const isRef = (v: string | undefined): v is string => typeof v === "string" && v.length > 0;
