// apps/backend/src/modules/07-care-plan/lifecycle/care-plan.ts — M7-T03 (§2.2.1).
//
// The care_plan ROOT lifecycle: draft → active ⇄ active → discharged. Created `draft` when the M6
// `admission.activated` outbox event is processed (one non-discharged plan per (patient, admission),
// enforced by the partial unique index — the `openCarePlan` factory below); promoted to `active` when
// the initial version is signed (Required Signer Set met + a terminal problem present, §2.3); stays
// `active` while signed revisions flip `active_version_id`; terminal `discharged` when the admission
// ends. Pure transition over already-resolved facts; the per-version machine lives in `./version`.
import type { IsoInstant } from "@wardenx/types";
import { CarePlanStateError, require_ } from "./errors";
import { type TransitionResult, result } from "./effects";
import { checkTerminalProblemPresent } from "./validation";

/** The §2.2.1 care_plan root states (mirrors `care_plan_status`). */
export type CarePlanLifecycleState = "draft" | "active" | "discharged";

/** Why a care plan was discharged (mirrors the M6 admission-end cause that drove the event). */
export type CarePlanDischargeReason = "discharge" | "death" | "revocation" | "transfer";

/** The §2.2.1 care_plan root events. */
export type CarePlanEvent =
  | {
      readonly type: "activate";
      /** ≥1 active terminal problem is required to sign the initial version (§2.3). */
      readonly hasTerminalActiveProblem: boolean;
      readonly at: IsoInstant;
    }
  | { readonly type: "reviseSigned"; readonly at: IsoInstant }
  | { readonly type: "discharge"; readonly reason: CarePlanDischargeReason };

export type CarePlanTransition = TransitionResult<CarePlanLifecycleState, CarePlanEvent["type"]>;

/** The legal §2.2.1 transition graph (from → events accepted). Guards are checked separately. */
export const CARE_PLAN_GRAPH: Readonly<
  Record<CarePlanLifecycleState, ReadonlyArray<CarePlanEvent["type"]>>
> = {
  draft: ["activate", "discharge"],
  active: ["reviseSigned", "discharge"],
  discharged: [],
};

/**
 * The `[*] → draft` factory: open the single non-discharged care plan for an admission when M6's
 * `admission.activated` event is processed (§2.2.1). Returns the draft state + `m7.care_plan.created`
 * outbox effect; the partial unique index is the structural backstop for "exactly one per admission".
 */
export function openCarePlan(): { readonly status: "draft"; readonly effects: CarePlanTransition["effects"] } {
  return {
    status: "draft",
    effects: [
      { kind: "audit" },
      { kind: "outbox", event: "m7.care_plan.created" },
    ],
  };
}

/** Apply a care_plan root event (§2.2.1). Throws `ILLEGAL_TRANSITION` if the event is not accepted. */
export function transitionCarePlan(
  from: CarePlanLifecycleState,
  event: CarePlanEvent,
): CarePlanTransition {
  if (!CARE_PLAN_GRAPH[from].includes(event.type)) {
    throw new CarePlanStateError(
      "ILLEGAL_TRANSITION",
      `care plan cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "activate": {
      // The initial version's sign completes (§2.2.2) and the root flips draft → active.
      checkTerminalProblemPresent(event.hasTerminalActiveProblem);
      return result(from, event.type, "active", [
        { kind: "set_timestamp", field: "initial_signed_at", at: event.at },
        { kind: "flip_active_version" },
        { kind: "audit" },
      ]);
    }
    case "reviseSigned": {
      // A signed revision keeps the plan active; `active_version_id` flips to the new version.
      return result(from, event.type, "active", [
        { kind: "set_timestamp", field: "active_version_flipped_at", at: event.at },
        { kind: "flip_active_version" },
        { kind: "audit" },
      ]);
    }
    case "discharge": {
      require_(event.reason !== undefined, "ILLEGAL_TRANSITION", "a discharge reason is required");
      return result(from, event.type, "discharged", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.care_plan.discharged" },
      ]);
    }
  }
}
