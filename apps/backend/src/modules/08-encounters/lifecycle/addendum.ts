import type { LocalDate } from "@chartwarden/types";
import { type EncounterSideEffect, type TransitionResult, result } from "./effects";
// apps/backend/src/modules/08-encounters/lifecycle/addendum.ts — M8-T04 (§2.3).
//
// An `encounter_addendum` is a first-class child aggregate with its own small lifecycle: draft →
// finalized → signed (§2.3, §7.4). It is created in `draft` from a `signed`/`cosigned` parent (the
// service runs `checkParentNotVoided` first — a voided parent raises §2.7 `PARENT_VOIDED`); the parent
// row's status NEVER changes (the diagram's `addendum_open` is a transient UI state, not a persisted
// parent state). On addendum sign the parent stays signed/cosigned and `m8.encounter.addendum_signed`
// publishes; M22 re-renders the PDF with the addendum appended in chronological order. Pure machine,
// same shape as the parent: legal-graph check + enumerated guards + §2.8 side-effect list.
import { EncounterStateError, require_ } from "./errors";

/** The addendum's own lifecycle state (a subset of the encounter-status vocabulary). */
export type AddendumState = "draft" | "finalized" | "signed";

/** The §2.3 / §7.4 addendum events. */
export type AddendumEvent =
  | { readonly type: "finalize"; readonly gatePreviewPassed: boolean; readonly at: LocalDate }
  | {
      readonly type: "sign";
      readonly gatePassed: boolean;
      readonly stepUpFresh: boolean;
      readonly at: LocalDate;
    };

export type AddendumTransition = TransitionResult<AddendumState, AddendumEvent["type"]>;

/** The legal §2.3 addendum transition graph (from → events accepted). Guards checked separately. */
export const ADDENDUM_GRAPH: Readonly<Record<AddendumState, ReadonlyArray<AddendumEvent["type"]>>> =
  {
    draft: ["finalize"],
    finalized: ["sign"],
    signed: [],
  };

/**
 * The genesis of an addendum: a `draft` row off a non-voided parent (§2.3). The service runs
 * `checkParentNotVoided` before this; here we only emit the create-time side effects (audit only — no
 * outbox until the addendum signs).
 */
export function planAddendumCreation(): ReadonlyArray<EncounterSideEffect> {
  return [{ kind: "audit" }];
}

/**
 * Apply an addendum lifecycle event (§2.3). Throws {@link EncounterStateError} `ILLEGAL_TRANSITION` if
 * the event is not accepted from `from`, or the specific §2.7 guard code on a guard failure.
 */
export function transitionAddendum(from: AddendumState, event: AddendumEvent): AddendumTransition {
  if (!ADDENDUM_GRAPH[from].includes(event.type)) {
    throw new EncounterStateError(
      "ILLEGAL_TRANSITION",
      `addendum cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "finalize": {
      require_(
        event.gatePreviewPassed,
        "COMPLIANCE_GATE_FAILED",
        "Layer-3 gate failed on the addendum",
      );
      return result(from, event.type, "finalized", [
        { kind: "persist_assembled_output" },
        { kind: "set_timestamp", field: "addendum_finalized_at", at: event.at },
        { kind: "audit" },
      ]);
    }
    case "sign": {
      require_(
        event.stepUpFresh,
        "STEP_UP_AUTH_REQUIRED",
        "addendum sign requires fresh step-up auth",
      );
      require_(event.gatePassed, "COMPLIANCE_GATE_FAILED", "Layer-3 gate failed on the addendum");
      return result(from, event.type, "signed", [
        { kind: "write_signature", signature: "addendum" },
        { kind: "freeze_selections" },
        { kind: "set_timestamp", field: "addendum_signed_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m8.encounter.addendum_signed" },
      ]);
    }
  }
}
