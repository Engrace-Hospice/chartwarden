// apps/backend/src/modules/07-care-plan/lifecycle/version.ts — M7-T03 (§2.2.2).
//
// The care_plan_version lifecycle — the hybrid-versioning core: draft → in_review → signed →
// superseded, with `in_review → draft` (returned for edits) and the D8 integrity rule (any edit after
// the first signature returns the version to draft and clears prior signatures). The `draft → in_review`
// transition snapshots `state_snapshot` + `required_signer_set`; the last required signature flips the
// version to `signed` and emits `m7.care_plan.version_signed` (the system keys off this — M8 encounter
// gate, M22 PDF, M28 FHIR). Pure over already-resolved facts; the quorum math lives in
// `./required-signer-set`, the per-version → root promotion in `./care-plan`.
import type { CarePlanSignerRole, CarePlanVersionKind, IsoInstant, RequiredSignerSet } from "@wardenx/types";
import { CarePlanStateError, require_ } from "./errors";
import { type TransitionResult, result } from "./effects";
import { decideRecordSignature, resolveRequiredSignerSet } from "./required-signer-set";
import { checkInitialHasProblem } from "./validation";

/** The §2.2.2 version states (mirrors `care_plan_version_status`). */
export type CarePlanVersionState = "draft" | "in_review" | "signed" | "superseded";

/** The §2.2.2 version events. */
export type CarePlanVersionEvent =
  | {
      readonly type: "routeForSigning";
      readonly kind: CarePlanVersionKind;
      /** Count of active problems captured in the snapshot (≥1 required for the initial version, §2.3). */
      readonly activeProblemCount: number;
      /** A tenant may tighten the floor quorum (extra slots); never loosen — validated in M7-T05. */
      readonly requiredSignerSet?: RequiredSignerSet;
    }
  | {
      readonly type: "recordSignature";
      readonly signerRole: CarePlanSignerRole;
      readonly alreadySigned: ReadonlyArray<CarePlanSignerRole>;
      readonly requiredSignerSet: RequiredSignerSet;
      readonly signedAt: IsoInstant;
    }
  | { readonly type: "returnForEdits"; readonly hasSignatures: boolean }
  | { readonly type: "editAfterFirstSignature" }
  | { readonly type: "supersede" };

export type CarePlanVersionTransition = TransitionResult<CarePlanVersionState, CarePlanVersionEvent["type"]>;

/** The legal §2.2.2 transition graph (from → events accepted). Guards are checked separately. */
export const CARE_PLAN_VERSION_GRAPH: Readonly<
  Record<CarePlanVersionState, ReadonlyArray<CarePlanVersionEvent["type"]>>
> = {
  draft: ["routeForSigning"],
  in_review: ["recordSignature", "returnForEdits", "editAfterFirstSignature"],
  signed: ["supersede"],
  superseded: [],
};

/**
 * The `[*] → draft` factory: open a new version of any `kind` (§2.2.2). Emits
 * `m7.care_plan.version_drafted`; the snapshot + required_signer_set are captured later at the
 * `routeForSigning` (draft → in_review) transition, not at open.
 */
export function openCarePlanVersion(kind: CarePlanVersionKind): {
  readonly status: "draft";
  readonly kind: CarePlanVersionKind;
  readonly effects: CarePlanVersionTransition["effects"];
} {
  return {
    status: "draft",
    kind,
    effects: [
      { kind: "audit" },
      { kind: "outbox", event: "m7.care_plan.version_drafted" },
    ],
  };
}

/** Apply a care_plan_version event (§2.2.2). Throws `ILLEGAL_TRANSITION` if not accepted from `from`. */
export function transitionCarePlanVersion(
  from: CarePlanVersionState,
  event: CarePlanVersionEvent,
): CarePlanVersionTransition {
  if (!CARE_PLAN_VERSION_GRAPH[from].includes(event.type)) {
    throw new CarePlanStateError(
      "ILLEGAL_TRANSITION",
      `care-plan version cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "routeForSigning": {
      // Snapshot the plan + the (possibly tenant-tightened) Required Signer Set; an initial version
      // requires ≥1 problem (CoP 418.56(c)). The set defaults to the §11 D5 floor for the kind.
      if (event.kind === "initial") {
        checkInitialHasProblem(event.activeProblemCount);
      }
      const set = event.requiredSignerSet ?? resolveRequiredSignerSet(event.kind);
      return result(from, event.type, "in_review", [
        { kind: "snapshot", requiredSignerSet: set },
        { kind: "audit" },
      ]);
    }
    case "recordSignature": {
      // Validate the incoming signature against the unmet slots; the last one flips to `signed`.
      const decision = decideRecordSignature(event.requiredSignerSet, event.alreadySigned, event.signerRole);
      if (!decision.quorumMet) {
        return result(from, event.type, "in_review", [{ kind: "audit" }]);
      }
      return result(from, event.type, "signed", [
        { kind: "set_timestamp", field: "signed_at", at: event.signedAt },
        { kind: "audit" },
        { kind: "outbox", event: "m7.care_plan.version_signed" },
      ]);
    }
    case "returnForEdits": {
      // Any required signer may bounce the version back to draft; prior signatures are cleared.
      return result(from, event.type, "draft", [
        ...(event.hasSignatures ? ([{ kind: "clear_signatures" }] as CarePlanVersionTransition["effects"]) : []),
        { kind: "audit" },
      ]);
    }
    case "editAfterFirstSignature": {
      // D8 — editing the snapshot once a signature exists invalidates that signature: return to draft,
      // clear all collected signatures (the signers re-sign the corrected plan).
      return result(from, event.type, "draft", [
        { kind: "clear_signatures" },
        { kind: "audit" },
      ]);
    }
    case "supersede": {
      require_(from === "signed", "ILLEGAL_TRANSITION", "only a signed version can be superseded");
      return result(from, event.type, "superseded", [{ kind: "audit" }]);
    }
  }
}
